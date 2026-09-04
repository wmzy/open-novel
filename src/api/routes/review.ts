import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import { reviewDiff, mergeDraft, discardDraft, acceptFileInReview, rejectFileInReview } from '../../agent/snapshot';
import { getActiveRunForProject } from '../../agent/run';

const reviewRouter = new Hono();

/** 项目串行锁：审阅合并/丢弃都会 checkout/reset 工作区，与 run 写盘互斥。
 * 命中锁时返回 409 Response，未命中返回 null（处理器必须 return 该 Response，
 * 只调 c.json 后 return undefined 会被当作「未处理」落到 404）。 */
function rejectIfRunActive(c: { json: (body: Record<string, unknown>, status?: number) => Response }, projectId: string): Response | null {
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再执行审阅操作',
      runId: activeRun.id,
    }, 409);
  }
  return null;
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
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  try {
    const result = await mergeDraft(projectDir);
    if (!result.success) {
      return c.json({ error: result.error ?? '合并失败' }, 409);
    }
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/**
 * POST /files/accept — 接受单个文件的改动（draft → main）。
 * body: { path: string }，path 为 reviewDiff 返回的仓库相对路径。
 */
reviewRouter.post('/files/accept', async (c) => {
  const projectId = c.req.param('projectId')!;
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const filePath = typeof body?.path === 'string' ? body.path : '';
  if (!filePath) return c.json({ error: 'path is required' }, 400);
  const result = await acceptFileInReview(projectDir, filePath);
  if (!result.success) return c.json({ error: result.error ?? '接受失败' }, 409);
  return c.json(result);
});

/**
 * POST /files/reject — 拒绝单个文件的改动（draft 中还原为 main 版本）。
 * body: { path: string }。
 */
reviewRouter.post('/files/reject', async (c) => {
  const projectId = c.req.param('projectId')!;
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const filePath = typeof body?.path === 'string' ? body.path : '';
  if (!filePath) return c.json({ error: 'path is required' }, 400);
  const result = await rejectFileInReview(projectDir, filePath);
  if (!result.success) return c.json({ error: result.error ?? '拒绝失败' }, 409);
  return c.json(result);
});

/** POST /discard — 丢弃整批未审阅 */
reviewRouter.post('/discard', async (c) => {
  const projectId = c.req.param('projectId')!;
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;
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
