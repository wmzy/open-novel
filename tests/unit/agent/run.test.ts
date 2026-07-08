import { describe, it, expect, vi } from 'vitest';
import {
  createRun,
  getRun,
  emitEvent,
  finishRun,
  cancelRun,
  subscribeRun,
  registerAsk,
  resolveAsk,
} from '../../../src/agent/run';
import type { RunSession } from '../../../src/agent/run';

// Mock DB so RunStream's persistence layer doesn't interfere with state-machine tests.
// run-stream.test.ts covers DB integration.
vi.mock('../../../src/db/drizzle', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ orderBy: vi.fn().mockResolvedValue([]) })) })) })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  ensureDbReady: vi.fn().mockResolvedValue(undefined),
}));

const META = { projectId: 'p1', agentId: 'a1', skillId: 's1', stage: 'draft', conversationId: 'c1' };

/** Attach a minimal stub child onto a run, returning the kill spy. */
function stubChild(run: RunSession, killed: boolean) {
  const kill = vi.fn();
  run.child = { killed, kill } as unknown as NonNullable<RunSession['child']>;
  return kill;
}

describe('createRun', () => {
  it('initializes a fresh run: queued status, stream ready, null child', () => {
    const run = createRun(META);
    expect(run.status).toBe('queued');
    expect(run.stream).toBeDefined();
    expect(run.stream.currentSeq).toBe(1);
    expect(run.stream.isClosed).toBe(false);
    expect(run.child).toBeNull();
    expect(run.error).toBeNull();
    expect(run.cancelRequested).toBe(false);
    expect(run.createdAt).toBeTypeOf('number');
    expect(run.updatedAt).toBeTypeOf('number');
    expect(run.finished).toBeInstanceOf(Promise);
  });

  it('registers the run so getRun retrieves it by id', () => {
    const run = createRun(META);
    expect(getRun(run.id)).toBe(run);
  });

  it('returns null from getRun for an unknown id', () => {
    expect(getRun('definitely-not-a-real-run-id')).toBeNull();
  });

  it('assigns a unique id per run', () => {
    const a = createRun(META);
    const b = createRun(META);
    expect(a.id).not.toBe(b.id);
  });
});

describe('emitEvent', () => {
  it('increments currentSeq monotonically and notifies subscribers', () => {
    const run = createRun(META);
    const received: Array<{ event: string; data: unknown; id: number }> = [];
    subscribeRun(run, 0, (event, data, id) => received.push({ event, data, id }));
    // wait for async replay to settle (no history → empty)
    return new Promise<void>((resolve) => setTimeout(resolve, 30)).then(() => {
      emitEvent(run, 'token', { v: 1 });
      emitEvent(run, 'token', { v: 2 });
      expect(run.stream.currentSeq).toBe(3);
      // filter out replay (empty) — only fan-out events
      const fanout = received.filter((r) => r.event === 'token');
      expect(fanout).toHaveLength(2);
      expect(fanout[0]).toMatchObject({ event: 'token', data: { v: 1 }, id: 1 });
      expect(fanout[1]).toMatchObject({ event: 'token', data: { v: 2 }, id: 2 });
    });
  });

  it('advances updatedAt on each emit', async () => {
    const run = createRun(META);
    const before = run.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    emitEvent(run, 'token', null);
    expect(run.updatedAt).toBeGreaterThan(before);
  });

  it('notifies a subscribed client with (event, data, id)', async () => {
    const run = createRun(META);
    const client = vi.fn();
    subscribeRun(run, 0, client);
    await new Promise((r) => setTimeout(r, 30)); // let replay settle
    emitEvent(run, 'token', { x: 9 });
    expect(client).toHaveBeenCalledWith('token', { x: 9 }, expect.any(Number));
  });

  it('does not notify an unsubscribed callback', async () => {
    const run = createRun(META);
    const client = vi.fn();
    const unsub = subscribeRun(run, 0, client);
    await new Promise((r) => setTimeout(r, 30));
    unsub();
    emitEvent(run, 'token', null);
    // client should have 0 calls (replay empty, unsubscribed before emit)
    expect(client).not.toHaveBeenCalled();
  });
});

describe('finishRun', () => {
  it('transitions queued -> succeeded and emits end { status }', async () => {
    const run = createRun(META);
    const client = vi.fn();
    subscribeRun(run, 0, client);
    await new Promise((r) => setTimeout(r, 30));
    finishRun(run, 'succeeded');
    expect(run.status).toBe('succeeded');
    expect(client).toHaveBeenCalledWith('end', { status: 'succeeded' }, expect.any(Number));
  });

  it('is idempotent: repeated calls change status / emit end only once', async () => {
    const run = createRun(META);
    const client = vi.fn();
    subscribeRun(run, 0, client);
    await new Promise((r) => setTimeout(r, 30));
    finishRun(run, 'succeeded');
    finishRun(run, 'failed'); // no-op
    finishRun(run, 'canceled'); // no-op
    expect(run.status).toBe('succeeded');
    const endCalls = client.mock.calls.filter((c) => c[0] === 'end');
    expect(endCalls).toHaveLength(1);
  });

  it('resolves the finished promise exactly once', async () => {
    const run = createRun(META);
    const onFinished = vi.fn();
    run.finished.then(onFinished);
    finishRun(run, 'succeeded');
    finishRun(run, 'failed'); // must not re-resolve
    await run.finished;
    await Promise.resolve();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});

describe('cancelRun', () => {
  it('finishes as canceled when there is no child', () => {
    const run = createRun(META);
    expect(run.child).toBeNull();
    cancelRun(run);
    expect(run.cancelRequested).toBe(true);
    expect(run.status).toBe('canceled');
  });

  it('is a no-op on an already-terminal run: no SIGTERM, no status change', () => {
    const run = createRun(META);
    const kill = stubChild(run, false);
    finishRun(run, 'succeeded');
    cancelRun(run);
    expect(run.status).toBe('succeeded');
    expect(kill).not.toHaveBeenCalled();
  });

  it('marks cancelRequested, sends SIGTERM, and leaves status non-terminal when child exists', () => {
    const run = createRun(META);
    const kill = stubChild(run, false);
    cancelRun(run);
    expect(run.cancelRequested).toBe(true);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(run.status).toBe('queued');
  });

  it('falls back to finishRun(canceled) when the child is already killed', () => {
    const run = createRun(META);
    const kill = stubChild(run, true);
    cancelRun(run);
    expect(kill).not.toHaveBeenCalled();
    expect(run.status).toBe('canceled');
  });
});

describe('subscribeRun', () => {
  it('delivers a single emit to every subscribed client with the same id', async () => {
    const run = createRun(META);
    const a = vi.fn();
    const b = vi.fn();
    subscribeRun(run, 0, a);
    subscribeRun(run, 0, b);
    await new Promise((r) => setTimeout(r, 30));
    emitEvent(run, 'token', { n: 1 });
    const aToken = a.mock.calls.find((c) => c[0] === 'token');
    const bToken = b.mock.calls.find((c) => c[0] === 'token');
    expect(aToken).toBeTruthy();
    expect(bToken).toBeTruthy();
    expect(aToken![1]).toEqual({ n: 1 });
    expect(bToken![1]).toEqual({ n: 1 });
    expect(aToken![2]).toBe(bToken![2]); // same id
  });
});

describe('registerAsk / resolveAsk', () => {
  it('registerAsk 返回 promise，resolveAsk 唤醒后 resolve', async () => {
    const run = createRun(META);
    const promise = registerAsk(run, 'ask_1');
    expect(run._pendingAsks.has('ask_1')).toBe(true);

    const ok = resolveAsk(run, 'ask_1', { action: 'accept', content: { value: '是的' } });
    expect(ok).toBe(true);
    expect(run._pendingAsks.has('ask_1')).toBe(false);

    const response = await promise;
    expect(response.action).toBe('accept');
    expect(response.content).toEqual({ value: '是的' });
  });

  it('resolveAsk 对不存在的 askId 返回 false', () => {
    const run = createRun(META);
    const ok = resolveAsk(run, 'nope', { action: 'cancel' });
    expect(ok).toBe(false);
  });

  it('cancel action 也应唤醒 promise', async () => {
    const run = createRun(META);
    const promise = registerAsk(run, 'ask_c');
    resolveAsk(run, 'ask_c', { action: 'cancel' });
    const response = await promise;
    expect(response.action).toBe('cancel');
    expect(response.content).toBeUndefined();
  });

  it('多个 ask 可并行挂起，各自独立 resolve', async () => {
    const run = createRun(META);
    const p1 = registerAsk(run, 'a1');
    const p2 = registerAsk(run, 'a2');
    resolveAsk(run, 'a2', { action: 'accept', content: { value: 2 } });
    resolveAsk(run, 'a1', { action: 'accept', content: { value: 1 } });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect((r1.content as { value: number }).value).toBe(1);
    expect((r2.content as { value: number }).value).toBe(2);
  });
});
