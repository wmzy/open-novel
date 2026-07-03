import { Hono } from 'hono';
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { conversations, messages } from '../../db/schema';
import { generateId } from '../../utils/id';

const conversationsRouter = new Hono();

// List conversations for a project
conversationsRouter.get('/', async (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);

  const convs = await db.select().from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt));

  if (convs.length === 0) return c.json({ conversations: [] });

  // Fetch latest message for each conversation in one query
  const convIds = convs.map((conv) => conv.id);
  const latestMessages = await db.select().from(messages)
    .where(inArray(messages.conversationId, convIds))
    .orderBy(desc(messages.createdAt));

  // Build a map of conversationId -> latest message (first occurrence is latest due to sort)
  const latestByConv = new Map<string, typeof latestMessages[number]>();
  for (const msg of latestMessages) {
    if (!latestByConv.has(msg.conversationId)) {
      latestByConv.set(msg.conversationId, msg);
    }
  }

  return c.json({
    conversations: convs.map((conv) => ({
      id: conv.id,
      projectId: conv.projectId,
      agentId: conv.agentId,
      stage: conv.stage,
      createdAt: conv.createdAt,
      latestMessage: latestByConv.has(conv.id)
        ? { role: latestByConv.get(conv.id)!.role, content: latestByConv.get(conv.id)!.content }
        : null,
    })),
  });
});

// Delete a conversation and its messages
conversationsRouter.delete('/:id', async (c) => {
  const convId = c.req.param('id');
  const existing = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
  if (existing.length === 0) return c.json({ error: 'Conversation not found' }, 404);

  await db.delete(conversations).where(eq(conversations.id, convId));
  return c.json({ ok: true });
});

// Create a message in a conversation
conversationsRouter.post('/:id/messages', async (c) => {
  const convId = c.req.param('id');
  const body = await c.req.json();
  const existing = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
  if (existing.length === 0) return c.json({ error: 'Conversation not found' }, 404);

  const { role, content, events, artifacts } = body;
  if (!role || typeof content !== 'string') {
    return c.json({ error: 'role and content are required' }, 400);
  }

  const msgId = generateId('msg_');
  await db.insert(messages).values({
    id: msgId, conversationId: convId, role, content,
    events: events ?? null,
    artifacts: artifacts ?? null,
  });
  return c.json({ id: msgId }, 201);
});

// Get messages for a conversation
conversationsRouter.get('/:id/messages', async (c) => {
  const convId = c.req.param('id');
  const existing = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
  if (existing.length === 0) return c.json({ error: 'Conversation not found' }, 404);

  const msgs = await db.select().from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(messages.createdAt);

  return c.json({ messages: msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts, createdAt: m.createdAt })) });
});

export default conversationsRouter;
