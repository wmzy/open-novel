import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import { reviewDiff, mergeDraft, discardDraft } from '../../agent/snapshot';
import { getActiveRunForProject } from '../../agent/run';

const reviewRouter = new Hono();

/** 项目串行锁：审阅合并/丢弃都会 checkout/reset 工作区，与 run 写盘互斥。 */
function rejectIfRunActive(c: { json: (body: Record<string, unknown>, status?: number) => unknown }, projectId: string): boolean {
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再执行审阅操作',
      runId: activeRun.id,
    }, 409);
    return true;
  }
  return false;
}

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
  if (rejectIfRunActive(c, projectId)) return;
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
  if (rejectIfRunActive(c, projectId)) return;
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
