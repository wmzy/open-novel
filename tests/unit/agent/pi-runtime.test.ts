// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { userSettings } from '../../../src/db/schema';
import {
  PI_SETTING_KEYS,
  createPiModelRuntime,
  listPiModels,
  resolvePiModel,
} from '../../../src/agent/pi/config';
import { startPiAgent } from '../../../src/agent/pi/runtime';
import type { StreamEvent } from '../../../src/agent/types';

const PI_KEYS = Object.values(PI_SETTING_KEYS);
let homeDir: string;
let server: http.Server;
let port = 0;

async function setSetting(key: string, value: string) {
  await db.delete(userSettings).where(eq(userSettings.key, key));
  await db.insert(userSettings).values({ id: `pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, key, value });
}

async function clearSettings() {
  for (const key of PI_KEYS) {
    await db.delete(userSettings).where(eq(userSettings.key, key));
  }
}

/** 最小 OpenAI-compatible 流式响应，用于验证 Pi SDK 的真实调用链。 */
function serveFakeCompletion(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = (() => { try { return JSON.parse(body); } catch { return {}; } })();
    const raw = JSON.stringify(payload);
    const wantsAsk = raw.includes('__force_ask__');
    const wantsApi = raw.includes('__force_api__');
    const hasToolResult = Array.isArray(payload.messages)
      && payload.messages.some((m: { role?: string }) => m.role === 'tool' || m.role === 'toolResult');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: Date.now(), model: 'fake-model' };

    if (wantsApi && !hasToolResult) {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
      send({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_api',
              type: 'function',
              function: {
                name: 'open_novel_api',
                arguments: JSON.stringify({
                  method: 'GET',
                  path: '/api/projects/pi-test/templates/outline-brief',
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (wantsApi && hasToolResult) {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'API 已调用。' }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else if (wantsAsk && !hasToolResult) {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
      send({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_ask',
              type: 'function',
              function: {
                name: 'ask',
                arguments: JSON.stringify({
                  questions: [{
                    id: 'q1',
                    question: '选哪个方向？',
                    options: [{ label: 'A', description: '方向 A' }, { label: 'B', description: '方向 B' }],
                  }],
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (wantsAsk && hasToolResult) {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '已收到选择。' }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '你好，' }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { content: '这是 Pi。' }, finish_reason: null }] });
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

beforeAll(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-home-'));
  process.env.OPEN_NOVEL_HOME = homeDir;
  await ensureDbReady();
  await clearSettings();
  server = http.createServer(serveFakeCompletion);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake server address missing');
  port = address.port;
});

beforeEach(async () => {
  await clearSettings();
  await setSetting(PI_SETTING_KEYS.provider, 'custom');
  await setSetting(PI_SETTING_KEYS.model, 'fake-model');
  await setSetting(PI_SETTING_KEYS.api, 'openai-completions');
  await setSetting(PI_SETTING_KEYS.apiKey, 'local');
  await setSetting(PI_SETTING_KEYS.baseUrl, `http://127.0.0.1:${port}/v1`);
});

afterEach(async () => {
  await clearSettings();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.OPEN_NOVEL_HOME;
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe('内置 Pi 配置', () => {
  it('custom provider 可从设置构造并解析模型', async () => {
    await setSetting(PI_SETTING_KEYS.provider, 'custom');
    await setSetting(PI_SETTING_KEYS.model, 'fake-model');
    await setSetting(PI_SETTING_KEYS.baseUrl, `http://127.0.0.1:${port}/v1`);
    const { runtime, settings } = await createPiModelRuntime();
    const model = await resolvePiModel(runtime, settings);
    expect(model.provider).toBe('custom');
    expect(model.id).toBe('fake-model');
    expect(model.contextWindow).toBeGreaterThan(0);

    const listed = await listPiModels();
    expect(listed.provider).toBe('custom');
    expect(listed.models.map((m) => m.id)).toContain('fake-model');
  });

  it('custom provider 缺少 baseUrl 时给出明确错误', async () => {
    await db.delete(userSettings).where(eq(userSettings.key, PI_SETTING_KEYS.baseUrl));
    await expect(createPiModelRuntime()).rejects.toThrow(/Base URL/);
  });
});

describe('startPiAgent', () => {
  it('真实 Pi SDK 调用：流式文本 + usage 事件', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-run-'));
    const events: StreamEvent[] = [];
    try {
      const handle = startPiAgent({
        prompt: '说一句问候',
        cwd,
        model: 'fake-model',
        onEvent: (event) => events.push(event),
      });
      const result = await handle.promise;
      expect(result.code).toBe(0);

      const text = events
        .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
        .map((e) => e.delta)
        .join('');
      expect(text).toBe('你好，这是 Pi。');

      const usage = events.find((e) => e.type === 'usage') as Extract<StreamEvent, { type: 'usage' }> | undefined;
      expect(usage?.usage).toMatchObject({ input_tokens: 12, output_tokens: 5 });
      expect(usage?.costUsd).toBe(0);

      const runtimeUsage = events.find((e) => e.type === 'runtime_usage') as
        | Extract<StreamEvent, { type: 'runtime_usage' }>
        | undefined;
      expect(runtimeUsage?.used).toBe(17);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('模型调用 ask 工具时触发 onAsk 并回传结果', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ask-'));
    const asked: string[] = [];
    const events: StreamEvent[] = [];
    try {
      const handle = startPiAgent({
        prompt: '__force_ask__ 选一个方向',
        cwd,
        model: 'fake-model',
        onEvent: (event) => events.push(event),
        onAsk: async (ask) => {
          asked.push(ask.message);
          expect(ask.options).toEqual(['A（方向 A）', 'B（方向 B）']);
          return { action: 'accept', content: { value: 'A' } };
        },
      });
      const result = await handle.promise;
      expect(result.code).toBe(0);
      expect(asked).toEqual(['选哪个方向？']);
      const text = events
        .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
        .map((e) => e.delta)
        .join('');
      expect(text).toContain('已收到选择');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('注册 open_novel_api 工具并可调用本地 API', async () => {
    const apiServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const address = apiServer.address();
    if (!address || typeof address === 'string') throw new Error('api server address missing');
    const apiPort = address.port;
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-api-'));
    const events: StreamEvent[] = [];
    try {
      const handle = startPiAgent({
        prompt: '__force_api__ 调用模板接口',
        cwd,
        model: 'fake-model',
        allowBash: false,
        api: { baseUrl: `http://127.0.0.1:${apiPort}`, projectId: 'pi-test' },
        onEvent: (event) => events.push(event),
      });
      const result = await handle.promise;
      expect(result.code).toBe(0);
      const toolResult = events.find((e) => e.type === 'tool_result') as
        | Extract<StreamEvent, { type: 'tool_result' }>
        | undefined;
      expect(toolResult?.isError).toBe(false);
      expect(toolResult?.content).toContain('"ok":true');
      const text = events
        .filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
        .map((e) => e.delta)
        .join('');
      expect(text).toContain('API 已调用');
    } finally {
      await new Promise<void>((resolve) => apiServer.close(() => resolve()));
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('取消会 abort session 并返回 aborted', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-abort-'));
    try {
      const handle = startPiAgent({
        prompt: '写很长的一段',
        cwd,
        model: 'fake-model',
        onEvent: () => {},
      });
      handle.abort();
      const result = await handle.promise;
      expect(result.aborted).toBe(true);
      expect(result.code).toBe(1);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
