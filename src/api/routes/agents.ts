import { Hono } from 'hono';
import { listPiModels, testPiConfig } from '../../agent/pi/config';

const agentsRouter = new Hono();

/**
 * 内置 Pi 是唯一 Agent。
 *
 * 返回结构保持与旧 /api/agents 兼容（agents[].models），前端无需知道
 * 运行时已从 CLI 子进程切换为进程内 SDK。
 */
agentsRouter.get('/', async (c) => {
  try {
    const { models, configured } = await listPiModels();
    return c.json({
      agents: [
        {
          id: 'pi',
          name: 'Pi（内置）',
          available: configured,
          models,
          streamFormat: 'pi-sdk',
          version: null,
        },
      ],
    });
  } catch (err) {
    return c.json({
      agents: [
        {
          id: 'pi',
          name: 'Pi（内置）',
          available: false,
          models: [],
          streamFormat: 'pi-sdk',
          version: null,
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    });
  }
});

agentsRouter.get('/:id/models', async (c) => {
  if (c.req.param('id') !== 'pi') return c.json({ error: 'Not found' }, 404);
  try {
    const { models } = await listPiModels();
    return c.json({ models });
  } catch (err) {
    return c.json({ models: [], error: err instanceof Error ? err.message : String(err) }, 200);
  }
});

agentsRouter.get('/:id/commands', async (c) => {
  if (c.req.param('id') !== 'pi') return c.json({ error: 'Not found' }, 404);
  return c.json({ commands: [] });
});

/** 配置检查：不调用模型，只验证 provider/model/auth 可解析。 */
agentsRouter.post('/:id/test', async (c) => {
  if (c.req.param('id') !== 'pi') return c.json({ error: 'Not found' }, 404);
  try {
    return c.json(await testPiConfig());
  } catch (err) {
    return c.json({
      ok: false,
      provider: '',
      model: '',
      auth: 'missing',
      message: err instanceof Error ? err.message : String(err),
    }, 200);
  }
});

export default agentsRouter;
