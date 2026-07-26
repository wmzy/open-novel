import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import { reviewDiff, mergeDraft, discardDraft } from '../../agent/snapshot';

const reviewRouter = new Hono();

/** GET / — 待审阅 commits + per-file diff */
reviewRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  try {
    const result = await reviewDiff(projectDir);
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** POST /merge — ff main 到 draft */
reviewRouter.post('/merge', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  try {
    const result = await mergeDraft(projectDir);
    if (!result.success) return c.json({ error: '合并失败' }, 500);
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** POST /discard — 丢弃整批未审阅 */
reviewRouter.post('/discard', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  try {
    const result = await discardDraft(projectDir);
    if (!result.success) return c.json({ error: '丢弃失败' }, 500);
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

export default reviewRouter;
