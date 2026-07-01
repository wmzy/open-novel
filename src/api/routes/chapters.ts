import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { chapters } from '../../db/schema';
import { generateId } from '../../utils/id';

const chaptersRouter = new Hono();

chaptersRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const all = await db.select().from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(chapters.number);
  return c.json({ chapters: all });
});

chaptersRouter.get('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const num = parseInt(c.req.param('num'));
  const [chapter] = await db.select().from(chapters)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .limit(1);
  if (!chapter) return c.json({ error: 'Not found' }, 404);
  return c.json({ chapter });
});

chaptersRouter.post('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const body = await c.req.json();

  if (!body.number) return c.json({ error: 'number is required' }, 400);

  // Check for duplicate
  const existing = await db.select().from(chapters)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, body.number)))
    .limit(1);
  if (existing.length > 0) return c.json({ error: 'Chapter already exists' }, 409);

  const id = generateId('ch_');
  const [chapter] = await db.insert(chapters).values({
    id,
    projectId,
    number: body.number,
    title: body.title || `Chapter ${body.number}`,
    wordCount: body.wordCount || 0,
    status: body.status || 'draft',
  }).returning();

  return c.json({ chapter }, 201);
});

chaptersRouter.patch('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const num = parseInt(c.req.param('num'));
  const body = await c.req.json();
  const [updated] = await db.update(chapters)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ chapter: updated });
});

chaptersRouter.delete('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const num = parseInt(c.req.param('num'));

  const [deleted] = await db.delete(chapters)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .returning();

  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default chaptersRouter;
