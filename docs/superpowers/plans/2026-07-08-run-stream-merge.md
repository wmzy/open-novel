# RunStream 合并实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 合并 eventStore + run.clients 订阅 + close 时消息持久化为单一 `RunStream` 流对象，新增 conversation 级 SSE 端点供前端订阅，消除"刷新后响应消失"的 bug。

**Architecture:** `RunStream` 吸收 eventStore 的缓冲落盘、run.clients 的实时推送、close handler 的消息固化三职责，成为事件流唯一写入源与读取源。前端通过新的 `GET /api/conversations/:id/stream` 订阅 conversation 级流——它缝合历史 messages 表与活跃 RunStream 事件，前端不再关注 run。

**Tech Stack:** TypeScript, Hono (stream), Drizzle ORM + PGlite, React 19, Vitest

---

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/agent/run-stream.ts` | **新建** | RunStream 类：push(内存窗口+缓冲落盘+fan-out) / subscribe(重放+实时) / close(固化 messages+释放) |
| `src/agent/event-store.ts` | **删除** | 职责并入 RunStream |
| `src/agent/incremental-message.ts` | **删除** | 撤掉之前的错误修复 |
| `src/agent/run.ts` | **修改** | RunSession 持有 runStream；emitEvent/subscribeRun 委托 runStream；移除 run.events 内存窗口与 clients |
| `src/agent/run-registry.ts` | **新建** | 全局 RunStream 注册表：getStream(runId)、getActiveStreamForConversation(convId)，供端点查询 |
| `src/api/routes/runs.ts` | **修改** | close handler 消息固化移入 RunStream.close；GET events 改用 runStream.subscribe；新增 GET /conversations/:id/stream；撤 IncrementalAssistantMessage 接入 |
| `src/api/routes/rewrite.ts` | **修改** | eventStore.replay → run.stream.replay；适配新接口 |
| `src/web/hooks/useRun.ts` | **修改** | 撤轮询；mount + sendMessage 改订阅 conversation 流 |
| `tests/unit/agent/run-stream.test.ts` | **新建** | RunStream 单元测试 |
| `tests/unit/agent/event-store.test.ts` | **删除** | 迁移为 run-stream 测试 |
| `tests/unit/agent/incremental-message.test.ts` | **删除** | 撤掉错误修复测试 |
| `tests/unit/web/use-run.test.tsx` | **修改** | 适配 conversation 流；删轮询测试 |

---

## Task 1: RunStream 核心（push + subscribe + 落盘）

**Files:**
- Create: `src/agent/run-stream.ts`
- Create: `tests/unit/agent/run-stream.test.ts`

RunStream 吸收 eventStore 的缓冲落盘与 run.clients 的实时推送。本任务只实现 push + subscribe + 落盘，不做 close 固化（Task 3）。

- [ ] **Step 1: 写失败测试（push 落盘 + subscribe 重放）**

Create `tests/unit/agent/run-stream.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq, asc } from 'drizzle-orm';
import { RunStream } from '../../../src/agent/run-stream';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { runEvents, runs as runsTable, conversations, projects } from '../../../src/db/schema';

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
    projectId = 'proj_rs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    convId = 'conv_rs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    runId = 'run_rs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    await db.insert(projects).values({ id: projectId, title: 't', path: '/tmp/x' });
    await db.insert(conversations).values({ id: convId, projectId, agentId: 'claude', stage: 'drafting' });
    await db.insert(runsTable).values({ id: runId, conversationId: convId, agent: 'claude', status: 'running' });
  });

  afterEach(async () => {
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

    // 重放历史（seq 1）
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ type: 'text_delta', delta: 'old' });

    // 实时推送（seq 2）
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/run-stream.test.ts`
Expected: FAIL — `Cannot find module '../../../src/agent/run-stream'`

- [ ] **Step 3: 实现 RunStream（push + subscribe + 落盘）**

Create `src/agent/run-stream.ts`:

```typescript
import { and, eq, gt, asc } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { runEvents, messages } from '../db/schema';
import { generateId } from '../utils/id';

/** 与窗口事件同构的记录。 */
export interface RunEventRecord {
  id: number;
  event: string;
  data: unknown;
  timestamp: number;
}

/** 攒够多少条就落盘一次。 */
const FLUSH_THRESHOLD = 50;
/** 即便条数不够，最多间隔多久落盘一次。 */
const FLUSH_INTERVAL_MS = 500;

interface BufferedEvent {
  seq: number;
  type: string;
  data: unknown;
}

type Subscriber = (event: string, data: unknown, id: number) => void;

/**
 * RunStream — run 事件流的统一流对象，合并 eventStore（缓冲落盘）+
 * run.clients（实时推送）+ close 时消息固化三职责。
 *
 * 流生命周期 = 一个 run = 一次 agent 输出。agent 输出期间持续接收事件、
 * 推送订阅者；agent 结束时 close() 固化整条消息到 messages 表。
 *
 * text_delta 等事件只进 RunStream，再无第二个写入点。
 */
export class RunStream {
  readonly runId: string;
  readonly conversationId: string;

  /** 内存滑动窗口（实时推送 + close 重放用）。 */
  private window: RunEventRecord[] = [];
  private nextSeq = 1;
  /** 落盘缓冲。 */
  private pending: BufferedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 实时订阅者。 */
  private subscribers = new Set<Subscriber>();
  private closed = false;

  constructor(runId: string, conversationId: string) {
    this.runId = runId;
    this.conversationId = conversationId;
  }

  /** 是否已关闭（agent 输出结束）。 */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 写入一条事件：分配 seq → 内存窗口 → 落盘缓冲 → fan-out 订阅者。
   * 语义同原 emitEvent + eventStore.append 合并。
   */
  push(event: string, data: unknown): number {
    const id = this.nextSeq++;
    const record: RunEventRecord = { id, event, data, timestamp: Date.now() };
    this.window.push(record);
    if (this.window.length > 200) this.window.splice(0, this.window.length - 200);

    this.pending.push({ seq: id, type: event, data });
    if (this.pending.length >= FLUSH_THRESHOLD) {
      this.doFlush().catch(() => {});
    } else if (!this.timer) {
      this.timer = setTimeout(() => { this.doFlush().catch(() => {}); }, FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }

    for (const cb of this.subscribers) cb(event, data, id);
    return id;
  }

  /**
   * 订阅事件流：先重放 fromSeq 之后的历史（DB + 内存窗口合并去重），
   * 再接收实时事件。返回取消订阅函数。
   */
  subscribe(fromSeq: number, cb: Subscriber): () => void {
    this.subscribers.add(cb);
    // 异步重放历史，不阻塞调用方
    this.replay(fromSeq).then((records) => {
      for (const r of records) cb(r.event, r.data, r.id);
    }).catch(() => {});
    return () => { this.subscribers.delete(cb); };
  }

  /** 立即落盘缓冲（不关闭流）。 */
  async flush(): Promise<void> {
    await this.doFlush();
  }

  /**
   * 回放 seq > afterSeq 的事件，合并 DB（已落盘）与内存窗口（含未 flush），
   * 按 seq 升序去重，内存窗口中的同 seq 优先。
   */
  async replay(afterSeq: number): Promise<RunEventRecord[]> {
    const fromDb = await db.select().from(runEvents)
      .where(and(eq(runEvents.runId, this.runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq));
    const map = new Map<number, RunEventRecord>();
    for (const r of fromDb) {
      map.set(r.seq, { id: r.seq, event: r.type, data: r.data, timestamp: new Date(r.createdAt).getTime() });
    }
    for (const e of this.window) {
      if (e.id > afterSeq) map.set(e.id, e);
    }
    return [...map.values()].sort((a, b) => a.id - b.id);
  }

  /**
   * 关闭流：固化整条 assistant 消息到 messages 表，释放内存。
   * 在 close 前 push 的全部事件（含 errors）都参与聚合。
   */
  async close(transform: (events: Record<string, unknown>[]) => { content: string; events: unknown[] }, options: { failed?: boolean; failLabel?: string; artifacts?: { count: number; paths: string[] } | null }): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.doFlush();
    const all = await this.replay(0);
    const agentEvents = all.filter((e) => e.event === 'agent').map((e) => e.data as Record<string, unknown>);
    const { content, events } = transform(agentEvents);
    if (content || events.length > 0) {
      const finalContent = options.failed
        ? `[执行异常${options.failLabel ? `(${options.failLabel})` : ''}] ${content || '(无文本输出)'}`
        : content || '(无文本输出)';
      await db.insert(messages).values({
        id: generateId('msg_'),
        conversationId: this.conversationId,
        role: 'assistant',
        content: finalContent,
        events,
        artifacts: options.artifacts ?? null,
      }).catch(() => {});
    }
    this.subscribers.clear();
    this.window = [];
  }

  /** 落盘缓冲的内部实现。 */
  private async doFlush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const buf = this.pending;
    if (buf.length === 0) return;
    this.pending = [];
    try {
      await db.insert(runEvents).values(
        buf.map((e) => ({ id: generateId('rev_'), runId: this.runId, seq: e.seq, type: e.type, data: e.data })),
      );
    } catch (err) {
      console.error('[run-stream] flush failed for run', this.runId, err);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/run-stream.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/agent/run-stream.ts tests/unit/agent/run-stream.test.ts && git commit -m "feat: RunStream 核心（push/subscribe/落盘），合并 eventStore 职责"
```

---

## Task 2: RunStream.close 固化 messages

**Files:**
- Modify: `tests/unit/agent/run-stream.test.ts`（追加 close 测试）

close() 在 agent 输出结束时固化整条消息到 messages 表。它接收一个 `transform` 函数（即 runs.ts 现有的 `transformStreamEvents`）和失败标记，内部完成聚合 + 写入。

- [ ] **Step 1: 追加失败测试到 `tests/unit/agent/run-stream.test.ts`**

在最后一个 `it(...)` 之后、`});` 闭合 describe 之前追加：

```typescript
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

    const { messages: msgsTable } = await import('../../../src/db/schema');
    const rows = await db.select().from(msgsTable).where(eq(msgsTable.conversationId, convId));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('assistant');
    expect(rows[0].content).toBe('你好世界');
    rs.flush();
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

    const { messages: msgsTable } = await import('../../../src/db/schema');
    const rows = await db.select().from(msgsTable).where(eq(msgsTable.conversationId, convId));
    expect(rows[0].content).toBe('[执行异常(refusal)] 部分输出');
  });

  it('close 后 isClosed 为 true，push 不再生效', async () => {
    const rs = new RunStream(runId, convId);
    rs.push('agent', { type: 'text_delta', delta: 'x' });
    await rs.close((events) => ({ content: events.map((e) => e.delta || '').join(''), events: [] }), {});

    expect(rs.isClosed).toBe(true);
    const before = rs.nextSeq;
    rs.push('agent', { type: 'text_delta', delta: 'y' });
    expect(rs.nextSeq).toBe(before); // closed 后 push 不分配新 seq
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
```

同时修改 `push` 的签名返回值不变；在 Step 3 实现中 `close` 已置 `closed = true`。但测试 "close 后 push 不再生效" 要求 push 在 closed 时早返回。需修改 RunStream.push。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/run-stream.test.ts`
Expected: 3 个新测试 FAIL（close 幂等性 / push 早返回未实现）——前两个 close 测试会通过（close 已在 Task 1 实现），但 "push 不再生效" 和幂等性细节会暴露需要 push 早返回。

- [ ] **Step 3: 修改 RunStream.push 增加 closed 守卫**

在 `src/agent/run-stream.ts` 的 `push` 方法开头加：

```typescript
  push(event: string, data: unknown): number {
    if (this.closed) return this.nextSeq; // 流已关闭，丢弃
    // ... 其余不变
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/run-stream.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/agent/run-stream.ts tests/unit/agent/run-stream.test.ts && git commit -m "feat: RunStream.close 固化 messages + closed 守卫"
```

---

## Task 3: RunSession 持有 RunStream；run.ts 委托

**Files:**
- Modify: `src/agent/run.ts`
- Modify: `tests/unit/agent/run.test.ts`（验证 run.stream 存在）

RunSession 不再维护 `events` 内存窗口和 `clients` 集合，改为持有 `stream: RunStream`。`emitEvent` / `subscribeRun` 委托 stream。

- [ ] **Step 1: 读取现有 run.test.ts 确认测试内容**

Run: `cd ~/projects/open-novel && head -40 tests/unit/agent/run.test.ts`

- [ ] **Step 2: 修改 `src/agent/run.ts`**

用以下完整内容替换 `src/agent/run.ts`（保留 registerAsk/resolveAsk/createRun/getRun/finishRun/cancelRun 逻辑，events/clients/emitEvent/subscribeRun 改为委托 RunStream）：

```typescript
import { randomUUID } from 'node:crypto';
import { RunStream } from './run-stream';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface RunSession {
  id: string;
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
  status: RunStatus;
  stream: RunStream;
  child: ReturnType<typeof import('node:child_process').spawn> | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  cancelRequested: boolean;
  finished: Promise<void>;
  _finishResolve: () => void;
  _pendingAsks: Map<string, (response: { action: 'accept' | 'cancel'; content?: unknown }) => void>;
}

const runs = new Map<string, RunSession>();

export function createRun(meta: { projectId: string; agentId: string; skillId: string; stage: string; conversationId: string }): RunSession {
  let finishResolve: () => void;
  const finished = new Promise<void>((resolve) => { finishResolve = resolve; });
  const id = randomUUID();
  const run: RunSession = {
    id,
    projectId: meta.projectId,
    agentId: meta.agentId,
    skillId: meta.skillId,
    stage: meta.stage,
    status: 'queued',
    stream: new RunStream(id, meta.conversationId),
    child: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
    cancelRequested: false,
    finished,
    _finishResolve: finishResolve!,
    _pendingAsks: new Map(),
  };
  runs.set(id, run);
  return run;
}

export function getRun(id: string): RunSession | null {
  return runs.get(id) ?? null;
}

export function emitEvent(run: RunSession, event: string, data: unknown) {
  run.stream.push(event, data);
  run.updatedAt = Date.now();
}

export function finishRun(run: RunSession, status: RunStatus) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.status = status;
  run.updatedAt = Date.now();
  emitEvent(run, 'end', { status });
  run._finishResolve();
  // 30 分钟后清理 RunSession；RunStream 的落盘由 close() 在调用方完成。
  setTimeout(() => runs.delete(run.id), 30 * 60 * 1000).unref?.();
}

export function cancelRun(run: RunSession) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.cancelRequested = true;
  if (run.child && !run.child.killed) {
    run.child.kill('SIGTERM');
  } else {
    finishRun(run, 'canceled');
  }
}

export function registerAsk(
  run: RunSession,
  askId: string,
): Promise<{ action: 'accept' | 'cancel'; content?: unknown }> {
  return new Promise((resolve) => {
    run._pendingAsks.set(askId, resolve);
  });
}

export function resolveAsk(
  run: RunSession,
  askId: string,
  response: { action: 'accept' | 'cancel'; content?: unknown },
): boolean {
  const resolver = run._pendingAsks.get(askId);
  if (!resolver) return false;
  run._pendingAsks.delete(askId);
  resolver(response);
  return true;
}

export function subscribeRun(run: RunSession, fromSeq: number, send: (event: string, data: unknown, id: number) => void): () => void {
  return run.stream.subscribe(fromSeq, send);
}
```

**关键变化：**
1. `createRun` 新增 `conversationId` 参数（RunStream 构造需要）
2. `emitEvent` 委托 `run.stream.push`，不再维护 `run.events` / `run.clients`
3. `subscribeRun` 委托 `run.stream.subscribe`，签名变为 `(run, fromSeq, send)` 返回 unsubscribe
4. `finishRun` 不再 `run.clients.clear()`（RunStream.close 在调用方做）；不再 `eventStore.release`

- [ ] **Step 3: 修复 createRun 所有调用点（新增 conversationId 参数）**

搜索调用点：
Run: `cd ~/projects/open-novel && grep -rn "createRun(" src/`

需要修改的文件：
- `src/api/routes/runs.ts` — `createRun({ projectId, agentId, skillId, stage })` → `createRun({ projectId, agentId, skillId, stage, conversationId: convId })`
- `src/api/routes/rewrite.ts` — rewrite 不绑对话。需先创建/传入 conversationId，或给 RunStream 一个独立的占位 convId。

对 `src/api/routes/rewrite.ts`，重写不持久化消息（用完即弃）。给 RunStream 传一个占位 conversationId：

修改 `src/api/routes/rewrite.ts` 中 `createRun` 调用：
```typescript
// 重写不绑对话，用占位 conversationId（RunStream 需要，但重写不固化消息）
const run = createRun({ projectId, agentId: agentId!, skillId: skillId || 'rewrite', stage: 'rewrite', conversationId: `rewrite_${Date.now()}` });
```

对 `src/api/routes/runs.ts`，修改 `launchAndTrack` 中 `createRun` 调用（约第 296 行附近）：
```typescript
const run = createRun({ projectId, agentId, skillId, stage, conversationId: convId });
```

- [ ] **Step 4: typecheck 确认编译**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | grep -v mermaid-diagram | head -20`
Expected: 无新错误（mermaid-diagram 错误是 pre-existing，忽略）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/agent/run.ts src/api/routes/runs.ts src/api/routes/rewrite.ts && git commit -m "refactor: RunSession 持有 RunStream，emitEvent/subscribeRun 委托"
```

---

## Task 4: 删除 eventStore 和 IncrementalAssistantMessage

**Files:**
- Delete: `src/agent/event-store.ts`
- Delete: `src/agent/incremental-message.ts`
- Delete: `tests/unit/agent/event-store.test.ts`
- Delete: `tests/unit/agent/incremental-message.test.ts`
- Modify: 所有 import eventStore 的文件

- [ ] **Step 1: 查找所有 eventStore / IncrementalAssistantMessage import**

Run: `cd ~/projects/open-novel && grep -rn "event-store\|eventStore\|incremental-message\|IncrementalAssistantMessage" src/ tests/`

- [ ] **Step 2: 修改 `src/api/routes/runs.ts`**

1. 删除 import：`import { eventStore } from '../../agent/event-store';`
2. 删除 import：`import { IncrementalAssistantMessage } from '../../agent/incremental-message';`
3. 删除 `const incremental = new IncrementalAssistantMessage(convId);`（约第 283 行）
4. 删除 `emitWithWatchdog` 内的 `incremental.onTextDelta(event.delta);`（约第 353 行）
5. 删除 `child.on('error')` 内的 `incremental.dispose();`
6. 删除 close handler 内的 `incremental.flush();` 和整段 `if (incremental.messageId) {...} else {...}` 消息持久化块，替换为 RunStream.close 调用（见 Step 3）

- [ ] **Step 3: 改造 close handler 消息持久化为 RunStream.close**

在 close handler 中，把现有的"读取事件 + transformStreamEvents + insert/update messages"整段替换为：

找到 close handler 内这段（约第 438-495 行）：
```typescript
    // 从 eventStore（DB 完整存储）读取全部事件...
    await eventStore.flush(run.id);
    const allEvents = await eventStore.replay(run.id, 0, run.events);
    const agentEvents = allEvents
      .filter((e) => e.event === 'agent')
      .map((e) => e.data as Record<string, unknown>);
    const writtenPaths = collectWrittenPaths(agentEvents);
    // ... artifacts emit ...
    // ... incremental.flush + 消息持久化整段 ...
```

替换为（注意：`writtenPaths` 仍需从事件提取，先 replay 取 agentEvents 算 writtenPaths，再 close 固化）：

```typescript
    // 从 RunStream 读取全部事件，提取写入路径 + emit artifacts
    await run.stream.flush();
    const allEvents = await run.stream.replay(0);
    const agentEvents = allEvents
      .filter((e) => e.event === 'agent')
      .map((e) => e.data as Record<string, unknown>);
    const writtenPaths = collectWrittenPaths(agentEvents);

    if (writtenPaths.size > 0) {
      emitEvent(run, 'artifacts', { count: writtenPaths.size, paths: [...writtenPaths] });
    }

    // 固化 assistant 消息到 messages 表（RunStream.close 内部完成聚合 + 写入）
    const failed = code !== 0;
    await run.stream.close(transformStreamEvents, {
      failed,
      failLabel: acpStopReason || undefined,
      artifacts: writtenPaths.size > 0 ? { count: writtenPaths.size, paths: [...writtenPaths] } : null,
    });
```

- [ ] **Step 4: 修改 retry 逻辑（移除 incremental.resetForRetry）**

在 close handler 的 retry 分支中，删除 `incremental.resetForRetry();`（约第 560 行）。重试时旧 RunStream 已 close，新 attempt 的 createRun 会创建新 RunStream——但当前架构重试复用同一 RunSession。

**关键决策**：重试（零产出自动重试）需要新 RunStream。修改 `launchAndTrack` 使其在重试时重建 stream。由于 `createRun` 只在首次调用，重试时需重建：

在 `launchAndTrack` 顶部（约第 296 行后），把 `const run = createRun(...)` 改为：

```typescript
  async function launchAndTrack(retryOf: string | null): Promise<RunSession> {
    if (!def) throw new Error('Agent definition missing');
    const run = createRun({ projectId, agentId, skillId, stage, conversationId: convId });
    run.status = 'running';
```

这样每次 launchAndTrack 都创建新 run + 新 RunStream。重试时旧 run 的事件流自然结束，新 run 接管。需确认前端通过 conversation 流而非 runId 订阅——Task 7 会处理。**同时删除 retry 分支里的 `return;` 前的旧逻辑**，改为正常 finishRun 旧 run 后由新 run 接管。

实际上更简单的做法：retry 时 finishRun 旧 run（状态 failed/succeeded 不影响），新 run 独立。修改 retry 分支：

```typescript
    if (code === 0 && writtenPaths.size === 0 && stage === 'writing' && retryOf === null) {
      emitEvent(run, 'agent', { type: 'info', message: 'Agent 未产出任何文件，正在自动重试…', retry: true });
      // 短暂延迟后重试（新 run + 新 RunStream 接管事件流）
      setTimeout(() => { void launchAndTrack(run.id); }, 2000);
      // 旧 run 正常结束（不 return），走下面的 finishRun
    }

    finishRun(run, code === 0 ? 'succeeded' : 'failed');
```

- [ ] **Step 5: 修改 `src/api/routes/rewrite.ts`**

删除 `import { eventStore } from '../../agent/event-store';`。

rewrite 的 close handler 用 `run.stream.replay(0)` 替换 `eventStore.replay`：

把：
```typescript
    await eventStore.flush(run.id);
    const allEvents = await eventStore.replay(run.id, 0, run.events);
```
改为：
```typescript
    await run.stream.flush();
    const allEvents = await run.stream.replay(0);
```

- [ ] **Step 6: 删除文件**

```bash
cd ~/projects/open-novel && rm src/agent/event-store.ts src/agent/incremental-message.ts tests/unit/agent/event-store.test.ts tests/unit/agent/incremental-message.test.ts
```

- [ ] **Step 7: typecheck + 运行全量测试确认无残留引用**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | grep -v mermaid-diagram | head -20`
Expected: 无新错误

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/ 2>&1 | tail -10`
Expected: run-stream 测试通过，无残留 event-store 测试

- [ ] **Step 8: Commit**

```bash
cd ~/projects/open-novel && git add -A && git commit -m "refactor: 删除 eventStore/incremental-message，职责并入 RunStream"
```

---

## Task 5: 修改 GET /:id/events 端点适配 RunStream

**Files:**
- Modify: `src/api/routes/runs.ts:581-630`（GET events 端点）

现有端点用 `eventStore.replay` + `subscribeRun` + `run.events`，改为 `run.stream.subscribe`。

- [ ] **Step 1: 修改 GET /:id/events 端点**

把 `runs.ts` 中整个 `runsRouter.get('/:id/events', ...)` 替换为：

```typescript
runsRouter.get('/:id/events', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);

  return stream(c, async (streamWriter) => {
    streamWriter.onAbort(() => { /* client disconnected */ });

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const lastEventId = Number(c.req.header('Last-Event-ID') || 0);

    const send = async (event: string, data: unknown, id: number) => {
      try { await streamWriter.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* client disconnected */ }
    };

    // subscribe 重放历史（fromSeq 之后）+ 实时推送
    const unsub = run.stream.subscribe(lastEventId, send);

    const heartbeat = setInterval(async () => {
      try { await streamWriter.write(': keepalive\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 15000);

    streamWriter.onAbort(() => {
      clearInterval(heartbeat);
      unsub();
    });

    // 若 run 已结束，重放完即关闭
    if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
      // 等重放完成（subscribe 的 replay 是异步的，短暂等待）
      await new Promise((r) => setTimeout(r, 100));
      clearInterval(heartbeat);
      unsub();
      return;
    }

    await run.finished;
    // run 结束后等最后一批发送完
    await new Promise((r) => setTimeout(r, 100));
    clearInterval(heartbeat);
    unsub();
  });
});
```

- [ ] **Step 2: typecheck**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | grep -v mermaid-diagram | head -10`
Expected: 无新错误

- [ ] **Step 3: 运行 run 相关测试**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/run-stream.test.ts tests/unit/web/use-run.test.tsx 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd ~/projects/open-novel && git add src/api/routes/runs.ts && git commit -m "refactor: GET /events 改用 RunStream.subscribe"
```

---

## Task 6: 新增 GET /conversations/:id/stream（ConversationStream 端点）

**Files:**
- Modify: `src/api/routes/runs.ts`（新增端点）

前端 mount/刷新时的主入口。**一次性排空**：推历史 messages + 桥接活跃 RunStream 事件，run 结束后推固化消息，然后关闭流。不是长期连接——用户发新消息时走 sendMessage 的 per-run SSE（现有机制不变）。conversation stream 纯粹用于「刷新后追回错过的」场景。

- [ ] **Step 1: 新增 conversation stream 端点**

在 `runs.ts` 中，`GET /conversations/:id/active-run` 端点之后，新增：

```typescript
/**
 * Conversation 级 SSE 流——前端 mount/刷新时的主入口。
 *
 * 一次性排空：推历史 messages + 桥接活跃 RunStream 事件。run 结束后推固化
 * 的完整消息，然后关闭。不是长期连接——用户发新消息时走 sendMessage 的
 * per-run SSE（现有机制不变）。此端点纯粹用于「刷新后追回错过的」场景。
 */
runsRouter.get('/conversations/:id/stream', async (c) => {
  const convId = c.req.param('id');

  return stream(c, async (streamWriter) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const write = async (event: string, data: unknown) => {
      try { await streamWriter.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* disconnected */ }
    };

    // 1. 推历史 messages（已固化的完整对话）
    const historyMsgs = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    for (const m of historyMsgs) {
      await write('message', { id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts });
    }

    // 2. 查活跃 run
    const [latestRun] = await db.select().from(runsTable)
      .where(eq(runsTable.conversationId, convId))
      .orderBy(desc(runsTable.createdAt))
      .limit(1);

    if (!latestRun || latestRun.status !== 'running') {
      // 无活跃 run：历史已推完，一次性流结束
      return;
    }

    const run = getRun(latestRun.id);
    if (!run) return;

    // 3. 桥接活跃 RunStream 事件（重放 fromSeq 0 + 实时推送）
    //    前端据此看到流式响应的已生成内容 + 实时增量
    let unsub: (() => void) | null = null;
    unsub = run.stream.subscribe(0, async (event, data, id) => {
      try { await streamWriter.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch {}
    });

    streamWriter.onAbort(() => { if (unsub) unsub(); });

    // 4. 等 run 结束
    await run.finished;
    // 等最后一批事件发送完
    await new Promise((r) => setTimeout(r, 100));
    if (unsub) unsub();

    // 5. 推 run 结束后固化的完整 assistant 消息（补充 events/artifacts）
    const finalMsgs = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    const newMsgs = finalMsgs.slice(historyMsgs.length);
    for (const m of newMsgs) {
      await write('message', { id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts });
    }
  });
});
```

- [ ] **Step 2: typecheck**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | grep -v mermaid-diagram | head -10`
Expected: 无新错误

- [ ] **Step 3: Commit**

```bash
cd ~/projects/open-novel && git add src/api/routes/runs.ts && git commit -m "feat: GET /conversations/:id/stream conversation 级一次性排空 SSE 流"
```

---

## Task 7: 改造 useRun——mount 用 conversation 流恢复，sendMessage 保持 per-run SSE

**Files:**
- Modify: `src/web/hooks/useRun.ts`
- Modify: `tests/unit/web/use-run.test.tsx`

**设计简化**：mount/刷新时连 conversation 流（一次性排空：历史 + 活跃 run 追回）。sendMessage 保持现有 per-run SSE 不变——用户发消息时仍连 `/api/runs/:id/events`。这样避免了「新消息时 conversation 流已关闭」的竞态，也不用 streamTick 重连。

- [ ] **Step 1: 重写 mount effect**

把现有的 mount effect（含轮询逻辑，约第 33-105 行）替换为连接 conversation 流的纯排空逻辑：

```typescript
  // mount/刷新时连 conversation 流——一次性排空历史 messages + 活跃 run 事件。
  // 刷新后自动追回错过的响应内容，无需轮询。
  useEffect(() => {
    if (!conversationId) return;
    let aborted = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`/api/runs/conversations/${conversationId}/stream`, {
          signal: controller.signal,
        });
        if (!res.ok || aborted) return;
        const body = res.body;
        if (!body) return;
        const reader = body.getReader();

        for await (const frame of consumeSseStream(reader, controller.signal)) {
          if (aborted) break;
          const data = frame.data as Record<string, unknown>;
          switch (frame.event) {
            case 'message': {
              // 历史/固化的完整消息
              setMessages((prev) => [...prev, {
                role: data.role as 'user' | 'assistant',
                content: data.content as string,
                events: data.events as AgentEvent[] | undefined,
                artifacts: data.artifacts as { count: number; paths: string[] } | undefined,
                endedAt: data.role === 'assistant' ? Date.now() : undefined,
              }]);
              break;
            }
            case 'agent': {
              setIsRunning(true);
              handleAgentEvent(data);
              if (data.type === 'error') {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') last.endedAt = Date.now();
                  return updated;
                });
              }
              break;
            }
            case 'artifacts': {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  last.artifacts = { count: Number(data.count || 0), paths: Array.isArray(data.paths) ? data.paths : [] };
                }
                return updated;
              });
              break;
            }
            case 'end': {
              setIsRunning(false);
              setStatus('');
              break;
            }
            case 'stderr': {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  last.events = [...(last.events || []), { kind: 'raw', line: String(data.text || '') }];
                }
                return updated;
              });
              break;
            }
          }
        }
      } catch { /* abort or load error */ }
    })();

    return () => {
      aborted = true;
      controller.abort();
    };
  }, [conversationId]);
```

**关键**：`handleAgentEvent` 是 `function` 声明（hoisted），mount effect 可调用。

- [ ] **Step 2: 删除轮询相关代码**

删除：
- `const recoveryPollRef = useRef<ReturnType<typeof setInterval> | null>(null);`
- `resetConversation` 中的 recoveryPollRef 清理块
- sendMessage 中「用户发新消息时停止恢复轮询」的代码块（如果有）

- [ ] **Step 3: sendMessage 保持现有 per-run SSE 不变**

**不改 sendMessage 的 SSE 循环。** 它继续连 `/api/runs/:runId/events`，用 Last-Event-ID 重连。这是「用户主动发消息时的实时跟随」，与 mount 恢复分开。

唯一要确认：sendMessage 添加 user 消息时不要与 mount effect 的历史 message 重复。因为 mount effect 只在 conversationId 变化时触发（useState/effect 依赖），sendMessage 不会重新触发 mount effect。两者不重叠。

- [ ] **Step 4: 修改测试**

`tests/unit/web/use-run.test.tsx`：
1. 删除 `describe('useRun — 刷新后恢复运行中的 run', ...)` 整个块（轮询测试）
2. 第一个 describe（流结束时 flush）的 mock 保持 `/api/runs/r1/events`（sendMessage 仍用 per-run SSE，现有测试不变）

即：删除轮询测试 describe 块，保留 flush 测试不动。

- [ ] **Step 5: typecheck + 运行测试**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | grep -v mermaid-diagram | head -20`
Expected: 无新错误

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/use-run.test.tsx 2>&1 | tail -15`
Expected: PASS（2 个 flush 测试，轮询测试已删）

- [ ] **Step 6: Commit**

```bash
cd ~/projects/open-novel && git add src/web/hooks/useRun.ts tests/unit/web/use-run.test.tsx && git commit -m "refactor: useRun mount 用 conversation 流恢复，sendMessage 保持 per-run SSE"
```

---

## Task 8: 全量回归验证

**Files:** 无修改，纯验证

- [ ] **Step 1: typecheck**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | grep -v mermaid-diagram`
Expected: 无错误（mermaid-diagram pre-existing 忽略）

- [ ] **Step 2: 全量单元测试**

Run: `cd ~/projects/open-novel && npx vitest run 2>&1 | tail -10`
Expected: 全部 PASS

- [ ] **Step 3: 集成测试**

Run: `cd ~/projects/open-novel && npx vitest run tests/integration 2>&1 | tail -10`
Expected: 全部 PASS

- [ ] **Step 4: 检查 useConversations 的 messages 解构**

`src/web/hooks/useConversations.ts:38` 有 `return data.messages as ConversationMessage[]`。这是另一个 conversations 路由端点（`/api/conversations/:id/messages` 返回 `{ messages: [...] }`），与 runs 路由的不同。确认是否需要修改。

Run: `cd ~/projects/open-novel && grep -n "conversations.*messages" src/web/hooks/useConversations.ts`

如果 useConversations 调用的是 `GET /api/conversations/:id/messages`（conversations router），返回 `{ messages: [] }`，则 `data.messages` 正确，无需改。

- [ ] **Step 5: 验证 conversation stream 的竞态处理**

确认 GET /conversations/:id/stream 端点在连接瞬间 run 正好 close 时的行为：RunStream.subscribe 在 close 后仍能 replay 全部历史（已在 Task 2 测试验证），conversation 端点的桥接会收到重放的事件 + run.finished 立即 resolve，不会丢事件。

- [ ] **Step 6: 最终 Commit（如有零散修复）**

```bash
cd ~/projects/open-novel && git add -A && git commit -m "test: 全量回归通过" --allow-empty
```

---

## Self-Review

**Spec 覆盖：**
- ✅ RunStream 合并 eventStore + clients + close 持久化 → Task 1-4
- ✅ ConversationStream 端点 → Task 6（简化为一次性排空）
- ✅ 前端 mount 用 conversation 流恢复 → Task 7
- ✅ 撤 IncrementalAssistantMessage → Task 4
- ✅ 撤前端轮询 → Task 7
- ✅ useRewrite 不变（仍用 run events）→ Task 4 Step 5 仅改 eventStore→stream
- ✅ GET /runs/:id/events 保留 → Task 5 适配
- ✅ GET /conversations/:id/messages 保留 → 未改动
- ✅ active-run 端点保留 → 未改动
- ✅ sendMessage 保持 per-run SSE 不变 → Task 7 Step 3 确认

**类型一致性：**
- `createRun` 签名：Task 3 新增 `conversationId` 参数 → Task 4 的 runs.ts/rewrite.ts 调用点已同步
- `subscribeRun(run, fromSeq, send)` → Task 3 定义，Task 5 的 GET events 使用一致
- `RunStream.close(transform, options)` → Task 1 定义，Task 4 使用一致
- `run.stream` 属性 → Task 3 定义，Task 4/5/6 使用一致

**风险点：**
- retry 逻辑（Task 4 Step 4）：每次 launchAndTrack 创建新 run + 新 RunStream。旧 run finishRun 后 conversation stream 的 DB 查询（`orderBy(desc(createdAt)).limit(1)`）自动捡到新 run。刷新在 2s 重试间隔内时无活跃 run，conversation stream 返回纯历史——正确（那段时间确实无进行中的响应）。
- handleAgentEvent 在 mount effect 中的可达性：`function` 声明 hoisting 保证可用，运行时验证（Task 8）。
- mount effect 用 conversation 流接收 agent 事件时，assistant 消息占位：conversation 流的 message 事件推送完整历史消息（含 assistant），agent 事件推送活跃 run 的增量。如果同时有 message（历史 assistant）+ agent（活跃增量）事件，需确保不重复添加 assistant 消息。**缓解**：message 事件是历史（已结束的 run），agent 事件是当前活跃 run——不会同一条消息同时出现在两者。历史 assistant message 的 endedAt 已设，活跃 run 的 assistant 由 agent 事件动态构建。
