import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { generateId } from '../../utils/id';

const projectsRouter = new Hono();

projectsRouter.get('/', async (c) => {
  const all = await db.select().from(projects).orderBy(desc(projects.createdAt));
  return c.json({ projects: all });
});

projectsRouter.post('/', async (c) => {
  const body = await c.req.json();
  const id = generateId('proj_');
  const [project] = await db.insert(projects).values({
    id,
    title: body.title || '未命名项目',
    genre: body.genre || 'general',
    targetWords: body.targetWords || 100000,
    chapterCount: body.chapterCount || 20,
    theme: body.theme || null,
    perspective: body.perspective || 'third-person',
  }).returning();
  return c.json({ project }, 201);
});

projectsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);
  return c.json({ project });
});

projectsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [updated] = await db.update(projects)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ project: updated });
});

projectsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(projects).where(eq(projects.id, id));
  return c.json({ ok: true });
});

export default projectsRouter;
