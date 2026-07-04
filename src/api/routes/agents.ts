import { Hono } from 'hono';
import { detectAgents } from '../../agent/detection';
import { getAgentDef } from '../../agent/registry';
import { probeAcpCommands } from '../../agent/acp-bridge';
import type { AgentCommand } from '../../agent/types';

const agentsRouter = new Hono();

/** 命令列表缓存：omp builtin 基本固定，长期缓存；进程升级后重探。 */
const commandCache = new Map<string, { commands: AgentCommand[]; ts: number }>();
const COMMAND_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

agentsRouter.get('/', async (c) => {
  const agents = await detectAgents();
  return c.json({ agents });
});

agentsRouter.get('/:id/models', async (c) => {
  const def = getAgentDef(c.req.param('id'));
  if (!def) return c.json({ error: 'Not found' }, 404);
  return c.json({ models: def.fallbackModels });
});

agentsRouter.get('/:id/commands', async (c) => {
  const id = c.req.param('id');
  const def = getAgentDef(id);
  if (!def) return c.json({ error: 'Not found' }, 404);
  // 非 ACP agent 无动态命令列表
  if (!def.usesAcp) return c.json({ commands: [] });

  const cached = commandCache.get(id);
  if (cached && Date.now() - cached.ts < COMMAND_CACHE_TTL) {
    return c.json({ commands: cached.commands });
  }

  const cwd = c.req.query('cwd') || process.cwd();
  try {
    const commands = await probeAcpCommands(def.bin, cwd);
    commandCache.set(id, { commands, ts: Date.now() });
    return c.json({ commands });
  } catch {
    // 探测失败时回退旧缓存或空
    return c.json({ commands: cached?.commands ?? [] });
  }
});

export default agentsRouter;
