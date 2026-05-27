import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ensureDbReady } from './db/drizzle';
import projectsRouter from './api/routes/projects';

const app = new Hono();

let dbReady = false;
app.use('/api/*', async (c, next) => {
  if (!dbReady) {
    await ensureDbReady();
    dbReady = true;
  }
  return next();
});

app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.route('/api/projects', projectsRouter);

export default app;
