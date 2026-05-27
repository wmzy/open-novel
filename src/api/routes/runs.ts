import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createRun, getRun, emitEvent, finishRun, cancelRun, subscribeRun } from '../../agent/run';
import { getAgentDef } from '../../agent/registry';
import { detectAgents } from '../../agent/detection';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler, createJsonEventHandler } from '../../agent/stream-parser';
import { db } from '../../db/drizzle';
import { conversations, messages, runs as runsTable } from '../../db/schema';
import { generateId } from '../../utils/id';
import { eq } from 'drizzle-orm';

const runsRouter = new Hono();

runsRouter.post('/', async (c) => {
  const body = await c.req.json();
  const { projectId, agentId, skillId, stage, message } = body;

  const def = getAgentDef(agentId);
  if (!def) return c.json({ error: 'Agent not found' }, 404);

  const agents = await detectAgents();
  const detected = agents.find((a) => a.id === agentId);
  if (!detected?.available) return c.json({ error: 'Agent not available' }, 400);

  // Create conversation and message in DB
  const convId = generateId('conv_');
  await db.insert(conversations).values({ id: convId, projectId, agentId, stage });
  const msgId = generateId('msg_');
  await db.insert(messages).values({ id: msgId, conversationId: convId, role: 'user', content: message });

  const run = createRun({ projectId, agentId, skillId, stage });

  // Store run in DB
  await db.insert(runsTable).values({ id: run.id, conversationId: convId, agent: agentId, status: 'running' });

  // Compose prompt (simplified - will be enhanced in Task 14)
  const composedPrompt = message;

  // Launch agent
  const { child } = launchAgent(def, composedPrompt, `./data/projects/${projectId}`);
  run.child = child;
  run.status = 'running';

  // Parse stream
  const handler = def.streamFormat === 'claude-stream-json'
    ? createClaudeStreamHandler((event) => emitEvent(run, 'agent', event))
    : createJsonEventHandler((event) => emitEvent(run, 'agent', event));

  child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => emitEvent(run, 'stderr', { text: chunk.toString() }));

  child.on('close', (code) => {
    handler.flush();
    finishRun(run, code === 0 ? 'succeeded' : 'failed');
    db.update(runsTable).set({ status: run.status, finishedAt: new Date() }).where(eq(runsTable.id, run.id)).execute();
  });

  return c.json({ runId: run.id }, 201);
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

    // Replay missed events
    for (const record of run.events) {
      if (record.id > lastEventId) {
        await streamWriter.write(`id: ${record.id}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`);
      }
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

    // Wait until run finishes
    while (!['succeeded', 'failed', 'canceled'].includes(run.status)) {
      await new Promise((r) => setTimeout(r, 100));
    }
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

export default runsRouter;
