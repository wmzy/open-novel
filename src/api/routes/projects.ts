import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { generateId } from '../../utils/id';
import { getPlugin } from '../../plugins/registry';

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

projectsRouter.post('/:id/init', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const plugin = getPlugin(body.skillId || 'novel');
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

  const projectDir = path.resolve('./data/projects', id);
  const novelDir = path.join(projectDir, '.novel');

  if (!existsSync(novelDir)) {
    mkdirSync(novelDir, { recursive: true });
    mkdirSync(path.join(novelDir, 'characters'), { recursive: true });
    mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });

    // Copy templates
    const templatesDir = path.join(plugin.path, 'templates');
    if (existsSync(templatesDir)) {
      copyTemplates(templatesDir, novelDir, {
        title: project.title,
        genre: project.genre,
        targetWords: String(project.targetWords),
        chapterCount: String(project.chapterCount),
      });
    }

    // Write config
    writeFileSync(path.join(novelDir, 'config.json'), JSON.stringify({
      title: project.title,
      genre: project.genre,
      targetWords: project.targetWords,
      chapterCount: project.chapterCount,
      perspective: project.perspective,
      createdAt: new Date().toISOString(),
    }, null, 2));
  }

  return c.json({ ok: true });
});

function copyTemplates(src: string, dest: string, vars: Record<string, string>) {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTemplates(srcPath, destPath, vars);
    } else {
      let content = readFileSync(srcPath, 'utf-8');
      for (const [key, value] of Object.entries(vars)) {
        content = content.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }
      writeFileSync(destPath, content);
    }
  }
}

export default projectsRouter;
