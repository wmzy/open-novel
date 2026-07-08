import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createRun, getRun, emitEvent, finishRun, cancelRun, subscribeRun, resolveAsk } from '../../agent/run';
import type { RunSession } from '../../agent/run';
import { composePrompt } from '../../agent/prompt-composer';
import { getAgentDef } from '../../agent/registry';
import { detectAgents } from '../../agent/detection';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler, createJsonEventHandler } from '../../agent/stream-parser';
import { runAcpTurn, isAcpFailure } from '../../agent/acp-bridge';
import { collectWrittenPaths, syncFilesToDb } from '../../agent/artifacts';
import { detectAiPatterns, detectDegradation, buildExcludeGrams } from '../../agent/quality-checker';
import type { AgentEvent, StreamEvent } from '../../agent/types';
import { ensureContextArtifacts, getStateTable } from '../../agent/context-manager';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot, restoreSnapshot, listSnapshots, createUserSnapshot } from '../../agent/snapshot';
import { resolveProjectDir } from '../../shared/project-dir';
import { config } from '../../config';
import { db } from '../../db/drizzle';
import { conversations, messages, projects, runs as runsTable } from '../../db/schema';
import { generateId } from '../../utils/id';
import { eq, desc } from 'drizzle-orm';

// ===== 流层 watchdog 配置 =====
/** 滑动窗口大小（字符数）。窗口内统计 2-gram 重复率。 */
const WATCHDOG_WINDOW_SIZE = 2000;

// ===== 写后质检门禁阈值 =====
const QUALITY_REJECT_SCORE = 60;
const QUALITY_WARN_SCORE = 30;

// ===== 字数校验配置 =====
const DEFAULT_TARGET_WORDS = 3500; // 项目元数据不可用时的兜底
const WORD_DEVIATION_THRESHOLD = 0.3; // 从 0.5 收紧到 0.3

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

/** 检测正文中是否出现章节编号引用（如「第15章」），排除首行标题。 */
function hasMetaNarrativeLeak(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const bodyLines = lines.length > 0 && /^\s{0,3}#{1,6}\s/.test(lines[0]) ? lines.slice(1) : lines;
  return /第\d+章|第[一二三四五六七八九十百]+章/.test(bodyLines.join('\n'));
}

/** 写后质检门禁：对新章节正文跑全文退化终检 + detectAiPatterns + 元叙事泄漏检测。 */
async function qualityGateCheck(
  run: ReturnType<typeof createRun>,
  projectDir: string,
  writtenPaths: Set<string>,
  excludeGrams: string[],
): Promise<void> {
  for (const p of writtenPaths) {
    const chapterNum = isChapterBody(p);
    if (chapterNum === null) continue;

    const fullPath = resolveWrittenPath(projectDir, p);
    let content: string;
    try { content = await readFile(fullPath, 'utf-8'); } catch { continue; }

    // P0 缺陷1: 全文退化终检——补全流式 watchdog 的短章节盲区
    // 流式 watchdog 需积满 2000 字符才检测，短章节（<2000字）从未触发
    const degradation = detectDegradation(content, { excludeGrams });
    if (degradation.detected) {
      try { await rename(fullPath, fullPath.replace(/\.md$/, '.degraded.md')); } catch {}
      emitEvent(run, 'agent', {
        type: 'quality-rejected',
        chapter: chapterNum,
        score: 100,
        reason: 'degradation',
        phrase: degradation.repeatedPhrase,
        count: degradation.count,
        ratio: Math.round(degradation.ratio * 100),
      });
      continue; // 已归档，不再检测 AI 味
    }

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

    // P1 缺陷3: 元叙事泄漏检测——正文出现章节编号引用
    if (hasMetaNarrativeLeak(content)) {
      emitEvent(run, 'agent', {
        type: 'quality-warning',
        chapter: chapterNum,
        reason: 'meta-narrative-leak',
        message: '正文中出现章节编号引用（如「第15章」），违反元叙事禁令',
      });
    }
  }
}

/** 字数校验：对新章节统计 CJK 字数，偏差超阈值时通知前端。 */
async function wordCountCheck(
  run: ReturnType<typeof createRun>,
  projectDir: string,
  writtenPaths: Set<string>,
  targetWords: number,
): Promise<void> {
  for (const p of writtenPaths) {
    const chapterNum = isChapterBody(p);
    if (chapterNum === null) continue;

    const fullPath = resolveWrittenPath(projectDir, p);
    let content: string;
    try { content = await readFile(fullPath, 'utf-8'); } catch { continue; }

    const cjkCount = [...content].filter((c) => c >= '\u4e00' && c <= '\u9fff').length;
    const deviation = Math.abs(cjkCount - targetWords) / targetWords;
    if (deviation > WORD_DEVIATION_THRESHOLD) {
      emitEvent(run, 'agent', {
        type: 'word-count-warning',
        chapter: chapterNum,
        wordCount: cjkCount,
        target: targetWords,
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
  const { projectId, agentId, skillId, stage, message, conversationId, model,
          mode = 'generate', targetFile, revisionNote, autonomous = false } = body;

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

  // Compose prompt with project context, skill, and conversation history
  const projectDir = await resolveProjectDir(projectId);

  // revise 模式：读取目标文件全文作为上下文 + baseSnapshot（run-local 快照，用于 close handler 生成 diff）
  let reviseContent: string | undefined;
  let baseSnapshot: string | undefined;
  if (mode === 'revise' && targetFile) {
    // targetFile 相对 .novel/（如 "chapters/第3章.md"）；尝试两种解析以兼容绝对/带前缀路径
    const candidates = path.isAbsolute(targetFile)
      ? [targetFile]
      : [path.join(projectDir, '.novel', targetFile), path.join(projectDir, targetFile)];
    let resolved: string | null = null;
    for (const cand of candidates) {
      try { await readFile(cand, 'utf-8'); resolved = cand; break; } catch {}
    }
    if (!resolved) {
      return c.json({ error: `Target file not found: ${targetFile}` }, 404);
    }
    reviseContent = await readFile(resolved, 'utf-8');
    baseSnapshot = reviseContent;
  }

  const composedPrompt = await composePrompt({
    message,
    projectId,
    skillId,
    stage,
    projectDir,
    history: history.length > 0 ? history : undefined,
    mode,
    reviseTarget: targetFile,
    reviseNote: revisionNote,
    reviseContent,
    autonomous,
  });

  /**
   * Launch the agent subprocess and wire up all stream handling, watchdog,
   * quality checks, and teardown. Extracted as a closure so it can be
   * re-invoked for zero-output auto-retry.
   *
   * @param retryOf  Run ID this attempt is retrying (for logging). null on first attempt.
   * @returns The RunSession for this attempt.
   */
  async function launchAndTrack(retryOf: string | null, existingRun?: RunSession): Promise<RunSession> {
  if (!def) throw new Error('Agent definition missing');
  // retry 复用同一 run/stream，前端 SSE 不断流、事件累积在同一流中
  const run = existingRun ?? createRun({ projectId, agentId, skillId, stage, conversationId: convId });
  run.status = 'running';

  // Store run in DB（仅首次创建时插入；retry 复用同一记录）
  if (!existingRun) {
    void db.insert(runsTable).values({
      id: run.id,
      conversationId: convId,
      agent: agentId,
      status: 'running',
      mode,
      payload: mode === 'revise' && targetFile
        ? { targetFile, revisionNote, baseSnapshot }
        : null,
    }).execute();
  }

  // Launch agent
  const { child } = launchAgent(def, composedPrompt, projectDir, [], model);
  run.child = child;

  // Watchdog: cancel the run if the agent subprocess exceeds the configured timeout.
  // unref() so the timer never keeps the event loop (and process) alive.
  const timeoutTimer = setTimeout(() => cancelRun(run), config.agent.timeoutMs);
  timeoutTimer.unref();

  // P2 缺陷5: 读取角色名生成 excludeGrams，避免聚焦章误报退化检测
  const characterState = await getStateTable(projectDir).catch(() => null);
  const excludeGrams = characterState?.characters
    ? buildExcludeGrams(characterState.characters.map((c) => c.name))
    : [];

  // P1 缺陷4: 从项目元数据计算每章字数目标
  let perChapterTarget = DEFAULT_TARGET_WORDS;
  try {
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (proj?.targetWords && proj?.chapterCount) {
      perChapterTarget = Math.round(proj.targetWords / proj.chapterCount);
    }
  } catch {}

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
        const result = detectDegradation(watchdogBuffer, { excludeGrams });
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

  // ACP 协议（omp）：不读 stdout 原始流，而是经 runAcpTurn 驱动 JSON-RPC 会话
  const isAcp = def.streamFormat === 'acp-json-rpc';
  // ACP 正常结束后的 stopReason（omp 常驻进程需主动 kill，exit code 无意义，改用此判定成败）
  let acpStopReason: string | null = null;
  const handler = isAcp
    ? { feed: () => {}, flush: () => {} }
    : def.streamFormat === 'claude-stream-json'
      ? createClaudeStreamHandler(emitWithWatchdog, onStreamComplete)
      : createJsonEventHandler(emitWithWatchdog);

  if (!isAcp) {
    child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
  }
  child.stderr?.on('data', (chunk: Buffer) => emitEvent(run, 'stderr', { text: sanitizeStderr(chunk.toString()) }));

  // ACP: 驱动协议会话，事件经 emitWithWatchdog 注入
  if (isAcp) {
    runAcpTurn(child, composedPrompt, projectDir, [], emitWithWatchdog, model, run.id)
      .then(({ stopReason }) => {
        acpStopReason = stopReason;
        if (stopReason === 'refusal' || stopReason === 'max_turn_requests') {
          emitEvent(run, 'agent', { type: 'error', message: `ACP stop: ${stopReason}` });
        }
        // omp 是常驻进程，会话结束后不自行退出。主动 kill 触发 child.on('close') 收尾链路。
        if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      })
      .catch((err) => {
        acpStopReason = 'error';
        emitEvent(run, 'agent', { type: 'error', message: err?.message || 'ACP turn failed' });
        if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      });
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

    // ACP 模式：omp 常驻进程被 SIGTERM 终止，exit code 无意义。
    // 用 stopReason 判定：只有显式失败（refusal/max_turn_requests/error）才算失败；
    // null（close 在 runAcpTurn resolve 前触发，如 timeout/进程退出）按成功处理，
    // 避免误丢已产生的 agent 响应。
    if (isAcp) {
      code = isAcpFailure(acpStopReason) ? 1 : 0;
    }

    // 从 RunStream 读取全部事件（DB + 内存窗口合并），提取写入路径 + emit artifacts
    await run.stream.flush();
    const allEvents = await run.stream.replay(0);
    const agentEvents = allEvents
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

    // Sync file changes back to DB
    const projectDir = await resolveProjectDir(projectId);
    if (writtenPaths.size > 0) {
      await syncFilesToDb(projectId, writtenPaths, projectDir).catch(() => {});
    }

    // P1-b: 写后质检门禁 — 退化分高的章节自动归档为 .degraded.md
    if (code === 0 && writtenPaths.size > 0) {
      await qualityGateCheck(run, projectDir, writtenPaths, excludeGrams).catch(() => {});
    }

    // P2: 字数校验 — 偏差超阈值的章节通知前端
    if (code === 0 && writtenPaths.size > 0) {
      await wordCountCheck(run, projectDir, writtenPaths, perChapterTarget).catch(() => {});
    }

    // 兜底：补全缺失的章节摘要与状态表（仅写作成功时）
    if (code === 0 && writtenPaths.size > 0) {
      await ensureContextArtifacts(projectDir, writtenPaths).catch(() => {});
    }

    // Create git snapshot
    await createSnapshot(projectDir, `Run ${run.id.slice(0, 8)}: ${writtenPaths.size} files modified`).catch(() => {});

    // revise 模式：生成 run-local diff 并 emit revision-applied 事件
    let reviseDiff: string | undefined;
    if (code === 0 && mode === 'revise' && targetFile && baseSnapshot !== undefined) {
      try {
        // 与启动时相同的解析逻辑（.novel 前缀兼容）
        const candidates = path.isAbsolute(targetFile)
          ? [targetFile]
          : [path.join(projectDir, '.novel', targetFile), path.join(projectDir, targetFile)];
        let newContent: string | null = null;
        for (const cand of candidates) {
          try { newContent = await readFile(cand, 'utf-8'); break; } catch {}
        }
        if (newContent !== null) {
          const { createUnifiedDiff, summarizeDiff } = await import('../../shared/diff-utils');
          reviseDiff = createUnifiedDiff(baseSnapshot, newContent, targetFile);
          const summary = summarizeDiff(reviseDiff);
          emitEvent(run, 'agent', {
            type: 'revision-applied',
            targetFile,
            addedLines: summary.addedLines,
            removedLines: summary.removedLines,
            diffPreview: reviseDiff.slice(0, 2000),
          });
        }
      } catch { /* diff 生成失败不阻断收尾 */ }
    }

    // Update run record（revise 模式附带 diff 进 payload）
    const updateSet: Record<string, unknown> = {
      status: code === 0 ? 'succeeded' : 'failed',
      finishedAt: new Date(),
    };
    if (reviseDiff !== undefined) {
      updateSet.payload = { targetFile, revisionNote, baseSnapshot, diff: reviseDiff };
    }
    await db.update(runsTable).set(updateSet).where(eq(runsTable.id, run.id)).execute();

    // P1: 零产出自动重试 — writing 阶段产出 0 个文件时自动重试一次。
    // 根因：agent 有时读上下文后空转退出（~30%概率），不写任何文件。
    // 不重试会浪费一轮对话额度且打断写作流程。
    if (code === 0 && writtenPaths.size === 0 && stage === 'writing' && retryOf === null) {
      emitEvent(run, 'agent', {
        type: 'info',
        message: 'Agent 未产出任何文件，正在自动重试…',
        retry: true,
      });
      // 短暂延迟后重试，复用同一 run/stream（前端 SSE 不断流）
      setTimeout(() => { void launchAndTrack(run.id, run); }, 2000);
      // 不 finishRun 也不 close stream — 重试复用同一事件流
      return;
    }

    // P0: 最后才 finishRun — 'end' 事件表示管道完全收尾

    // 固化 assistant 消息到 messages 表（RunStream.close 内部完成聚合 + 写入）
    // 失败的 run（code !== 0）只要有 agent 输出也持久化，加标记前缀。
    // 放在 retry 检查之后：retry 时不 close，保留 stream 给重试 attempt。
    const finalArtifacts = writtenPaths.size > 0 ? { count: writtenPaths.size, paths: [...writtenPaths] } : null;
    await run.stream.close(transformStreamEvents, {
      failed: code !== 0,
      failLabel: acpStopReason || undefined,
      artifacts: finalArtifacts,
    });

    finishRun(run, code === 0 ? 'succeeded' : 'failed');
  });

  return run;
  } // end launchAndTrack

  // 启动首次尝试
  const firstRun = await launchAndTrack(null);
  return c.json({ runId: firstRun.id, conversationId: convId }, 201);
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

    // Subscribe for replay (from lastEventId) + live events
    const send = async (event: string, data: unknown, id: number) => {
      try {
        await streamWriter.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* client disconnected */ }
    };

    // If already finished, just replay and close
    if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
      const missed = await run.stream.replay(lastEventId);
      for (const record of missed) {
        await send(record.event, record.data, record.id);
      }
      return;
    }

    // Subscribe: replay missed + live events (single source)
    const unsub = subscribeRun(run, lastEventId, send);

    // Keep-alive heartbeat
    const heartbeat = setInterval(async () => {
      try { await streamWriter.write(': keepalive\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 15000);

    streamWriter.onAbort(() => {
      clearInterval(heartbeat);
      unsub();
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

// 回答 agent 的 elicitation（ask 选择框）提问。
// 前端渲染选择框后，用户选完答案 POST 到此 endpoint，唤醒挂起的 elicitation handler。
runsRouter.post('/:id/ask/:askId', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  const askId = c.req.param('askId');
  const body = await c.req.json().catch(() => ({}));
  const action = body.action === 'accept' ? 'accept' : 'cancel';
  const content = action === 'accept' ? { value: body.value } : undefined;
  const ok = resolveAsk(run, askId, { action, content });
  if (!ok) return c.json({ error: 'Ask not found or expired' }, 404);
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

// 返回某 conversation 最近一条仍在运行的 run，供前端刷新后恢复轮询。
// 已完成/不存在则返回 null。
runsRouter.get('/conversations/:id/active-run', async (c) => {
  const convId = c.req.param('id');
  const [latest] = await db.select().from(runsTable)
    .where(eq(runsTable.conversationId, convId))
    .orderBy(desc(runsTable.createdAt))
    .limit(1);
  if (!latest || latest.status !== 'running') return c.json({ runId: null });
  return c.json({ runId: latest.id });
});

/**
 * Conversation 级 SSE 流——前端 mount/刷新时的主入口。
 *
 * 一次性排空：推历史 messages + 桥接活跃 RunStream 事件。run 结束后推固化
 * 的完整消息，然后关闭。不是长期连接——用户发新消息时走 sendMessage 的
 * per-run SSE（现有机制不变）。此端点纯粹用于「刷新后追回错过的」场景。
 */
runsRouter.get('/conversations/:id/stream', async (c) => {
  const convId = c.req.param('id');

  return stream(c, async (streamWriter) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const write = async (event: string, data: unknown) => {
      try { await streamWriter.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* disconnected */ }
    };

    // 1. 推历史 messages（已固化的完整对话）
    const historyMsgs = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    for (const m of historyMsgs) {
      await write('message', { id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts });
    }

    // 2. 查活跃 run
    const [latestRun] = await db.select().from(runsTable)
      .where(eq(runsTable.conversationId, convId))
      .orderBy(desc(runsTable.createdAt))
      .limit(1);

    if (!latestRun || latestRun.status !== 'running') {
      // 无活跃 run：历史已推完，一次性流结束
      return;
    }

    const run = getRun(latestRun.id);
    if (!run) return;

    // 3. 桥接活跃 RunStream 事件（重放 fromSeq 0 + 实时推送）
    let unsub: (() => void) | null = null;
    unsub = run.stream.subscribe(0, async (event, data, id) => {
      try { await streamWriter.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch {}
    });

    streamWriter.onAbort(() => { if (unsub) unsub(); });

    // 4. 等 run 结束
    await run.finished;
    await new Promise((r) => setTimeout(r, 100));
    if (unsub) unsub();

    // 5. 推 run 结束后固化的完整 assistant 消息（补充 events/artifacts）
    const finalMsgs = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    const newMsgs = finalMsgs.slice(historyMsgs.length);
    for (const m of newMsgs) {
      await write('message', { id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts });
    }
  });
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

// Create a user milestone snapshot (commit pending changes + tag)
runsRouter.post('/projects/:projectId/snapshot', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);

  const projectDir = await resolveProjectDir(projectId);
  const hash = await createUserSnapshot(projectDir, name);
  if (!hash) return c.json({ error: 'Failed to create snapshot' }, 500);

  return c.json({ ok: true, hash, tag: `milestone-${name}` });
});

export default runsRouter;
