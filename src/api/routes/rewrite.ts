import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { createRun, emitEvent, finishRun, cancelRun } from '../../agent/run';
import { composePrompt } from '../../agent/prompt-composer';
import { getAgentDef } from '../../agent/registry';
import { detectAgents } from '../../agent/detection';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler, createJsonEventHandler } from '../../agent/stream-parser';
import { runAcpTurn } from '../../agent/acp-bridge';
import { collectWrittenPaths, syncFilesToDb } from '../../agent/artifacts';
import { ensureContextArtifacts } from '../../agent/context-manager';
import { createSnapshot } from '../../agent/snapshot';
import { resolveProjectDir } from '../../shared/project-dir';
import { config } from '../../config';
import { db } from '../../db/drizzle';
import { runs as runsTable } from '../../db/schema';
import { sanitizeStderr } from './runs';

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
  if (!agentId) return c.json({ error: 'agentId is required' }, 400);

  // 校验 agent 可用
  const def = getAgentDef(agentId);
  if (!def) return c.json({ error: 'Agent not found' }, 404);
  const agents = await detectAgents();
  const detected = agents.find((a) => a.id === agentId);
  if (!detected?.available) return c.json({ error: 'Agent not available' }, 400);

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
  });

  // 创建 run（不绑定对话）
  const run = createRun({ projectId, agentId, skillId: skillId || '', stage: 'revision' });
  await db.insert(runsTable).values({ id: run.id, agent: agentId, status: 'running' });

  // 启动 agent 子进程
  const { child } = launchAgent(def, composedPrompt, projectDir, [], model);
  run.child = child;
  run.status = 'running';

  // 看门狗：超时取消
  const timeoutTimer = setTimeout(() => cancelRun(run), config.agent.timeoutMs);
  timeoutTimer.unref();

  // 解析流
  const onStreamComplete = () => {
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
  };
  const emit = (event: any) => emitEvent(run, 'agent', event);
  const isAcp = def.streamFormat === 'acp-json-rpc';
  const handler = isAcp
    ? { feed: () => {}, flush: () => {} }
    : def.streamFormat === 'claude-stream-json'
      ? createClaudeStreamHandler(emit, onStreamComplete)
      : createJsonEventHandler(emit);

  if (!isAcp) {
    child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
  }
  child.stderr?.on('data', (chunk: Buffer) => emitEvent(run, 'stderr', { text: sanitizeStderr(chunk.toString()) }));

  if (isAcp) {
    runAcpTurn(child, composedPrompt, projectDir, [], emit, model)
      .catch((err) => emitEvent(run, 'agent', { type: 'error', message: err?.message || 'ACP turn failed' }));
  }

  child.on('error', (err) => {
    clearTimeout(timeoutTimer);
    emitEvent(run, 'agent', { type: 'error', message: err.message });
    handler.flush();
    finishRun(run, 'failed');
    db.update(runsTable).set({ status: run.status, finishedAt: new Date() }).where(eq(runsTable.id, run.id)).execute();
  });

  child.on('close', async (code) => {
    clearTimeout(timeoutTimer);
    handler.flush();

    // 收集写入文件并同步到 DB
    const agentEvents = run.events
      .filter((e) => e.event === 'agent')
      .map((e) => e.data as Record<string, unknown>);
    const writtenPaths = collectWrittenPaths(agentEvents);

    if (writtenPaths.size > 0) {
      emitEvent(run, 'artifacts', { count: writtenPaths.size, paths: [...writtenPaths] });
    }

    finishRun(run, code === 0 ? 'succeeded' : 'failed');

    if (writtenPaths.size > 0) {
      await syncFilesToDb(projectId, writtenPaths, projectDir).catch(() => {});
    }

    // 兜底：补全缺失的章节摘要与状态表（仅重写成功时）
    if (code === 0 && writtenPaths.size > 0) {
      await ensureContextArtifacts(projectDir, writtenPaths).catch(() => {});
    }
    await createSnapshot(projectDir, `Rewrite ${run.id.slice(0, 8)}: ${writtenPaths.size} files modified`).catch(() => {});

    await db.update(runsTable)
      .set({ status: run.status, finishedAt: new Date() })
      .where(eq(runsTable.id, run.id)).execute();
  });

  return c.json({ runId: run.id }, 201);
});

export default rewriteRouter;
