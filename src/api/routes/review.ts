import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import { reviewDiff, mergeDraft, discardDraft, acceptFileInReview, rejectFileInReview } from '../../agent/snapshot';
import { getActiveRunForProject } from '../../agent/run';
import {
  listReviewComments,
  addReviewComment,
  resolveReviewComment,
  commentsByFile,
} from '../../shared/review-comments';

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
  // run 进行中不跑 reviewDiff：reviewDiff 会把工作区未提交改动 checkpoint
  // 成 commit（agent 写盘途中的半成品文件会被提交进审阅队列），且 ensureDraftBranch
  // 的 checkout 可能与 agent 写盘互踩。返回空占位，run 结束后前端失效本查询重拉。
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({ commits: [], files: [], totalAdded: 0, totalRemoved: 0, runInProgress: true, runId: activeRun.id });
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

// ---------------------------------------------------------------------------
// 行内评论（PR 式审阅）：纯 .novel 元数据（.novel/review/comments.jsonl），
// 不做任何 git 操作，也不改 accept/reject 的双分支语义。
// ---------------------------------------------------------------------------

/** 评论锚定的 file 字段上限（仓库相对路径，与 reviewDiff 的 files[].path 同一坐标系）。 */
const COMMENT_FILE_MAX = 512;
/** 评论正文上限（字符）。 */
const COMMENT_BODY_MAX = 5_000;

/** 校验评论 file：项目内相对路径（拒绝绝对路径 / `..` / 空段 `//` / 控制字符 / 首尾空白）。 */
function isSafeCommentFile(file: string): boolean {
  if (file.length === 0 || file.length > COMMENT_FILE_MAX) return false;
  if (file.includes('\0') || file !== file.trim()) return false;
  if (file.startsWith('/') || file.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(file)) return false;
  const segments = file.split(/[\\/]/);
  return segments.every((s) => s.length > 0 && s !== '.' && s !== '..');
}

/** GET /comments — 评论列表（按文件分组 + 未解决计数）。
 * 与 GET / 不同：run 进行中放行——评论是纯 .novel 元数据读，不跑 git、
 * 不产生 checkpoint commit，run 期间查看/统计未解决评论是安全的。 */
reviewRouter.get('/comments', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  try {
    const comments = await listReviewComments(projectDir);
    return c.json({
      comments,
      byFile: commentsByFile(comments),
      unresolvedCount: comments.filter((cm) => !cm.resolved).length,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** POST /comments — 新增行内评论。body: { file, line?, body }。
 * 写 .novel 文件与 run 并发有覆盖风险，保守加 run 锁。 */
reviewRouter.post('/comments', async (c) => {
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
  const file = typeof body?.file === 'string' ? body.file : '';
  if (!file) return c.json({ error: 'file is required' }, 400);
  if (!isSafeCommentFile(file)) return c.json({ error: '非法文件路径' }, 400);
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) return c.json({ error: '评论内容不能为空' }, 400);
  if (text.length > COMMENT_BODY_MAX) {
    return c.json({ error: `评论内容过长（最多 ${COMMENT_BODY_MAX} 字）` }, 400);
  }
  const line = body?.line;
  if (line !== undefined && line !== null
    && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    return c.json({ error: 'line 必须是正整数' }, 400);
  }
  try {
    const comment = await addReviewComment(projectDir, {
      file,
      body: text,
      ...(line != null ? { line } : {}),
    });
    return c.json({ comment }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** PATCH /comments/:id — 解决/取消解决（jsonl 追加同 id 覆盖记录）。同样加 run 锁。 */
reviewRouter.patch('/comments/:id', async (c) => {
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
  if (typeof body?.resolved !== 'boolean') {
    return c.json({ error: 'resolved 必须是布尔值' }, 400);
  }
  try {
    const comment = await resolveReviewComment(projectDir, c.req.param('id')!, body.resolved);
    if (!comment) return c.json({ error: '评论不存在' }, 404);
    return c.json({ comment });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

export default reviewRouter;
