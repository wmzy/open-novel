import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDbReady } from './db/drizzle';
import { initPlugins } from './plugins/registry';
import { onError } from './api/middleware/error-handler';
import { config } from './config';
import { requestLogger } from './api/middleware/logger';
import { securityHeaders, rateLimit, maxBodySize } from './api/middleware/security';
import projectsRouter from './api/routes/projects';
import chaptersRouter from './api/routes/chapters';
import settingsRouter from './api/routes/settings';
import agentsRouter from './api/routes/agents';
import runsRouter from './api/routes/runs';
import pluginsRouter from './api/routes/plugins';
import conversationsRouter from './api/routes/conversations';
import searchRouter from './api/routes/search';
import exportRouter from './api/routes/export';
import checkRouter from './api/routes/check';
import rewriteRouter from './api/routes/rewrite';

const app = new Hono();

// Security, logging middleware
app.use('/api/*', securityHeaders);
app.use('/api/*', rateLimit(config.rateLimit.max, config.rateLimit.windowMs));
app.use('/api/*', maxBodySize(25 * 1024 * 1024)); // 25MB: generous for text + image uploads
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
app.route('/api/projects/:projectId/chapters', chaptersRouter);
app.route('/api/projects/:projectId/search', searchRouter);
app.route('/api/projects/:projectId/export', exportRouter);
app.route('/api/projects/:projectId/check', checkRouter);
app.route('/api/projects/:projectId/rewrite', rewriteRouter);
app.route('/api/settings', settingsRouter);
app.route('/api/agents', agentsRouter);
app.route('/api/runs', runsRouter);
app.route('/api/plugins', pluginsRouter);
app.route('/api/conversations', conversationsRouter);

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
