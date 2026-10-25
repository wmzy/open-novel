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
  readStagePiModels,
  resolveStagePiModel,
} from '../../../src/agent/pi/config';
import { startPiAgent } from '../../../src/agent/pi/runtime';

const PI_KEYS = Object.values(PI_SETTING_KEYS);
let homeDir: string;
let server: http.Server;
let port = 0;
/** fake server 收到的请求 model 字段，用于证明实际解析链路选中的模型。 */
const requestedModels: string[] = [];

async function setSetting(key: string, value: string) {
  await db.delete(userSettings).where(eq(userSettings.key, key));
  await db.insert(userSettings).values({ id: `pi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, key, value });
}

async function clearSettings() {
  for (const key of PI_KEYS) {
    await db.delete(userSettings).where(eq(userSettings.key, key));
  }
}

/** 最小 OpenAI-compatible 流式响应；记录请求中的 model 字段。 */
function serveFakeCompletion(req: http.IncomingMessage, res: http.ServerResponse) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let payload: { model?: string } = {};
    try { payload = JSON.parse(body); } catch { /* ignore */ }
    if (typeof payload.model === 'string') requestedModels.push(payload.model);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: Date.now(), model: 'fake-model' };
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] });
    send({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

beforeAll(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stage-home-'));
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
  requestedModels.length = 0;
  // custom provider 只注册 settings.model 这一个模型 → 目录 = ['fake-model']。
  // 阶段模型若配置成其它 ID 会触发 resolvePiModel 的“找不到模型”错误，
  // 借此可以证明解析链路确实采用了阶段配置而非全局。
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

describe('readStagePiModels 宽容解析', () => {
  it('合法 JSON：只保留 7 主阶段键与非空模型值', async () => {
    await setSetting(PI_SETTING_KEYS.stageModels, JSON.stringify({
      concept: ' model-a ',
      writing: 'model-b',
      drafting: 'model-c', // 未知键（子阶段不允许独立配置）→ 丢弃
      outline: '', // 空值 → 丢弃
      world: 42, // 非字符串 → 丢弃
    }));
    const result = await readStagePiModels();
    expect(result).toEqual({ concept: 'model-a', writing: 'model-b' });
  });

  it('损坏 JSON / 非对象 → 空', async () => {
    await setSetting(PI_SETTING_KEYS.stageModels, '{broken json');
    expect(await readStagePiModels()).toEqual({});
    await setSetting(PI_SETTING_KEYS.stageModels, '["concept"]');
    expect(await readStagePiModels()).toEqual({});
    await setSetting(PI_SETTING_KEYS.stageModels, 'null');
    expect(await readStagePiModels()).toEqual({});
  });

  it('未配置 → 空', async () => {
    expect(await readStagePiModels()).toEqual({});
  });
});

describe('resolveStagePiModel', () => {
  beforeEach(async () => {
    await setSetting(PI_SETTING_KEYS.stageModels, JSON.stringify({
      concept: 'model-concept',
      writing: 'model-writing',
    }));
  });

  it('主阶段精确匹配', async () => {
    expect(await resolveStagePiModel('concept')).toBe('model-concept');
  });

  it('写作族子阶段回退 writing', async () => {
    for (const stage of ['drafting', 'revision', 'polish', 'decompose', 'enrich', 'retro']) {
      expect(await resolveStagePiModel(stage)).toBe('model-writing');
    }
  });

  it('未配置的阶段 / 未知阶段 / 未传 stage → undefined（用全局）', async () => {
    expect(await resolveStagePiModel('outline')).toBeUndefined();
    expect(await resolveStagePiModel('no-such-stage')).toBeUndefined();
    expect(await resolveStagePiModel(undefined)).toBeUndefined();
  });

  it('无任何阶段配置 → undefined', async () => {
    await db.delete(userSettings).where(eq(userSettings.key, PI_SETTING_KEYS.stageModels));
    expect(await resolveStagePiModel('concept')).toBeUndefined();
  });
});

describe('runtime 模型优先级（显式 > 阶段 > 全局）', () => {
  it('未配置阶段模型且未显式指定 → 用全局设置模型', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stage-run-'));
    try {
      const result = await startPiAgent({
        prompt: '说一句',
        cwd,
        stage: 'concept',
        onEvent: () => {},
      }).promise;
      expect(result.code).toBe(0);
      expect(requestedModels).toEqual(['fake-model']);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('阶段默认模型参与解析：配置了不在目录中的阶段模型时报错并指明该模型', async () => {
    await setSetting(PI_SETTING_KEYS.stageModels, JSON.stringify({ concept: 'ghost-model' }));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stage-ghost-'));
    try {
      const result = await startPiAgent({
        prompt: '说一句',
        cwd,
        stage: 'concept',
        onEvent: () => {},
      }).promise;
      // 若错误地回退全局 fake-model，这里会成功；报错即证明采用了阶段配置。
      expect(result.code).toBe(1);
      expect(result.error).toContain('ghost-model');
      expect(requestedModels).toEqual([]);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('写作族子阶段经 runtime 回退 writing 的阶段模型', async () => {
    await setSetting(PI_SETTING_KEYS.stageModels, JSON.stringify({ writing: 'ghost-writing-model' }));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stage-family-'));
    try {
      const result = await startPiAgent({
        prompt: '说一句',
        cwd,
        stage: 'polish',
        onEvent: () => {},
      }).promise;
      expect(result.code).toBe(1);
      expect(result.error).toContain('ghost-writing-model');
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  it('显式 model 优先于阶段默认模型', async () => {
    await setSetting(PI_SETTING_KEYS.stageModels, JSON.stringify({ concept: 'ghost-model' }));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stage-explicit-'));
    try {
      const result = await startPiAgent({
        prompt: '说一句',
        cwd,
        model: 'fake-model',
        stage: 'concept',
        onEvent: () => {},
      }).promise;
      // 若阶段模型优先，ghost-model 不在目录中会直接失败。
      expect(result.code).toBe(0);
      expect(requestedModels).toEqual(['fake-model']);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
