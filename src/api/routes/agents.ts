import { Hono } from 'hono';
import { detectAgents } from '../../agent/detection';
import { getAgentDef } from '../../agent/registry';

const agentsRouter = new Hono();

agentsRouter.get('/', async (c) => {
  const agents = await detectAgents();
  return c.json({ agents });
});

agentsRouter.get('/:id/models', async (c) => {
  const def = getAgentDef(c.req.param('id'));
  if (!def) return c.json({ error: 'Not found' }, 404);
  return c.json({ models: def.fallbackModels });
});

export default agentsRouter;
