import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import {
  appendCanonChanges,
  readCanon,
  writeCanon,
  type CanonChanges,
  type CanonLedger,
} from '../../shared/canon';

const canonRouter = new Hono();

async function projectDirOr404(projectId: string): Promise<{ dir: string } | { response: Response }> {
  try {
    return { dir: await resolveProjectDir(projectId) };
  } catch {
    return { response: Response.json({ error: 'Project not found' }, { status: 404 }) };
  }
}

/** 读取 canon 台账。 */
canonRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const canon = await readCanon(resolved.dir);
  return c.json({ canon });
});

/** 全量覆盖 canon 台账（人工编辑/迁移用）。 */
canonRouter.put('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const body = await c.req.json().catch(() => null) as { canon?: unknown } | null;
  if (!body || body.canon === undefined) {
    return c.json({ error: 'body.canon is required' }, 400);
  }
  const canon = await writeCanon(resolved.dir, body.canon as CanonLedger);
  return c.json({ canon });
});

/**
 * 追加变更（推荐入口）。
 * body: { chapter?: number, changes: CanonChanges }
 */
canonRouter.post('/changes', async (c) => {
  const projectId = c.req.param('projectId')!;
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const body = await c.req.json().catch(() => null) as { chapter?: unknown; changes?: unknown } | null;
  if (!body || !body.changes || typeof body.changes !== 'object') {
    return c.json({ error: 'body.changes is required' }, 400);
  }
  const chapter = typeof body.chapter === 'number' && Number.isFinite(body.chapter)
    ? Math.max(1, Math.trunc(body.chapter))
    : 1;
  const result = await appendCanonChanges(resolved.dir, body.changes as CanonChanges, chapter);
  return c.json({ canon: result.ledger, warnings: result.warnings });
});

export default canonRouter;
