import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { eq, desc } from 'drizzle-orm';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, copyFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { db } from '../../db/drizzle';
import { projects, conversations } from '../../db/schema';
import { generateId } from '../../utils/id';
import { getPlugin } from '../../plugins/registry';
import { subscribe } from '../../agent/file-watcher';
import { subscribeProjectEvents, emitProjectEvent } from '../../agent/project-events';
import { resolveProjectDir, resolveNovelDir } from '../../shared/project-dir';
import { detectChapters, type ChunkSource } from '../../shared/text-chunker';
import { gitSync } from '../../agent/snapshot';
import {
  TEMPLATE_GENERATORS,
  TEMPLATE_FILE_PATHS,
  type TemplateGenOptions,
} from '../../shared/template-generator';
import timelineRouter from './timeline';

const projectsRouter = new Hono();

// 故事脉络子路由（/:id/timeline 等）
projectsRouter.route('/', timelineRouter);

projectsRouter.get('/', async (c) => {
  const all = await db.select().from(projects).orderBy(desc(projects.createdAt));
  const enriched = all.map((p) => ({
    ...p,
    pathExists: existsSync(p.path),
  }));
  return c.json({ projects: enriched });
});

projectsRouter.post('/', async (c) => {
  const body = await c.req.json();
  if (!body.path || typeof body.path !== 'string') {
    return c.json({ error: 'path is required' }, 400);
  }
  const id = generateId('proj_');
  const userPath = path.resolve(body.path);
  // Prevent creating directories in sensitive system locations
  const sensitive = ['/etc', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin', '/lib'];
  if (sensitive.some((p) => userPath === p || userPath.startsWith(p + '/'))) {
    return c.json({ error: '不允许在系统目录下创建项目' }, 400);
  }
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
  initWorkspace(userPath, {
    title: project.title,
    genre: project.genre,
    targetWords: project.targetWords,
    chapterCount: project.chapterCount,
    perspective: project.perspective,
    skillId: body.skillId,
  });

  return c.json({ project }, 201);
});

// Import an existing .novel/ directory
projectsRouter.post('/import', async (c) => {
  const body = await c.req.json();
  const userPath = path.resolve(body.path);
  const novelDir = path.join(userPath, '.novel');

  if (!existsSync(novelDir)) {
    return c.json({ error: '该目录下不存在 .novel/ 结构' }, 400);
  }

  // Read config.json if it exists
  let title = body.title || path.basename(userPath);
  let genre = 'general';
  let targetWords = 100000;
  let chapterCount = 20;
  let perspective = 'third-person';

  const configPath = path.join(novelDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      title = config.title || title;
      genre = config.genre || genre;
      targetWords = config.targetWords || targetWords;
      chapterCount = config.chapterCount || chapterCount;
      perspective = config.perspective || perspective;
    } catch { /* ignore */ }
  }

  // Check if already imported
  const existing = await db.select().from(projects).where(eq(projects.path, userPath)).limit(1);
  if (existing.length > 0) {
    return c.json({ error: '该项目已导入' }, 400);
  }

  const id = generateId('proj_');
  const [project] = await db.insert(projects).values({
    id,
    title,
    path: userPath,
    genre,
    targetWords,
    chapterCount,
    perspective,
  }).returning();

  return c.json({ project }, 201);
});

// Import raw text: reverse-decompose into a new .novel/ project
projectsRouter.post('/import-text', async (c) => {
  const body = await c.req.json();
  const userPath = path.resolve(body.path);

  // 校验路径存在
  if (!existsSync(userPath)) {
    return c.json({ error: '路径不存在' }, 400);
  }

  // 项目根目录：文件输入取其父目录，目录输入即自身。
  const stat = statSync(userPath);
  const projectRoot = stat.isDirectory() ? userPath : path.dirname(userPath);

  // 早判 .novel/ 是否已存在（先于文本收集，避免空 .novel/ 目录误报「未找到」）
  const novelDir = path.join(projectRoot, '.novel');
  if (existsSync(novelDir)) {
    return c.json({ error: '该目录已是 open-novel 项目，请用「打开项目」' }, 400);
  }

  // 收集文本内容
  const source: ChunkSource = stat.isDirectory()
    ? { kind: 'dir', files: collectTextFiles(userPath) }
    : { kind: 'file', content: readFileSync(userPath, 'utf-8'), filename: path.basename(userPath) };

  if (source.kind === 'dir' && source.files.length === 0) {
    return c.json({ error: '未找到 .txt 或 .md 文件' }, 400);
  }

  // 切章
  const chapters = detectChapters(source);
  if (chapters.length === 0) {
    return c.json({ error: '未检测到有效文本' }, 400);
  }

  // 创建 .novel/ 骨架
  mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });
  mkdirSync(path.join(novelDir, 'characters', 'profiles'), { recursive: true });

  // 写标准化章节文件
  for (const ch of chapters) {
    const header = ch.title && ch.title !== `第${ch.number}章`
      ? `# 第${ch.number}章 ${ch.title}`
      : `# 第${ch.number}章`;
    writeFileSync(
      path.join(novelDir, 'chapters', `第${ch.number}章.md`),
      `${header}\n\n${ch.content}`,
    );
  }

  // 写初始 config.json（待 agent 补全）
  const baseName = stat.isDirectory() ? path.basename(userPath) : path.basename(userPath).replace(/\.(txt|md)$/i, '');
  writeFileSync(
    path.join(novelDir, 'config.json'),
    JSON.stringify({
      title: body.title || baseName,
      genre: body.genre || 'general',
      perspective: 'third-person',
      chapterCount: chapters.length,
      targetWords: chapters.length * 5000,
    }, null, 2),
  );

  // 注册 DB 记录（path 存项目根目录，与「打开项目」一致）
  const id = generateId('proj_');
  const [project] = await db.insert(projects).values({
    id,
    title: body.title || baseName,
    path: projectRoot,
    genre: body.genre || 'general',
    targetWords: chapters.length * 5000,
    chapterCount: chapters.length,
    perspective: 'third-person',
  }).returning();

  return c.json({ project }, 201);
});

/** 收集目录下所有 .txt/.md 文件的 { name, content }。 */
function collectTextFiles(dir: string): { name: string; content: string }[] {
  return readdirSync(dir)
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((f) => ({ name: f, content: readFileSync(path.join(dir, f), 'utf-8') }));
}

projectsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);
  return c.json({ project });
});

projectsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  // Whitelist allowed fields to prevent mass assignment
  const allowed: Record<string, unknown> = {};
  if (body.title !== undefined) allowed.title = body.title;
  if (body.genre !== undefined) allowed.genre = body.genre;
  if (body.targetWords !== undefined) allowed.targetWords = body.targetWords;
  if (body.chapterCount !== undefined) allowed.chapterCount = body.chapterCount;
  if (body.theme !== undefined) allowed.theme = body.theme;
  if (body.perspective !== undefined) allowed.perspective = body.perspective;
  if (body.currentStage !== undefined) allowed.currentStage = body.currentStage;
  allowed.updatedAt = new Date();

  const [updated] = await db.update(projects)
    .set(allowed)
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

  initWorkspace(project.path, {
    title: project.title,
    genre: project.genre,
    targetWords: project.targetWords,
    chapterCount: project.chapterCount,
    perspective: project.perspective,
    skillId: body.skillId,
  });

  return c.json({ ok: true });
});

// Sync project with remote git
projectsRouter.post('/:id/sync', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveProjectDir(projectId);
  const result = await gitSync(projectDir);
  if (!result.success) return c.json({ error: result.message }, 400);
  return c.json({ ok: true, message: result.message });
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

interface WorkspaceOpts {
  title: string;
  genre: string;
  targetWords: number;
  chapterCount: number;
  perspective: string;
  skillId?: string;
}

/**
 * Initialize .novel/ workspace in the given directory.
 * Skips if .novel/ already exists.
 */
function initWorkspace(projectDir: string, opts: WorkspaceOpts): void {
  const plugin = getPlugin(opts.skillId || opts.genre || 'novel') || getPlugin('novel');
  if (!plugin) return;

  const novelDir = path.join(projectDir, '.novel');
  if (existsSync(novelDir)) return;

  mkdirSync(novelDir, { recursive: true });
  mkdirSync(path.join(novelDir, 'characters'), { recursive: true });
  mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });

  const templatesDir = path.join(plugin.path, 'templates');
  if (existsSync(templatesDir)) {
    copyTemplates(templatesDir, novelDir, {
      title: opts.title,
      genre: opts.genre,
      targetWords: String(opts.targetWords),
      chapterCount: String(opts.chapterCount),
    });
  }

  writeFileSync(path.join(novelDir, 'config.json'), JSON.stringify({
    title: opts.title,
    genre: opts.genre,
    targetWords: opts.targetWords,
    chapterCount: opts.chapterCount,
    perspective: opts.perspective,
    createdAt: new Date().toISOString(),
  }, null, 2));
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

// Write file content to project (.novel 目录下)
projectsRouter.put('/:id/files', async (c) => {
  const projectId = c.req.param('id');
  const body = await c.req.json();
  const filePath = body.path as string;
  const content = body.content as string;
  if (!filePath || typeof content !== 'string') {
    return c.json({ error: 'path and content are required' }, 400);
  }

  const projectDir = await resolveNovelDir(projectId);
  const normalizedPath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.resolve(projectDir, normalizedPath);

  // Security: ensure path is within project directory (prevent path traversal)
  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  try {
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    return c.json({ ok: true, path: normalizedPath });
  } catch {
    return c.json({ error: 'Write failed' }, 500);
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

/**
 * 从 project 行构造模板生成所需的元数据。
 * theme 在 schema 中可空，这里转为可选字段。
 */
function toTemplateOptions(p: typeof projects.$inferSelect): TemplateGenOptions {
  return {
    chapterCount: p.chapterCount,
    targetWords: p.targetWords,
    title: p.title,
    genre: p.genre,
    perspective: p.perspective,
    theme: p.theme ?? undefined,
  };
}

// 按项目元数据动态生成模板脚手架并写入 .novel/ 目录；已存在文件备份为 .bak
projectsRouter.post('/:id/generate-templates', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const novelDir = path.join(project.path, '.novel');
  mkdirSync(novelDir, { recursive: true });

  // 可选：请求体传入 { templates: [...] } 限定生成范围；默认生成全部
  let requested = Object.keys(TEMPLATE_FILE_PATHS);
  try {
    const body = await c.req.json();
    if (Array.isArray(body.templates) && body.templates.length > 0) {
      requested = body.templates;
    }
  } catch { /* 无请求体或非 JSON，使用默认全集 */ }

  const opts = toTemplateOptions(project);
  const written: { name: string; path: string; backedUp: boolean }[] = [];

  for (const name of requested) {
    const generator = TEMPLATE_GENERATORS[name];
    const relPath = TEMPLATE_FILE_PATHS[name];
    if (!generator || !relPath) continue; // 跳过未知模板名

    const fullPath = path.join(novelDir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    // 已存在则备份（覆盖旧 .bak），再加 .bak 后缀
    const backedUp = existsSync(fullPath);
    if (backedUp) copyFileSync(fullPath, `${fullPath}.bak`);
    writeFileSync(fullPath, generator(opts), 'utf-8');
    written.push({ name, path: relPath, backedUp });
  }

  return c.json({ ok: true, written });
});

// 预览（不写文件）：返回指定模板的生成内容
projectsRouter.get('/:id/templates/:templateName', async (c) => {
  const id = c.req.param('id');
  const templateName = c.req.param('templateName');
  const generator = TEMPLATE_GENERATORS[templateName];
  if (!generator) {
    return c.json({ error: `未知模板：${templateName}` }, 400);
  }

  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const content = generator(toTemplateOptions(project));
  return c.json({
    name: templateName,
    path: TEMPLATE_FILE_PATHS[templateName],
    content,
  });
});

export default projectsRouter;
