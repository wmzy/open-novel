import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createRun, getRun, emitEvent, finishRun, cancelRun, subscribeRun } from '../../agent/run';
import { eventStore } from '../../agent/event-store';
import { composePrompt } from '../../agent/prompt-composer';
import { getAgentDef } from '../../agent/registry';
import { detectAgents } from '../../agent/detection';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler, createJsonEventHandler } from '../../agent/stream-parser';
import { collectWrittenPaths, syncFilesToDb } from '../../agent/artifacts';
import { detectAiPatterns, detectDegradation } from '../../agent/quality-checker';
import type { AgentEvent, StreamEvent } from '../../agent/types';
import { ensureContextArtifacts } from '../../agent/context-manager';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot, restoreSnapshot, listSnapshots } from '../../agent/snapshot';
import { resolveProjectDir } from '../../shared/project-dir';
import { config } from '../../config';
import { db } from '../../db/drizzle';
import { conversations, messages, runs as runsTable } from '../../db/schema';
import { generateId } from '../../utils/id';
import { eq } from 'drizzle-orm';

// ===== 流层 watchdog 配置 =====
/** 滑动窗口大小（字符数）。窗口内统计 2-gram 重复率。 */
const WATCHDOG_WINDOW_SIZE = 2000;

// ===== 写后质检门禁阈值 =====
const QUALITY_REJECT_SCORE = 60;
const QUALITY_WARN_SCORE = 30;

// ===== 字数校验配置 =====
const TARGET_WORDS = 3500;
const WORD_DEVIATION_THRESHOLD = 0.5;

/** 章节正文文件名（中英文命名，排除摘要/退化文件）。返回章节号或 null。 */
function isChapterBody(p: string): number | null {
  const basename = path.basename(p);
  if (basename.includes('.summary.') || basename.includes('.degraded.')) return null;
  const cn = basename.match(/^第(\d+)章\.md$/);
  if (cn) return parseInt(cn[1], 10);
  const en = basename.match(/^chapter-(\d+)\.md$/i);
  if (en) return parseInt(en[1], 10);
  return null;
}

/** 将 writtenPath 解析为绝对路径。 */
function resolveWrittenPath(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(projectDir, p);
}

/** 写后质检门禁：对新章节正文跑 detectAiPatterns，退化分高时归档并通知前端。 */
async function qualityGateCheck(
  run: ReturnType<typeof createRun>,
  projectDir: string,
  writtenPaths: Set<string>,
): Promise<void> {
  for (const p of writtenPaths) {
    const chapterNum = isChapterBody(p);
    if (chapterNum === null) continue;

    const fullPath = resolveWrittenPath(projectDir, p);
    let content: string;
    try { content = await readFile(fullPath, 'utf-8'); } catch { continue; }

    const report = detectAiPatterns(content);
    if (report.score >= QUALITY_REJECT_SCORE) {
      // 退化严重：归档为 .degraded.md，通知前端
      try { await rename(fullPath, fullPath.replace(/\.md$/, '.degraded.md')); } catch {}
      emitEvent(run, 'agent', {
        type: 'quality-rejected',
        chapter: chapterNum,
        score: report.score,
        topIssues: report.issues.slice(0, 3).map((i) => i.suggestion),
      });
    } else if (report.score >= QUALITY_WARN_SCORE) {
      emitEvent(run, 'agent', {
        type: 'quality-warning',
        chapter: chapterNum,
        score: report.score,
      });
    }
  }
}

/** 字数校验：对新章节统计 CJK 字数，偏差超阈值时通知前端。 */
async function wordCountCheck(
  run: ReturnType<typeof createRun>,
  projectDir: string,
  writtenPaths: Set<string>,
): Promise<void> {
  for (const p of writtenPaths) {
    const chapterNum = isChapterBody(p);
    if (chapterNum === null) continue;

    const fullPath = resolveWrittenPath(projectDir, p);
    let content: string;
    try { content = await readFile(fullPath, 'utf-8'); } catch { continue; }

    const cjkCount = [...content].filter((c) => c >= '\u4e00' && c <= '\u9fff').length;
    const deviation = Math.abs(cjkCount - TARGET_WORDS) / TARGET_WORDS;
    if (deviation > WORD_DEVIATION_THRESHOLD) {
      emitEvent(run, 'agent', {
        type: 'word-count-warning',
        chapter: chapterNum,
        wordCount: cjkCount,
        target: TARGET_WORDS,
        deviation: Math.round(deviation * 100),
      });
    }
  }
}

/** 从 agent 子进程 stderr 中脱敏常见凭证模式，避免泄露到前端。 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/[sS][kK]-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]'], // OpenAI/Anthropic API key
  [/[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [REDACTED]'], // Bearer token
  [
    /((?:api[_-]?key|token|secret|password|authorization)["'\s]*[:=]\s*["']?)[A-Za-z0-9._\/+=-]{8,}/gi,
    '$1[REDACTED]',
  ], // key=value / key: value 形式
];

export function sanitizeStderr(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/**
 * 将原始 StreamEvent[] 转换为可持久化的 AgentEvent[] 格式（合并连续 text/thinking delta）。
 * 同时提取纯文本 content 供消息表存储。无文本输出时用工具调用摘要兜底。
 */
export function transformStreamEvents(rawEvents: Record<string, unknown>[]): { content: string; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  let textBuf = '';
  let thinkingBuf = '';

  const flush = () => {
    if (thinkingBuf) { events.push({ kind: 'thinking', text: thinkingBuf }); thinkingBuf = ''; }
    if (textBuf) { events.push({ kind: 'text', text: textBuf }); textBuf = ''; }
  };

  for (const e of rawEvents) {
    const type = e.type as string;
    if (type === 'text_delta') {
      textBuf += String(e.delta || '');
    } else if (type === 'thinking_delta') {
      thinkingBuf += String(e.delta || '');
    } else {
      flush();
      switch (type) {
        case 'tool_use':
          events.push({ kind: 'tool_use', id: String(e.id || ''), name: String(e.name || ''), input: e.input });
          break;
        case 'tool_result':
          events.push({ kind: 'tool_result', toolUseId: String(e.toolUseId || ''), content: String(e.content || ''), isError: e.isError === true });
          break;
        case 'status':
          events.push({ kind: 'status', label: String(e.label || ''), detail: e.detail as string | undefined });
          break;
        case 'usage': {
          const u = e.usage as Record<string, unknown> | null;
          events.push({ kind: 'usage', inputTokens: u?.input_tokens as number | undefined, outputTokens: u?.output_tokens as number | undefined, costUsd: e.costUsd as number | undefined });
          break;
        }
        case 'error':
          events.push({ kind: 'raw', line: String(e.message || '') });
          break;
        case 'raw':
          events.push({ kind: 'raw', line: String(e.line || '') });
          break;
      }
    }
  }
  flush();

  const textContent = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('');
  const toolSummary = events.filter((e) => e.kind === 'tool_use').map((e) => `[${(e as { name: string }).name}]`).join(' ');
  const content = textContent || toolSummary;

  return { content, events };
}

const runsRouter = new Hono();

runsRouter.post('/', async (c) => {
  const body = await c.req.json();
  const { projectId, agentId, skillId, stage, message, conversationId, model } = body;

  const def = getAgentDef(agentId);
  if (!def) return c.json({ error: 'Agent not found' }, 404);

  const agents = await detectAgents();
  const detected = agents.find((a) => a.id === agentId);
  if (!detected?.available) return c.json({ error: 'Agent not available' }, 400);

  let convId: string;
  let history: { role: string; content: string }[] = [];

  if (conversationId) {
    // Load existing conversation
    const existing = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (existing.length === 0) return c.json({ error: 'Conversation not found' }, 404);
    convId = conversationId;

    // Load prior messages for history
    const priorMessages = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    history = priorMessages.map((m) => ({ role: m.role, content: m.content }));
  } else {
    // Create new conversation
    convId = generateId('conv_');
    await db.insert(conversations).values({ id: convId, projectId, agentId, stage });
  }

  // Insert current user message
  const msgId = generateId('msg_');
  await db.insert(messages).values({ id: msgId, conversationId: convId, role: 'user', content: message });

  const run = createRun({ projectId, agentId, skillId, stage });

  // Store run in DB
  await db.insert(runsTable).values({ id: run.id, conversationId: convId, agent: agentId, status: 'running' });

  // Compose prompt with project context, skill, and conversation history
  const projectDir = await resolveProjectDir(projectId);
  const composedPrompt = await composePrompt({
    message,
    projectId,
    skillId,
    stage,
    projectDir,
    history: history.length > 0 ? history : undefined,
  });

  // Launch agent
  const { child } = launchAgent(def, composedPrompt, projectDir, [], model);
  run.child = child;
  run.status = 'running';

  // Watchdog: cancel the run if the agent subprocess exceeds the configured timeout.
  // unref() so the timer never keeps the event loop (and process) alive.
  const timeoutTimer = setTimeout(() => cancelRun(run), config.agent.timeoutMs);
  timeoutTimer.unref();

  // Parse stream
  const onStreamComplete = () => {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }
  };
  // P1-a: 流层 watchdog — 累积 text_delta 做重复率检测，退化时自动 kill
  let watchdogBuffer = '';
  let watchdogTriggered = false;
  const emitWithWatchdog = (event: StreamEvent) => {
    if (event.type === 'text_delta' && typeof event.delta === 'string') {
      if (watchdogTriggered) return;
      watchdogBuffer = (watchdogBuffer + event.delta).slice(-WATCHDOG_WINDOW_SIZE);
      if (watchdogBuffer.length >= WATCHDOG_WINDOW_SIZE) {
        const result = detectDegradation(watchdogBuffer);
        if (result.detected) {
          watchdogTriggered = true;
          emitEvent(run, 'agent', {
            type: 'degradation',
            phrase: result.repeatedPhrase,
            count: result.count,
            ratio: Math.round(result.ratio * 100),
          });
          cancelRun(run);
          return;
        }
      }
    }
    emitEvent(run, 'agent', event);
  };

  const handler = def.streamFormat === 'claude-stream-json'
    ? createClaudeStreamHandler(emitWithWatchdog, onStreamComplete)
    : createJsonEventHandler(emitWithWatchdog);

  child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => emitEvent(run, 'stderr', { text: sanitizeStderr(chunk.toString()) }));

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

    // Collect artifacts from run events (filter to agent events only)
    const agentEvents = run.events
      .filter((e) => e.event === 'agent')
      .map((e) => e.data as Record<string, unknown>);
    const writtenPaths = collectWrittenPaths(agentEvents);

    // Emit artifact summary event
    if (writtenPaths.size > 0) {
      emitEvent(run, 'artifacts', {
        count: writtenPaths.size,
        paths: [...writtenPaths],
      });
    }

    // P0: 以下所有收尾操作完成后再 finishRun — 'end' 事件 = 管道完全收尾

    // Persist assistant message (authoritative — frontend no longer persists).
    // Even if the SSE client disconnected, the message is durably stored here.
    if (code === 0 && agentEvents.length > 0) {
      const { content: assistantContent, events: agentEventList } = transformStreamEvents(agentEvents);
      if (assistantContent || agentEventList.length > 0) {
        await db.insert(messages).values({
          id: generateId('msg_'),
          conversationId: convId,
          role: 'assistant',
          content: assistantContent || '(无文本输出)',
          events: agentEventList,
          artifacts: writtenPaths.size > 0 ? { count: writtenPaths.size, paths: [...writtenPaths] } : null,
        }).catch(() => {});
      }
    }

    // Sync file changes back to DB
    const projectDir = await resolveProjectDir(projectId);
    if (writtenPaths.size > 0) {
      await syncFilesToDb(projectId, writtenPaths, projectDir).catch(() => {});
    }

    // P1-b: 写后质检门禁 — 退化分高的章节自动归档为 .degraded.md
    if (code === 0 && writtenPaths.size > 0) {
      await qualityGateCheck(run, projectDir, writtenPaths).catch(() => {});
    }

    // P2: 字数校验 — 偏差超阈值的章节通知前端
    if (code === 0 && writtenPaths.size > 0) {
      await wordCountCheck(run, projectDir, writtenPaths).catch(() => {});
    }

    // 兜底：补全缺失的章节摘要与状态表（仅写作成功时）
    if (code === 0 && writtenPaths.size > 0) {
      await ensureContextArtifacts(projectDir, writtenPaths).catch(() => {});
    }

    // Create git snapshot
    await createSnapshot(projectDir, `Run ${run.id.slice(0, 8)}: ${writtenPaths.size} files modified`).catch(() => {});

    // Update run record
    await db.update(runsTable).set({
      status: code === 0 ? 'succeeded' : 'failed',
      finishedAt: new Date(),
    }).where(eq(runsTable.id, run.id)).execute();

    // P0: 最后才 finishRun — 'end' 事件表示管道完全收尾
    finishRun(run, code === 0 ? 'succeeded' : 'failed');
  });

  return c.json({ runId: run.id, conversationId: convId }, 201);
});

runsRouter.get('/:id/events', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);

  return stream(c, async (streamWriter) => {
    streamWriter.onAbort(() => { /* client disconnected */ });

    // Set SSE headers
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const lastEventId = Number(c.req.header('Last-Event-ID') || 0);

    // Replay missed events (DB history + in-memory window, merged & deduped by seq)
    const missed = await eventStore.replay(run.id, lastEventId, run.events);
    for (const record of missed) {
      await streamWriter.write(`id: ${record.id}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`);
    }

    // If already finished, close
    if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
      return;
    }

    // Subscribe for live events
    const send = async (event: string, data: unknown, id: number) => {
      try {
        await streamWriter.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* client disconnected */ }
    };
    subscribeRun(run, send);

    // Keep-alive heartbeat
    const heartbeat = setInterval(async () => {
      try { await streamWriter.write(': keepalive\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 15000);

    streamWriter.onAbort(() => {
      clearInterval(heartbeat);
      run.clients.delete(send);
    });

    // Wait until run finishes (event-driven, no polling)
    await run.finished;
  });
});

runsRouter.post('/:id/tool-result', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json();
  if (run.child?.stdin) {
    const msg = JSON.stringify({
      type: 'tool_result',
      tool_use_id: body.toolUseId,
      content: body.content,
      is_error: body.isError || false,
    });
    run.child.stdin.write(msg + '\n');
  }
  return c.json({ ok: true });
});

runsRouter.delete('/:id', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  cancelRun(run);
  return c.json({ ok: true });
});

runsRouter.get('/conversations/:id/messages', async (c) => {
  const convId = c.req.param('id');
  const existing = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
  if (existing.length === 0) return c.json({ error: 'Conversation not found' }, 404);

  const msgs = await db.select().from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(messages.createdAt);

  return c.json(msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts, createdAt: m.createdAt })));
});

// Retry a failed run
runsRouter.post('/:id/retry', async (c) => {
  const runId = c.req.param('id');
  const run = getRun(runId);
  if (!run) return c.json({ error: 'Run not found' }, 404);
  if (run.status !== 'failed') return c.json({ error: 'Only failed runs can be retried' }, 400);

  // Get the conversation and original message
  const [runRecord] = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  if (!runRecord?.conversationId) return c.json({ error: 'No conversation found' }, 404);

  const lastUserMsg = await db.select().from(messages)
    .where(eq(messages.conversationId, runRecord.conversationId))
    .orderBy(messages.createdAt);

  const userMessage = lastUserMsg.filter((m) => m.role === 'user').pop();
  if (!userMessage) return c.json({ error: 'No user message to retry' }, 400);

  // Return info needed to retry
  return c.json({
    conversationId: runRecord.conversationId,
    agentId: run.agentId,
    stage: run.stage,
    message: userMessage.content,
  });
});

// List snapshots for a project
runsRouter.get('/projects/:projectId/snapshots', async (c) => {
  const projectId = c.req.param('projectId');
  const projectDir = await resolveProjectDir(projectId);
  const snapshots = await listSnapshots(projectDir);
  return c.json({ snapshots });
});

// Rollback to a snapshot
runsRouter.post('/projects/:projectId/rollback', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await c.req.json();
  if (!body.commitHash) return c.json({ error: 'commitHash is required' }, 400);

  const projectDir = await resolveProjectDir(projectId);
  const success = await restoreSnapshot(projectDir, body.commitHash);
  if (!success) return c.json({ error: 'Rollback failed' }, 500);

  return c.json({ ok: true });
});

export default runsRouter;
