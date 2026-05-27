import { Hono } from 'hono';
import { getPlugins, getPlugin } from '../../plugins/registry';

const pluginsRouter = new Hono();

pluginsRouter.get('/', (c) => {
  const plugins = getPlugins().map((p) => ({
    id: p.id,
    name: p.manifest.name,
    description: p.manifest.description,
    version: p.manifest.version,
    stages: p.manifest.stages,
  }));
  return c.json({ plugins });
});

pluginsRouter.get('/:id', (c) => {
  const plugin = getPlugin(c.req.param('id'));
  if (!plugin) return c.json({ error: 'Not found' }, 404);
  return c.json({
    id: plugin.id,
    manifest: plugin.manifest,
    skillContent: plugin.skillContent,
  });
});

export default pluginsRouter;
