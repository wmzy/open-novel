import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { messages } from '../db/schema';
import { generateId } from '../utils/id';

/** 增量 update 节流间隔（毫秒）。 */
const FLUSH_MS = 600;

/**
 * 增量持久化一条 assistant 消息。
 *
 * 根因修复：assistant 消息原本只在 run 结束（child.on('close')）时一次性
 * 写入 messages 表。流式响应中途刷新页面时，前端从 messages 表加载，该
 * 消息尚不存在 → 响应「完全消失」。本类在首个 text_delta 到达时惰性插入
 * 占位消息，随后节流更新 content，使刷新后即可看到已生成的部分内容。
 * run 结束时由 close handler 用 transformStreamEvents 的权威结果做最终写入。
 *
 * 与最终 content 一致：transformStreamEvents 的 content 即所有 text_delta
 * 合并文本，与本类累积的 accumulatedText 同源，无格式冲突。
 */
export class IncrementalAssistantMessage {
  private readonly conversationId: string;
  private accumulatedText = '';
  private _messageId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }

  /** 已创建的占位消息 ID（首个 text_delta 后非 null）。 */
  get messageId(): string | null {
    return this._messageId;
  }

  /**
   * 累积一段 text_delta。
   *
   * 首次调用惰性插入一条占位 assistant 消息（content 为当前累积文本），
   * 后续调用节流触发 update。节流避免高频 delta 把 PGlite 写穿。
   */
  onTextDelta(delta: string): void {
    if (!delta) return;
    this.accumulatedText += delta;
    if (!this._messageId) {
      // 惰性插入：首个 delta 才建消息，避免空 run 产生空消息
      this._messageId = generateId('msg_');
      void this.persist(this._messageId, this.accumulatedText, true);
    } else {
      this.scheduleFlush();
    }
  }

  /** 立即把当前累积文本写入 DB（若已有 messageId）。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this._messageId) {
      void this.persist(this._messageId, this.accumulatedText, false);
    }
  }

  /**
   * 自动重试新 attempt 前重置累积文本，复用同一 messageId。
   *
   * writing 阶段零产出自动重试（runs.ts）会重启 agent 产生新输出；复用
   * messageId 避免一次 run 产生多条 assistant 消息。重置后新 delta 从空
   * 开始，覆盖旧内容。
   */
  resetForRetry(): void {
    this.accumulatedText = '';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 清理定时器（run 失败/取消时）。 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this._messageId) {
        void this.persist(this._messageId, this.accumulatedText, false);
      }
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  private async persist(id: string, content: string, insert: boolean): Promise<void> {
    try {
      if (insert) {
        await db.insert(messages).values({
          id,
          conversationId: this.conversationId,
          role: 'assistant',
          content,
        }).execute();
      } else {
        await db.update(messages).set({ content }).where(eq(messages.id, id)).execute();
      }
    } catch {
      // 持久化失败不阻断流式；close handler 会做权威写入兜底。
    }
  }
}
