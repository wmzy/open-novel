import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { eq, desc } from 'drizzle-orm';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../../db/drizzle';
import { projects, conversations } from '../../db/schema';
import { generateId } from '../../utils/id';
import { getPlugin } from '../../plugins/registry';
import { subscribe } from '../../agent/file-watcher';
import { subscribeProjectEvents, emitProjectEvent } from '../../agent/project-events';
import { resolveProjectDir, resolveNovelDir } from '../../shared/project-dir';

const projectsRouter = new Hono();

projectsRouter.get('/', async (c) => {
  const all = await db.select().from(projects).orderBy(desc(projects.createdAt));
  return c.json({ projects: all });
});

projectsRouter.post('/', async (c) => {
  const body = await c.req.json();
  const id = generateId('proj_');
  const userPath = path.resolve(body.path);
  mkdirSync(userPath, { recursive: true });
  const [project] = await db.insert(projects).values({
    id,
    title: body.title || '未命名项目',
    path: userPath,
    genre: body.genre || 'general',
    targetWords: body.targetWords || 100000,
    chapterCount: body.chapterCount || 20,
    theme: body.theme || null,
    perspective: body.perspective || 'third-person',
  }).returning();

  // Auto-initialize workspace
  const plugin = getPlugin(body.skillId || body.genre || 'novel') || getPlugin('novel');
  if (plugin) {
    const novelDir = path.join(userPath, '.novel');

    if (!existsSync(novelDir)) {
      mkdirSync(novelDir, { recursive: true });
      mkdirSync(path.join(novelDir, 'characters'), { recursive: true });
      mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });

      const templatesDir = path.join(plugin.path, 'templates');
      if (existsSync(templatesDir)) {
        copyTemplates(templatesDir, novelDir, {
          title: project.title,
          genre: project.genre,
          targetWords: String(project.targetWords),
          chapterCount: String(project.chapterCount),
        });
      }

      writeFileSync(path.join(novelDir, 'config.json'), JSON.stringify({
        title: project.title,
        genre: project.genre,
        targetWords: project.targetWords,
        chapterCount: project.chapterCount,
        perspective: project.perspective,
        createdAt: new Date().toISOString(),
      }, null, 2));
    }
  }

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

  // Emit project update event
  emitProjectEvent(id, 'project-updated', { project: updated });

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

  const projectDir = project.path;
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

// List conversations for a project
projectsRouter.get('/:id/conversations', async (c) => {
  const projectId = c.req.param('id');
  const convs = await db.select().from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt));
  return c.json({ conversations: convs });
});

// Upload a file to the project
projectsRouter.post('/:id/upload', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveNovelDir(projectId);

  const body = await c.req.parseBody();
  const file = body['file'];
  const targetPath = body['path'] as string;

  if (!file || typeof file === 'string') {
    return c.json({ error: 'No file provided' }, 400);
  }

  if (!targetPath) {
    return c.json({ error: 'Target path is required' }, 400);
  }

  // Normalize and validate path
  const normalizedPath = path.normalize(targetPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.resolve(projectDir, normalizedPath);

  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const dir = path.dirname(fullPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, buffer);
    return c.json({ ok: true, path: normalizedPath });
  } catch {
    return c.json({ error: 'Upload failed' }, 500);
  }
});

// Read file content from project
projectsRouter.get('/:id/files', async (c) => {
  const projectId = c.req.param('id');
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'path is required' }, 400);

  // Normalize and resolve path
  const projectDir = await resolveNovelDir(projectId);
  const normalizedPath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.resolve(projectDir, normalizedPath);

  // Security: ensure path is within project directory (prevent path traversal)
  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    return c.json({ path: normalizedPath, content });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

// List files in project directory
projectsRouter.get('/:id/files/list', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveNovelDir(projectId);

  try {
    const files = listFilesRecursive(projectDir, '');
    return c.json({ files });
  } catch {
    return c.json({ files: [] });
  }
});

function listFilesRecursive(dir: string, prefix: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...listFilesRecursive(path.join(dir, entry.name), relPath));
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
        results.push(relPath);
      }
    }
  } catch { /* ignore */ }
  return results;
}

// SSE endpoint for real-time file change and project update notifications
projectsRouter.get('/:id/events', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveNovelDir(projectId);

  return stream(c, async (streamWriter) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    // Subscribe to file changes
    const unsubscribeFiles = subscribe(projectDir, (event) => {
      streamWriter.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Subscribe to project updates
    const unsubscribeProject = subscribeProjectEvents(projectId, (event) => {
      streamWriter.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // Keep-alive heartbeat
    const heartbeat = setInterval(async () => {
      try { await streamWriter.write(': keepalive\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 15000);

    streamWriter.onAbort(() => {
      clearInterval(heartbeat);
      unsubscribeFiles();
      unsubscribeProject();
    });

    // Keep stream open until client disconnects
    await new Promise<void>((resolve) => {
      streamWriter.onAbort(() => resolve());
    });
  });
});

export default projectsRouter;
