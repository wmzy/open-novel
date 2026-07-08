import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { RunStream } from '../../../src/agent/run-stream';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { runEvents, runs as runsTable, conversations, projects, messages as msgsTable } from '../../../src/db/schema';

let dbReady = false;
async function ready() {
  if (!dbReady) { await ensureDbReady(); dbReady = true; }
}

describe('RunStream', () => {
  let projectId: string;
  let convId: string;
  let runId: string;

  beforeAll(ready);

  beforeEach(async () => {
    projectId = 'proj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    convId = 'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    runId = 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    await db.insert(projects).values({ id: projectId, title: 't', path: '/tmp/x' });
    await db.insert(conversations).values({ id: convId, projectId, agentId: 'claude', stage: 'drafting' });
    await db.insert(runsTable).values({ id: runId, conversationId: convId, agent: 'claude', status: 'running' });
  });

  afterEach(async () => {
    await db.delete(msgsTable).where(eq(msgsTable.conversationId, convId));
    await db.delete(runEvents).where(eq(runEvents.runId, runId));
    await db.delete(runsTable).where(eq(runsTable.id, runId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  it('push 写内存窗口 + 缓冲落盘；flush 后 DB 可见', async () => {
    const rs = new RunStream(runId, convId);
    rs.push('agent', { type: 'text_delta', delta: 'hello' });
    rs.push('agent', { type: 'text_delta', delta: ' world' });
    await rs.flush();

    const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq));
    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(1);
    expect(rows[1].seq).toBe(2);
    expect(rows[0].type).toBe('agent');
    expect(rows[0].data).toEqual({ type: 'text_delta', delta: 'hello' });
  });

  it('subscribe 重放历史（fromSeq 之后）+ 实时推送新事件', async () => {
    const rs = new RunStream(runId, convId);
    rs.push('agent', { type: 'text_delta', delta: 'old' });
    await rs.flush();

    const received: Array<{ event: string; data: unknown; id: number }> = [];
    const unsub = rs.subscribe(0, (event, data, id) => received.push({ event, data, id }));

    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ type: 'text_delta', delta: 'old' });

    rs.push('agent', { type: 'text_delta', delta: 'new' });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(2);
    expect(received[1].data).toEqual({ type: 'text_delta', delta: 'new' });

    unsub();
  });

  it('subscribe 的 fromSeq 跳过已收到的事件', async () => {
    const rs = new RunStream(runId, convId);
    rs.push('agent', { n: 1 });
    rs.push('agent', { n: 2 });
    rs.push('agent', { n: 3 });
    await rs.flush();

    const received: number[] = [];
    const unsub = rs.subscribe(2, (_e, data, _id) => received.push((data as { n: number }).n));
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([3]);
    unsub();
  });

  it('unsubscribe 后不再收到事件', async () => {
    const rs = new RunStream(runId, convId);
    const received: unknown[] = [];
    const unsub = rs.subscribe(0, (_e, data) => received.push(data));
    rs.push('agent', { a: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);

    unsub();
    rs.push('agent', { a: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
  });

  it('auto-flush 当缓冲达到阈值（50 条）', async () => {
    const rs = new RunStream(runId, convId);
    for (let i = 0; i < 50; i++) rs.push('tick', { n: i });
    await new Promise((r) => setTimeout(r, 150));
    await rs.flush();

    const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
    expect(rows).toHaveLength(50);
  });

  // --- Task 2: close 固化 messages ---

  it('close 聚合 agent 事件为整条消息写入 messages 表', async () => {
    const rs = new RunStream(runId, convId);
    rs.push('agent', { type: 'text_delta', delta: '你好' });
    rs.push('agent', { type: 'text_delta', delta: '世界' });
    rs.push('agent', { type: 'tool_use', id: 't1', name: 'Read', input: {} });

    await rs.close(
      (events) => {
        const text = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
        return { content: text, events: events.map(() => ({ kind: 'text', text: 'x' })) };
      },
      { failed: false },
    );

    const rows = await db.select().from(msgsTable).where(eq(msgsTable.conversationId, convId));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('assistant');
    expect(rows[0].content).toBe('你好世界');
  });

  it('close 失败标记时 content 加 [执行异常] 前缀', async () => {
    const rs = new RunStream(runId, convId);
    rs.push('agent', { type: 'text_delta', delta: '部分输出' });

    await rs.close(
      (events) => {
        const text = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
        return { content: text, events: [] };
      },
      { failed: true, failLabel: 'refusal' },
    );

    const rows = await db.select().from(msgsTable).where(eq(msgsTable.conversationId, convId));
    expect(rows[0].content).toBe('[执行异常(refusal)] 部分输出');
  });

  it('close 后 isClosed 为 true，push 不再生效', async () => {
    const rs = new RunStream(runId, convId);
    rs.push('agent', { type: 'text_delta', delta: 'x' });
    await rs.close((events) => ({ content: events.map((e) => e.delta || '').join(''), events: [] }), {});

    expect(rs.isClosed).toBe(true);
    const before = rs.currentSeq;
    rs.push('agent', { type: 'text_delta', delta: 'y' });
    expect(rs.currentSeq).toBe(before);
  });

  it('close 后 subscribe 仍可重放全部历史', async () => {
    const rs = new RunStream(runId, convId);
    rs.push('agent', { type: 'text_delta', delta: '历史1' });
    rs.push('agent', { type: 'text_delta', delta: '历史2' });
    await rs.close((events) => ({ content: '', events: [] }), {});

    const received: string[] = [];
    rs.subscribe(0, (_e, data) => received.push((data as { delta?: string }).delta || ''));
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual(['历史1', '历史2']);
  });
});
