import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ status: 'ok' }));

export default app;
