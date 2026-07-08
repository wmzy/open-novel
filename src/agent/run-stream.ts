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

/** 每个运行中 run 保留在内存的滑动窗口大小（条）。 */
const WINDOW_SIZE = 200;

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

  /** 内存滑动窗口（实时推送 + replay 用）。 */
  private window: RunEventRecord[] = [];
  private nextSeq = 1;
  /** 落盘缓冲。 */
  private pending: BufferedEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 实时订阅者。 */
  private subscribers = new Set<Subscriber>();
  private _closed = false;

  constructor(runId: string, conversationId: string) {
    this.runId = runId;
    this.conversationId = conversationId;
  }

  /** 是否已关闭（agent 输出结束）。 */
  get isClosed(): boolean {
    return this._closed;
  }

  /** 当前 seq 分配器值（测试/诊断用）。 */
  get currentSeq(): number {
    return this.nextSeq;
  }

  /**
   * 写入一条事件：分配 seq → 内存窗口 → 落盘缓冲 → fan-out 订阅者。
   * 语义同原 emitEvent + eventStore.append 合并。
   */
  push(event: string, data: unknown): number {
    if (this._closed) return this.nextSeq;

    const id = this.nextSeq++;
    const record: RunEventRecord = { id, event, data, timestamp: Date.now() };
    this.window.push(record);
    if (this.window.length > WINDOW_SIZE) this.window.splice(0, this.window.length - WINDOW_SIZE);

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
   *
   * 快照 nextSeq 防竞态：replay 异步执行期间若有 push，新事件会同时被
   * replay（从 window 中读到）和 fan-out 推送——导致重复。快照界定
   * 「订阅时刻已存在的事件」，fan-out 负责「订阅后新到的事件」。
   */
  subscribe(fromSeq: number, cb: Subscriber): () => void {
    this.subscribers.add(cb);
    const snapshotSeq = this.nextSeq;
    this.replay(fromSeq, snapshotSeq).then((records) => {
      for (const r of records) cb(r.event, r.data, r.id);
    }).catch(() => {});
    return () => { this.subscribers.delete(cb); };
  }

  /** 立即落盘缓冲（不关闭流）。 */
  async flush(): Promise<void> {
    await this.doFlush();
  }

  /**
   * 回放 afterSeq < seq <= maxSeq 的事件，合并 DB（已落盘）与内存窗口（含未 flush），
   * 按 seq 升序去重，内存窗口中的同 seq 优先。
   * maxSeq 默认无穷大（close 时回放全部历史）。
   */
  async replay(afterSeq: number, maxSeq = Infinity): Promise<RunEventRecord[]> {
    const fromDb = await db.select().from(runEvents)
      .where(and(eq(runEvents.runId, this.runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq));
    const map = new Map<number, RunEventRecord>();
    for (const r of fromDb) {
      if (r.seq >= maxSeq) continue;
      map.set(r.seq, {
        id: r.seq,
        event: r.type,
        data: r.data,
        timestamp: new Date(r.createdAt).getTime(),
      });
    }
    for (const e of this.window) {
      if (e.id > afterSeq && e.id < maxSeq) map.set(e.id, e);
    }
    return [...map.values()].sort((a, b) => a.id - b.id);
  }

  /**
   * 关闭流：固化整条 assistant 消息到 messages 表，释放内存。
   * 在 close 前 push 的全部事件都参与聚合。
   */
  async close(
    transform: (events: Record<string, unknown>[]) => { content: string; events: unknown[] },
    options: { failed?: boolean; failLabel?: string; artifacts?: { count: number; paths: string[] } | null },
  ): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this.doFlush();
    const all = await this.replay(0);
    const agentEvents = all
      .filter((e) => e.event === 'agent')
      .map((e) => e.data as Record<string, unknown>);
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
