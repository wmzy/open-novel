// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, ensureDbReady } from '../../src/db/drizzle';
import { projects, runs as runsTable, userSettings } from '../../src/db/schema';
import apiApp from '../../src/api-app';
import { getRun } from '../../src/agent/run';
import { PI_SETTING_KEYS } from '../../src/agent/pi/config';

const PROJECT_ID = 'pi_e2e_project';
let tempDir: string;
let homeDir: string;
let server: http.Server;
let port = 0;

async function setSetting(key: string, value: string) {
  await db.delete(userSettings).where(eq(userSettings.key, key));
  await db.insert(userSettings).values({
    id: `pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key,
    value,
  });
}

/**
 * Fake OpenAI-compatible endpoint:
 * 1. first request → write tool call（落盘 concept 文件）
 * 2. tool result 后的请求 → 最终文本
 */
function serve(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = (() => { try { return JSON.parse(body); } catch { return {}; } })();
    const hasToolResult = Array.isArray(payload.messages)
      && payload.messages.some((m: { role?: string }) => m.role === 'tool' || m.role === 'toolResult');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: Date.now(), model: 'fake-model' };
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    if (!hasToolResult) {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
      send({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_write',
              type: 'function',
              function: {
                name: 'write',
                arguments: JSON.stringify({
                  path: '.novel/concept/index.md',
                  content: '# 概念\n\n这是一次 Pi 端到端测试。\n',
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '概念已写入。' }, finish_reason: null }] });
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

beforeAll(async () => {
  await ensureDbReady();
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-e2e-home-'));
  process.env.OPEN_NOVEL_HOME = homeDir;
  server = http.createServer(serve);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake server address missing');
  port = address.port;
});

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-e2e-project-'));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(userSettings).where(eq(userSettings.key, PI_SETTING_KEYS.provider));
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: 'Pi E2E',
    path: tempDir,
    genre: 'novel',
    targetWords: 1000,
    chapterCount: 1,
    currentStage: 'concept',
  });
  await setSetting(PI_SETTING_KEYS.provider, 'custom');
  await setSetting(PI_SETTING_KEYS.model, 'fake-model');
  await setSetting(PI_SETTING_KEYS.api, 'openai-completions');
  await setSetting(PI_SETTING_KEYS.apiKey, 'local');
  await setSetting(PI_SETTING_KEYS.baseUrl, `http://127.0.0.1:${port}/v1`);
});

afterEach(async () => {
  for (const key of Object.values(PI_SETTING_KEYS)) {
    await db.delete(userSettings).where(eq(userSettings.key, key));
  }
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await fs.rm(tempDir, { recursive: true, force: true });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.OPEN_NOVEL_HOME;
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('POST /api/runs with built-in Pi', () => {
  it('完成一次真实 run：工具写盘、最终文本、usage、DB status', async () => {
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        agentId: 'pi',
        stage: 'concept',
        message: '写一个概念',
        skillId: 'novel',
      }),
    });
    expect(res.status).toBe(201);
    const { runId } = await res.json() as { runId: string };
    const run = getRun(runId);
    expect(run).toBeTruthy();
    await run!.finished;

    const [row] = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
    expect(row?.status).toBe('succeeded');

    const content = await fs.readFile(path.join(tempDir, '.novel', 'concept', 'index.md'), 'utf-8');
    expect(content).toContain('Pi 端到端测试');

    const events = await run!.stream.replay(0);
    const agentEvents = events.filter((e) => e.event === 'agent').map((e) => e.data as { type?: string });
    expect(agentEvents.some((e) => e.type === 'text_delta')).toBe(true);
    expect(agentEvents.some((e) => e.type === 'tool_use')).toBe(true);
    const usages = agentEvents.filter((e) => e.type === 'usage') as Array<{ usage?: { input_tokens?: number } }>;
    expect(usages.some((u) => u.usage?.input_tokens === 20)).toBe(true);
  }, 30_000);

  it('缺少模型配置时 run 失败且错误可见', async () => {
    await db.delete(userSettings).where(eq(userSettings.key, PI_SETTING_KEYS.baseUrl));
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        agentId: 'pi',
        stage: 'concept',
        message: '写一个概念',
        skillId: 'novel',
      }),
    });
    expect(res.status).toBe(201);
    const { runId } = await res.json() as { runId: string };
    const run = getRun(runId);
    await run!.finished;
    const [row] = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
    expect(row?.status).toBe('failed');
  }, 30_000);
});
