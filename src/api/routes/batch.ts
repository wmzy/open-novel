/**
 * 批量写作路由。
 *
 * 挂载方式（api-app.ts）：app.route('/api/projects/:projectId/batch', batchRouter)
 *
 * 端点：
 *   GET    /            —— 读取当前批量状态（刷新/重启后 mount-replay）。
 *   POST   /            —— 创建批量 { from, to }（或 { range: '写第3到12章' }），
 *                          项目有活跃 run 时 409 run-in-progress。
 *   POST   /run-started —— 前端启动某章 run 后回填 runId（可选，排查用）。
 *   POST   /advance     —— 一章 run 结束后推进状态机 { chapter, succeeded, reason? }。
 *   POST   /pause       —— 请求暂停（当前章写完后停）。
 *   POST   /resume      —— 从暂停/失败恢复；有活跃 run 时 409。
 *   POST   /cancel      —— 取消批量（终态）。
 *
 * 批量本身不启动隐藏后台任务：每章都是前端经 POST /api/runs 发起的真实 run。
 */
import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import { BATCH_MAX_CHAPTERS, parseBatchCommand } from '../../shared/batch';
import { getActiveRunForProject, getRun, cancelRun } from '../../agent/run';
import { evaluateMilestones } from '../../agent/milestones';
import {
  advanceBatch,
  cancelBatch,
  pauseBatch,
  readBatchState,
  recordBatchRunStarted,
  resumeBatch,
  startBatch,
} from '../../agent/batch';

const batchRouter = new Hono();

/** 项目串行锁冲突。helper 返回 Response，处理器必须 return（否则 Hono 404）。 */
function rejectIfRunActive(
  c: { json: (body: Record<string, unknown>, status?: number) => Response },
  projectId: string,
  message: string,
): Response | null {
  const active = getActiveRunForProject(projectId);
  if (!active) return null;
  return c.json({
    error: 'run-in-progress',
    message,
    runId: active.id,
  }, 409);
}

async function resolveDirOr404(
  projectId: string,
): Promise<{ dir: string } | { response: Response }> {
  try {
    return { dir: await resolveProjectDir(projectId) };
  } catch {
    return { response: Response.json({ error: 'Project not found' }, { status: 404 }) };
  }
}

batchRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const resolved = await resolveDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const batch = await readBatchState(resolved.dir);
  return c.json({ batch });
});

batchRouter.post('/', async (c) => {
  const projectId = c.req.param('projectId')!;

  // 项目串行锁：批量开始前项目必须空闲。每章 run 也会再次校验（服务端兜底）。
  const locked = rejectIfRunActive(
    c,
    projectId,
    '该项目有正在运行的写作任务，请等待完成后再开始批量写作',
  );
  if (locked) return locked;

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  let from = Number(body.from);
  let to = Number(body.to);
  if (typeof body.range === 'string') {
    const parsed = parseBatchCommand(body.range);
    if (!parsed) {
      return c.json({ error: 'invalid-range', message: '无法识别批量范围，请使用「写第N到M章」或 /batch N-M' }, 400);
    }
    from = parsed.from;
    to = parsed.to;
  }

  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
    return c.json({ error: 'invalid-range', message: 'from/to 必须为正整数' }, 400);
  }
  if (to < from) {
    return c.json({ error: 'invalid-range', message: '结束章号必须大于或等于起始章号' }, 400);
  }
  if (to - from + 1 > BATCH_MAX_CHAPTERS) {
    return c.json({
      error: 'batch-too-large',
      message: `单批最多 ${BATCH_MAX_CHAPTERS} 章（本次 ${to - from + 1} 章），请分批提交`,
      max: BATCH_MAX_CHAPTERS,
    }, 400);
  }

  const resolved = await resolveDirOr404(projectId);
  if ('response' in resolved) return resolved.response;

  // 不允许在旧批量仍运行时静默覆盖状态（两章之间没有活跃 run，但批量仍
  // 在推进）。失败状态可由新批量覆盖——用户显式放弃后重新开始。
  const existing = await readBatchState(resolved.dir);
  if (existing && (existing.status === 'running' || existing.status === 'paused')) {
    return c.json({
      error: 'batch-in-progress',
      message: '已有批量写作未结束，请先取消后再开始新批量',
      batch: existing,
    }, 409);
  }

  const agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
  const skillId = typeof body.skillId === 'string' ? body.skillId : undefined;
  const batch = await startBatch(resolved.dir, projectId, from, to, { agentId, skillId });
  return c.json({ batch }, 201);
});

batchRouter.post('/run-started', async (c) => {
  const projectId = c.req.param('projectId')!;
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const chapter = Number(body.chapter);
  const runId = typeof body.runId === 'string' ? body.runId : '';
  if (!Number.isInteger(chapter) || !runId) {
    return c.json({ error: 'chapter and runId are required' }, 400);
  }
  // 关联的 run 必须属于同一项目，避免跨项目误推进批量状态。
  const run = getRun(runId);
  if (!run || run.projectId !== projectId) {
    return c.json({ error: 'Invalid runId for this project' }, 400);
  }
  const resolved = await resolveDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const batch = await recordBatchRunStarted(resolved.dir, chapter, runId);
  if (!batch) return c.json({ error: 'No batch state' }, 404);
  return c.json({ batch });
});

batchRouter.post('/advance', async (c) => {
  const projectId = c.req.param('projectId')!;
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const chapter = Number(body.chapter);
  const succeeded = body.succeeded === true;
  if (!Number.isInteger(chapter)) {
    return c.json({ error: 'chapter is required' }, 400);
  }
  const resolved = await resolveDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const batch = await advanceBatch(
    resolved.dir,
    chapter,
    succeeded,
    typeof body.reason === 'string' ? body.reason : null,
  );
  if (!batch) return c.json({ error: 'No batch state' }, 404);

  // 批量结束时补一次里程碑评估：最后几章的评估可能因「批量进行中」跳过
  // 回顾；此时用户不再自动续写，正好用同一 agent/skill 触发真实回顾 run。
  if (batch.status === 'completed') {
    const timer = setTimeout(() => {
      void evaluateMilestones(resolved.dir, projectId, {
        agentId: batch.agentId ?? undefined,
        skillId: batch.skillId ?? undefined,
      }).catch(() => {});
    }, 0);
    timer.unref?.();
  }
  return c.json({ batch });
});

batchRouter.post('/pause', async (c) => {
  const projectId = c.req.param('projectId')!;
  const resolved = await resolveDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const runActive = getActiveRunForProject(projectId) !== null;
  const batch = await pauseBatch(resolved.dir, runActive);
  if (!batch) return c.json({ error: 'No batch state' }, 404);

  // 暂停后不再自动续写：补一次里程碑评估，让此前因批量在途跳过的回顾
  // 有机会在空闲时触发（run 仍在途时评估会自行推迟）。
  const timer = setTimeout(() => {
    void evaluateMilestones(resolved.dir, projectId, {
      agentId: batch.agentId ?? undefined,
      skillId: batch.skillId ?? undefined,
    }).catch(() => {});
  }, 2000);
  timer.unref?.();
  return c.json({ batch });
});

batchRouter.post('/resume', async (c) => {
  const projectId = c.req.param('projectId')!;
  const locked = rejectIfRunActive(
    c,
    projectId,
    '该项目有正在运行的写作任务，请等待完成后再恢复批量写作',
  );
  if (locked) return locked;

  const resolved = await resolveDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const batch = await resumeBatch(resolved.dir);
  if (!batch) return c.json({ error: 'No batch state' }, 404);
  if (batch.status !== 'running') {
    return c.json({
      error: 'batch-not-resumable',
      message: `批量状态为 ${batch.status}，无法继续`,
      batch,
    }, 400);
  }
  return c.json({ batch });
});

batchRouter.post('/cancel', async (c) => {
  const projectId = c.req.param('projectId')!;
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const resolved = await resolveDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const before = await readBatchState(resolved.dir);
  const batch = await cancelBatch(resolved.dir);
  if (!batch) return c.json({ error: 'No batch state' }, 404);

  // 可选的当前章 run：仅当 runId 与批量记录一致且仍在运行时才终止，
  // 避免误杀里程碑回顾等其它真实 run。
  const runId = typeof body.runId === 'string' ? body.runId : before?.lastRunId ?? null;
  if (runId && before?.lastRunId === runId) {
    const run = getRun(runId);
    if (run && (run.status === 'running' || run.status === 'queued')) {
      run.cancelReason = 'user-cancel';
      cancelRun(run);
    }
  }

  // 取消后不再自动续写：给被跳过的里程碑回顾一次补触发机会（run 终止后）。
  const timer = setTimeout(() => {
    void evaluateMilestones(resolved.dir, projectId, {
      agentId: batch.agentId ?? undefined,
      skillId: batch.skillId ?? undefined,
    }).catch(() => {});
  }, 2000);
  timer.unref?.();
  return c.json({ batch });
});

export default batchRouter;
