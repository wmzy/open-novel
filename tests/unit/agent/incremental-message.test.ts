import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { IncrementalAssistantMessage } from '../../../src/agent/incremental-message';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { messages, conversations, projects } from '../../../src/db/schema';

let dbReady = false;
async function ready() {
  if (!dbReady) {
    await ensureDbReady();
    dbReady = true;
  }
}

describe('IncrementalAssistantMessage', () => {
  let projectId: string;
  let convId: string;

  beforeAll(ready);

  beforeEach(async () => {
    projectId = 'proj_im_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    convId = 'conv_im_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    await db.insert(projects).values({ id: projectId, title: 't', path: '/tmp/x' });
    await db.insert(conversations).values({ id: convId, projectId, agentId: 'claude', stage: 'drafting' });
  });

  afterEach(async () => {
    await db.delete(messages).where(eq(messages.conversationId, convId));
    await db.delete(conversations).where(eq(conversations.id, convId));
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  it('首个 text_delta 惰性插入占位消息，flush 后 DB 可见累积文本', async () => {
    const inc = new IncrementalAssistantMessage(convId);
    expect(inc.messageId).toBeNull();

    inc.onTextDelta('你好');
    inc.onTextDelta('，世界');

    // 惰性插入已触发（首个 delta），messageId 已设
    expect(inc.messageId).not.toBeNull();

    inc.flush();
    // 等待 fire-and-forget 写入落盘
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db.select().from(messages).where(eq(messages.conversationId, convId));
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('assistant');
    // 首次插入只含第一个 delta（'你好'）；flush update 含全部累积
    expect(rows[0].content).toBe('你好，世界');
  });

  it('resetForRetry 复用同一 messageId，新 delta 覆盖旧内容', async () => {
    const inc = new IncrementalAssistantMessage(convId);
    inc.onTextDelta('第一次输出');
    inc.flush();
    await new Promise((r) => setTimeout(r, 50));

    const idBefore = inc.messageId;
    expect(idBefore).not.toBeNull();

    inc.resetForRetry();
    expect(inc.messageId).toBe(idBefore); // 复用

    inc.onTextDelta('重试后的输出');
    inc.flush();
    await new Promise((r) => setTimeout(r, 50));

    const rows = await db.select().from(messages).where(eq(messages.id, idBefore!));
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('重试后的输出');
  });

  it('从未调用 onTextDelta 时 messageId 为 null，flush 无副作用', async () => {
    const inc = new IncrementalAssistantMessage(convId);
    inc.flush();
    inc.dispose();
    expect(inc.messageId).toBeNull();

    const rows = await db.select().from(messages).where(eq(messages.conversationId, convId));
    expect(rows).toHaveLength(0);
  });

  it('dispose 清理定时器后不再产生写入', async () => {
    const inc = new IncrementalAssistantMessage(convId);
    inc.onTextDelta('a'); // 触发惰性 insert
    await new Promise((r) => setTimeout(r, 50));
    const id = inc.messageId!;

    inc.onTextDelta('b'); // 触发 scheduleFlush（定时器）
    inc.dispose();        // 清理定时器，阻止 flush
    await new Promise((r) => setTimeout(r, 50));

    // dispose 前只有惰性 insert 的 'a'，未被 flush 更新为 'ab'
    const rows = await db.select().from(messages).where(eq(messages.id, id));
    expect(rows[0].content).toBe('a');
  });
});
