/**
 * EventStore — run 事件流的持久化与回放层。
 *
 * 设计目标（面向多项目并行下的内存控制）：
 *   - DB（run_events 表）是事件的事实来源；
 *   - 内存只保留每个 run 的滑动窗口（由 run.ts 维护），用于实时 SSE 推送；
 *   - 事件缓冲后批量落盘（FLUSH_THRESHOLD 条或 FLUSH_INTERVAL_MS 触发），
 *     将高频 text_delta 的 DB 写次数降低约一个数量级；
 *   - run 完成时 release() 落盘剩余事件并清空缓冲，内存占用随之释放。
 *
 * run.ts 保持纯运行状态机职责（状态流转 / 客户端订阅 / 终态幂等），
 * 仅通过 append() 委托持久化、通过 replay() 取回历史。
 */
import { and, eq, gt, asc } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { runEvents } from '../db/schema';
import { generateId } from '../utils/id';

/** 与 run.events 元素同构的窗口事件记录。 */
export interface RunEventRecord {
  id: number;
  event: string;
  data: unknown;
  timestamp: number;
}

/** 攒够多少条就落盘一次。 */
const FLUSH_THRESHOLD = 50;
/** 即便条数不够，最多间隔多久落盘一次（保证低频事件不长期滞留内存）。 */
const FLUSH_INTERVAL_MS = 500;

interface BufferedEvent {
  seq: number;
  type: string;
  data: unknown;
}

const pending = new Map<string, BufferedEvent[]>();
const timers = new Map<string, NodeJS.Timeout>();

/** 把某 run 的缓冲事件批量写入 run_events 表，并清理定时器。 */
async function flush(runId: string): Promise<void> {
  const t = timers.get(runId);
  if (t) {
    clearTimeout(t);
    timers.delete(runId);
  }
  const buf = pending.get(runId);
  if (!buf || buf.length === 0) return;
  pending.set(runId, []);
  try {
    await db.insert(runEvents).values(
      buf.map((e) => ({ id: generateId('rev_'), runId, seq: e.seq, type: e.type, data: e.data })),
    );
  } catch (err) {
    // 持久化失败不应阻断实时流——事件仍保留在内存窗口中供短期续传。
    console.error('[event-store] flush failed for run', runId, err);
  }
}

export const eventStore = {
  /**
   * 追加一条事件到落盘缓冲。达到阈值立即 flush，否则启动/复用定时器延迟 flush。
   * 非阻塞：内部 flush 是 fire-and-forget，调用方（emitEvent）保持同步语义。
   */
  append(runId: string, seq: number, type: string, data: unknown): void {
    let buf = pending.get(runId);
    if (!buf) {
      buf = [];
      pending.set(runId, buf);
    }
    buf.push({ seq, type, data });
    if (buf.length >= FLUSH_THRESHOLD) {
      flush(runId).catch(() => {});
    } else if (!timers.has(runId)) {
      const t = setTimeout(() => {
        flush(runId).catch(() => {});
      }, FLUSH_INTERVAL_MS);
      t.unref?.();
      timers.set(runId, t);
    }
  },

  /** 暴露给 run 完成时主动落盘。 */
  flush,

  /**
   * 回放 seq > afterSeq 的事件，用于 SSE 断线重连。
   * 合并 DB（已落盘历史）与内存窗口（含尚未 flush 的最新事件），按 seq 升序去重。
   * 内存窗口中的同 seq 优先（覆盖未落盘的最新副本）。
   */
  async replay(runId: string, afterSeq: number, memWindow: RunEventRecord[]): Promise<RunEventRecord[]> {
    const fromDb = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq));
    const map = new Map<number, RunEventRecord>();
    for (const r of fromDb) {
      map.set(r.seq, {
        id: r.seq,
        event: r.type,
        data: r.data,
        timestamp: new Date(r.createdAt).getTime(),
      });
    }
    for (const e of memWindow) {
      if (e.id > afterSeq) map.set(e.id, e);
    }
    return [...map.values()].sort((a, b) => a.id - b.id);
  },

  /**
   * run 终态时调用：落盘剩余缓冲并清理内存结构。
   * 之后该 run 的事件只存于 DB，run.ts 的内存窗口可安全清空。
   */
  async release(runId: string): Promise<void> {
    await flush(runId);
    pending.delete(runId);
  },
};
