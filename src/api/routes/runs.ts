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
import { ensureContextArtifacts } from '../../agent/context-manager';
import { createSnapshot, restoreSnapshot, listSnapshots } from '../../agent/snapshot';
import { resolveProjectDir } from '../../shared/project-dir';
import { config } from '../../config';
import { db } from '../../db/drizzle';
import { conversations, messages, runs as runsTable } from '../../db/schema';
import { generateId } from '../../utils/id';
import { eq } from 'drizzle-orm';

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
  const handler = def.streamFormat === 'claude-stream-json'
    ? createClaudeStreamHandler((event) => emitEvent(run, 'agent', event), onStreamComplete)
    : createJsonEventHandler((event) => emitEvent(run, 'agent', event));

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

    // Emit artifact summary event BEFORE finishRun (which clears clients)
    if (writtenPaths.size > 0) {
      emitEvent(run, 'artifacts', {
        count: writtenPaths.size,
        paths: [...writtenPaths],
      });
    }

    finishRun(run, code === 0 ? 'succeeded' : 'failed');

    // Sync file changes back to DB and create snapshot
    const projectDir = await resolveProjectDir(projectId);
    if (writtenPaths.size > 0) {
      await syncFilesToDb(projectId, writtenPaths, projectDir).catch(() => {});
    }

    // 兜底：补全缺失的章节摘要与状态表（仅写作成功时）
    if (code === 0 && writtenPaths.size > 0) {
      await ensureContextArtifacts(projectDir, writtenPaths).catch(() => {});
    }

    // Create git snapshot
    await createSnapshot(projectDir, `Run ${run.id.slice(0, 8)}: ${writtenPaths.size} files modified`).catch(() => {});

    // Update run record
    await db.update(runsTable).set({
      status: run.status,
      finishedAt: new Date(),
    }).where(eq(runsTable.id, run.id)).execute();
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

  return c.json(msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })));
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
