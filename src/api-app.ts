import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDbReady } from './db/drizzle';
import { initPlugins } from './plugins/registry';
import projectsRouter from './api/routes/projects';
import chaptersRouter from './api/routes/chapters';
import settingsRouter from './api/routes/settings';
import agentsRouter from './api/routes/agents';
import runsRouter from './api/routes/runs';
import pluginsRouter from './api/routes/plugins';

const app = new Hono();

let dbReady = false;
app.use('/api/*', async (c, next) => {
  if (!dbReady) {
    await ensureDbReady();
    initPlugins();
    dbReady = true;
  }
  return next();
});

app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.route('/api/projects', projectsRouter);
app.route('/api/projects/:projectId/chapters', chaptersRouter);
app.route('/api/settings', settingsRouter);
app.route('/api/agents', agentsRouter);
app.route('/api/runs', runsRouter);
app.route('/api/plugins', pluginsRouter);

// File serving endpoint
app.get('/api/projects/:id/files/*', async (c) => {
  const id = c.req.param('id');
  const filePath = c.req.path.replace(`/api/projects/${id}/files/`, '');
  const fullPath = path.resolve('./data/projects', id, filePath);
  try {
    const content = await readFile(fullPath, 'utf-8');
    return c.text(content);
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

export default app;
