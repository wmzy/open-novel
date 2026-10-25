import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createRun, emitEvent, finishRun, cancelRun, getActiveRunForProject } from '../../agent/run';
import { composePrompt } from '../../agent/prompt-composer';
import { startPiAgent } from '../../agent/pi/runtime';
import { collectWrittenPaths, syncFilesToDb } from '../../agent/artifacts';
import { ensureContextArtifacts } from '../../agent/context-manager';
import { createSnapshot } from '../../agent/snapshot';
import { resolveProjectDir } from '../../shared/project-dir';
import { config } from '../../config';
import { db } from '../../db/drizzle';
import { runs as runsTable } from '../../db/schema';
import { transformStreamEvents } from './runs';

const rewriteRouter = new Hono();

/**
 * 章节级局部重写端点。
 *
 * 复用 runs 的 run 生命周期（createRun / launchAgent / 流式解析 / finishRun / 快照），
 * 但不绑定对话与历史——重写是一次性、面向片段的请求。返回 runId，前端通过
 * /api/runs/:id/events 订阅 SSE 流，累加 text_delta 即为重写后的文本。
 *
 * prompt 采用任务约定的模板：注入项目上下文 + 技能（经 composePrompt），
 * 保证重写片段与全书设定、文风一致。
 */
rewriteRouter.post('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const body = await c.req.json();
  const { chapterNum, selectedText, instruction, agentId, skillId, model } = body as {
    chapterNum?: number;
    selectedText?: string;
    instruction?: string;
    agentId?: string;
    skillId?: string;
    model?: string;
  };

  // 参数校验
  if (chapterNum === undefined || Number.isNaN(Number(chapterNum))) {
    return c.json({ error: 'chapterNum is required' }, 400);
  }
  if (!selectedText || typeof selectedText !== 'string' || selectedText.trim().length < 1) {
    return c.json({ error: 'selectedText is required' }, 400);
  }
  if (!instruction || typeof instruction !== 'string' || instruction.trim().length < 1) {
    return c.json({ error: 'instruction is required' }, 400);
  }
  const requestedAgentId = agentId?.trim() || 'pi';
  const LEGACY_AGENT_ALIASES = new Set(['claude', 'opencode', 'omp']);
  if (requestedAgentId !== 'pi' && !LEGACY_AGENT_ALIASES.has(requestedAgentId)) {
    return c.json({
      error: 'Agent not found',
      message: '仅支持内置 Pi SDK',
    }, 404);
  }
  const effectiveAgentId = 'pi';

  // 项目级串行锁：重写与写作 run 同样不能并行（同写 state/章节文件）
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目已有正在运行的写作任务，请等待完成后再开始新任务',
      runId: activeRun.id,
    }, 409);
  }

  // 组装局部重写 prompt（任务约定模板）
  const rewriteMessage =
    `以下是小说第${chapterNum}章的一段文本，请根据指令重写这一段，` +
    `保持上下文连贯，只返回重写后的文本段落：\n\n` +
    `指令：${instruction}\n\n` +
    `原文：\n${selectedText}`;

  const projectDir = await resolveProjectDir(projectId);
  const composedPrompt = await composePrompt({
    message: rewriteMessage,
    projectId,
    skillId,
    stage: 'revision',
    projectDir,
    agentId: effectiveAgentId,
  });

  // 创建 run（不绑定对话；RunStream 需要 conversationId 但重写不固化消息）
  const run = createRun({ projectId, agentId: effectiveAgentId, skillId: skillId || '', stage: 'revision', conversationId: `rewrite_${Date.now()}` });
  await db.insert(runsTable).values({ id: run.id, agent: effectiveAgentId, status: 'running', mode: 'rewrite' });

  // 看门狗：超时取消
  const timeoutTimer = setTimeout(() => {
    run.cancelReason = 'timeout';
    cancelRun(run);
  }, config.agent.timeoutMs);
  timeoutTimer.unref();

  const attempt = startPiAgent({
    prompt: composedPrompt,
    cwd: projectDir,
    model,
    onEvent: (event) => emitEvent(run, 'agent', event),
  });
  run.abort = attempt.abort;
  run.status = 'running';

  void attempt.promise
    .then(async (result) => {
      clearTimeout(timeoutTimer);
      run.abort = null;

      const canceled = run.cancelRequested || result.aborted;
      const code = canceled ? 1 : result.code;

      // 从 RunStream（DB + 内存窗口合并）读取全部事件
      await run.stream.flush();
      const allEvents = await run.stream.replay(0);
      const agentEvents = allEvents
        .filter((e) => e.event === 'agent')
        .map((e) => e.data as Record<string, unknown>);
      const writtenPaths = collectWrittenPaths(agentEvents);

      if (writtenPaths.size > 0) {
        emitEvent(run, 'artifacts', { count: writtenPaths.size, paths: [...writtenPaths] });
      }

      // 收尾顺序与主 runs.ts 对齐：'end' 事件最后发，前端收到时管道已完全收尾。
      if (writtenPaths.size > 0) {
        await syncFilesToDb(projectId, writtenPaths, projectDir).catch(() => {});
      }

      // 兜底：补全缺失的章节摘要与状态表（仅重写成功时）
      if (code === 0 && writtenPaths.size > 0) {
        await ensureContextArtifacts(projectDir, writtenPaths).catch(() => {});
      }
      await createSnapshot(projectDir, `Rewrite ${run.id.slice(0, 8)}: ${writtenPaths.size} files modified`).catch(() => {});

      await db.update(runsTable)
        .set({
          status: canceled ? 'canceled' : code === 0 ? 'succeeded' : 'failed',
          finishedAt: new Date(),
        })
        .where(eq(runsTable.id, run.id)).execute();

      // 固化事件流（重写不绑定对话，消息固化静默跳过；close 同时清理订阅者）。
      await run.stream.close(transformStreamEvents, {
        failed: code !== 0,
        failLabel: canceled ? run.cancelReason || 'canceled' : result.error,
        artifacts: writtenPaths.size > 0 ? { count: writtenPaths.size, paths: [...writtenPaths] } : null,
      }).catch(() => {});

      finishRun(run, canceled ? 'canceled' : code === 0 ? 'succeeded' : 'failed');
    })
    .catch((err) => {
      clearTimeout(timeoutTimer);
      run.abort = null;
      emitEvent(run, 'agent', {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      finishRun(run, 'failed');
    });

  return c.json({ runId: run.id }, 201);
});

export default rewriteRouter;
