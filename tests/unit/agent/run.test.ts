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

// Mock EventStore so run.ts unit tests stay focused on the state machine
// and never touch the DB layer.
vi.mock('../../../src/agent/event-store', () => ({
  eventStore: {
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    replay: vi.fn().mockResolvedValue([]),
    release: vi.fn().mockResolvedValue(undefined),
  },
}));

const META = { projectId: 'p1', agentId: 'a1', skillId: 's1', stage: 'draft' };

/** Attach a minimal stub child onto a run, returning the kill spy. */
function stubChild(run: RunSession, killed: boolean) {
  const kill = vi.fn();
  run.child = { killed, kill } as unknown as NonNullable<RunSession['child']>;
  return kill;
}

describe('createRun', () => {
  it('initializes a fresh run: queued status, empty events, nextEventId 1, empty clients, null child', () => {
    const run = createRun(META);
    expect(run.status).toBe('queued');
    expect(run.events).toEqual([]);
    expect(run.nextEventId).toBe(1);
    expect(run.clients).toBeInstanceOf(Set);
    expect(run.clients.size).toBe(0);
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
  it('increments nextEventId monotonically and records id/event/data/timestamp', () => {
    const run = createRun(META);
    emitEvent(run, 'token', { v: 1 });
    emitEvent(run, 'token', { v: 2 });
    expect(run.nextEventId).toBe(3);
    expect(run.events).toHaveLength(2);
    expect(run.events[0]).toMatchObject({ id: 1, event: 'token', data: { v: 1 } });
    expect(run.events[1]).toMatchObject({ id: 2, event: 'token', data: { v: 2 } });
    expect(run.events[0].timestamp).toBeTypeOf('number');
  });

  it('advances updatedAt on each emit', async () => {
    const run = createRun(META);
    const before = run.updatedAt;
    // a tiny sync gap guarantees a strictly greater clock reading
    await new Promise((r) => setTimeout(r, 5));
    emitEvent(run, 'token', null);
    expect(run.updatedAt).toBeGreaterThan(before);
  });

  it('caps events at WINDOW_SIZE (200), retaining only the newest contiguous ids', () => {
    const run = createRun(META);
    const total = 300;
    for (let i = 0; i < total; i++) emitEvent(run, 'tick', i);
    expect(run.events).toHaveLength(200);
    const ids = run.events.map((e) => e.id);
    // last 200 ids are total-199 .. total (i.e. 101 .. 300), contiguous
    expect(ids[0]).toBe(total - 200 + 1);
    expect(ids[ids.length - 1]).toBe(total);
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1] + 1);
    // newest payload preserved
    expect(run.events[run.events.length - 1].data).toBe(total - 1);
  });

  it('notifies a subscribed client with (event, data, id)', () => {
    const run = createRun(META);
    const client = vi.fn();
    subscribeRun(run, client);
    emitEvent(run, 'token', { x: 9 });
    const emittedId = run.events[0].id;
    expect(client).toHaveBeenCalledTimes(1);
    expect(client).toHaveBeenCalledWith('token', { x: 9 }, emittedId);
  });

  it('does not notify a callback removed from clients', () => {
    const run = createRun(META);
    const client = vi.fn();
    subscribeRun(run, client);
    run.clients.delete(client);
    emitEvent(run, 'token', null);
    expect(client).not.toHaveBeenCalled();
  });
});

describe('finishRun', () => {
  it('transitions queued -> succeeded and emits end { status }', () => {
    const run = createRun(META);
    const client = vi.fn();
    subscribeRun(run, client);
    finishRun(run, 'succeeded');
    expect(run.status).toBe('succeeded');
    expect(client).toHaveBeenCalledWith('end', { status: 'succeeded' }, expect.any(Number));
  });

  it('transitions queued -> failed and emits end', () => {
    const run = createRun(META);
    finishRun(run, 'failed');
    expect(run.status).toBe('failed');
    expect(run.events[run.events.length - 1]).toMatchObject({
      event: 'end',
      data: { status: 'failed' },
    });
  });

  it('transitions queued -> canceled and emits end', () => {
    const run = createRun(META);
    finishRun(run, 'canceled');
    expect(run.status).toBe('canceled');
    expect(run.events[run.events.length - 1]).toMatchObject({
      event: 'end',
      data: { status: 'canceled' },
    });
  });

  it('is idempotent: repeated calls change status / emit end only once', () => {
    const run = createRun(META);
    const client = vi.fn();
    subscribeRun(run, client);
    finishRun(run, 'succeeded');
    finishRun(run, 'failed'); // no-op
    finishRun(run, 'canceled'); // no-op
    expect(run.status).toBe('succeeded');
    expect(client).toHaveBeenCalledTimes(1);
    expect(run.events.filter((e) => e.event === 'end')).toHaveLength(1);
  });

  it('resolves the finished promise exactly once', async () => {
    const run = createRun(META);
    const onFinished = vi.fn();
    run.finished.then(onFinished);
    finishRun(run, 'succeeded');
    finishRun(run, 'failed'); // must not re-resolve
    await run.finished;
    await Promise.resolve(); // drain trailing microtasks
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('clears clients so post-finish emits do not notify them', () => {
    const run = createRun(META);
    const client = vi.fn();
    subscribeRun(run, client);
    finishRun(run, 'succeeded');
    // client received the single 'end' during finishRun, then clients cleared
    expect(client).toHaveBeenCalledTimes(1);
    expect(run.clients.size).toBe(0);
    emitEvent(run, 'late', null);
    expect(client).toHaveBeenCalledTimes(1);
  });
});

describe('cancelRun', () => {
  it('finishes as canceled when there is no child', () => {
    const run = createRun(META);
    expect(run.child).toBeNull();
    cancelRun(run);
    expect(run.cancelRequested).toBe(true);
    expect(run.status).toBe('canceled');
    expect(run.events[run.events.length - 1]).toMatchObject({
      event: 'end',
      data: { status: 'canceled' },
    });
  });

  it('is a no-op on an already-terminal run: no SIGTERM, no status change', () => {
    const run = createRun(META);
    const kill = stubChild(run, false);
    finishRun(run, 'succeeded'); // make terminal
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
    // still non-terminal: final transition waits for the child close handler
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
  it('delivers a single emit to every subscribed client with the same id', () => {
    const run = createRun(META);
    const a = vi.fn();
    const b = vi.fn();
    subscribeRun(run, a);
    subscribeRun(run, b);
    emitEvent(run, 'token', { n: 1 });
    const id = run.events[0].id;
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith('token', { n: 1 }, id);
    expect(b).toHaveBeenCalledWith('token', { n: 1 }, id);
  });

  it('deduplicates an identical callback reference (clients is a Set)', () => {
    const run = createRun(META);
    const cb = vi.fn();
    subscribeRun(run, cb);
    subscribeRun(run, cb);
    expect(run.clients.size).toBe(1);
    emitEvent(run, 'token', null);
    expect(cb).toHaveBeenCalledTimes(1);
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
