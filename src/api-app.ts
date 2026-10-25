import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDbReady } from './db/drizzle';
import { initPlugins } from './plugins/registry';
import { onError } from './api/middleware/error-handler';
import { reconcileStaleRuns } from './agent/run';
import { config } from './config';
import { requestLogger } from './api/middleware/logger';
import { securityHeaders, rateLimit } from './api/middleware/security';
import { authMiddleware } from './api/middleware/auth';
import projectsRouter from './api/routes/projects';
import manuscriptRouter from './api/routes/manuscript';
import chaptersRouter from './api/routes/chapters';
import settingsRouter from './api/routes/settings';
import agentsRouter from './api/routes/agents';
import runsRouter from './api/routes/runs';
import pluginsRouter from './api/routes/plugins';
import conversationsRouter from './api/routes/conversations';
import searchRouter from './api/routes/search';
import exportRouter from './api/routes/export';
import checkRouter from './api/routes/check';
import canonRouter from './api/routes/canon';
import contractsRouter from './api/routes/contracts';
import rewriteRouter from './api/routes/rewrite';
import namingRouter from './api/routes/naming';
import renameRouter from './api/routes/rename';
import reviewRouter from './api/routes/review';
import backupRouter from './api/routes/backup';
import foreshadowsRouter from './api/routes/foreshadows';
import retroRouter from './api/routes/retro';
import batchRouter from './api/routes/batch';
import contextRouter from './api/routes/context';

const app = new Hono();

// Security, logging middleware
app.use('/api/*', securityHeaders);
app.use('/api/*', rateLimit(config.rateLimit.max, config.rateLimit.windowMs));
// 可选令牌认证：AUTH_TOKEN 未设置时直接放行；设置后覆盖所有 /api/* 路由，
// 包括 SSE 流（EventSource 通过登录 Cookie 携带凭证）。放在 bodyLimit 之前，
// 未授权请求不会读入请求体。静态资源与 /api/health 不受影响。
app.use('/api/*', authMiddleware);
// 25MB：文本 + 图片上传的宽松上限。用 Hono 内置 bodyLimit 而非只看 content-length，
// chunked 传输无 content-length 时旧的自定义 maxBodySize 会被绕过。
app.use('/api/*', bodyLimit({
  maxSize: 25 * 1024 * 1024,
  onError: (c) => c.json({ error: 'Request body too large' }, 413),
}));
app.use('/api/*', requestLogger);

// Global error handler. Hono's middleware `try/catch` form does NOT catch
// route-handler throws, so this MUST be wired via `app.onError`.
app.onError(onError);

let dbReady = false;
app.use('/api/*', async (_c, next) => {
  if (!dbReady) {
    await ensureDbReady();
    initPlugins();
    dbReady = true;
    // 启动对账：上次进程遗留的 queued/running run 置为 failed（幂等）。
    // 放在 dbReady 之后、首个请求处理之前，保证 active-run/retry 口径一致。
    void reconcileStaleRuns();
  }
  return next();
});

app.use('/api/*', cors());

const startTime = Date.now();

app.get('/api/health', async (c) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);

  let dbStatus = 'ok';
  try {
    await ensureDbReady();
  } catch {
    dbStatus = 'error';
  }

  let diskFree = 'unknown';
  try {
    const { execFileSync } = await import('node:child_process');
    const df = execFileSync('df', ['-h', '/'], { encoding: 'utf-8' });
    const lines = df.trim().split('\n');
    const parts = lines[lines.length - 1]?.split(/\s+/);
    diskFree = parts?.[3] || 'unknown';
  } catch { /* ignore */ }

  return c.json({
    status: dbStatus === 'ok' ? 'ok' : 'degraded',
    uptime: `${uptime}s`,
    database: dbStatus,
    diskFree,
    version: process.env.npm_package_version || '0.1.0',
  });
});
app.route('/api/projects', projectsRouter);
app.route('/api/projects', manuscriptRouter);
app.route('/api/projects/:projectId/chapters', chaptersRouter);
app.route('/api/projects/:projectId/search', searchRouter);
app.route('/api/projects/:projectId/export', exportRouter);
app.route('/api/projects/:projectId/check', checkRouter);
app.route('/api/projects/:projectId/canon', canonRouter);
app.route('/api/projects/:projectId/contracts', contractsRouter);
app.route('/api/projects/:projectId/rewrite', rewriteRouter);
app.route('/api/projects/:projectId/naming', namingRouter);
app.route('/api/projects/:projectId/rename', renameRouter);
app.route('/api/projects/:projectId/review', reviewRouter);
app.route('/api/projects/:projectId/foreshadows', foreshadowsRouter);
app.route('/api/projects/:projectId/batch', batchRouter);
app.route('/api/projects/:projectId/context', contextRouter);
app.route('/api/projects/:projectId', retroRouter);
app.route('/api/settings', settingsRouter);
app.route('/api/agents', agentsRouter);
app.route('/api/runs', runsRouter);
app.route('/api/plugins', pluginsRouter);
app.route('/api/conversations', conversationsRouter);
app.route('/api/backup', backupRouter);

// File serving endpoint
app.get('/api/projects/:id/files/*', async (c) => {
  const id = c.req.param('id');
  const filePath = c.req.path.replace(`/api/projects/${id}/files/`, '');

  let projectDir: string;
  try {
    const { resolveNovelDir } = await import('./shared/project-dir');
    projectDir = await resolveNovelDir(id);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const normalizedPath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.resolve(projectDir, normalizedPath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  try {
    const content = await readFile(fullPath, 'utf-8');
    return c.text(content);
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

export default app;
