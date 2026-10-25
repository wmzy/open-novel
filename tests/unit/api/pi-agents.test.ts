import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq, like } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { userSettings } from '../../../src/db/schema';
import apiApp from '../../../src/api-app';
import { PI_SETTING_KEYS } from '../../../src/agent/pi/config';
import { generateId } from '../../../src/utils/id';

/**
 * 内置 Pi 的 HTTP API 面（`/api/agents`、`/api/settings`）。
 *
 * 全部通过 `apiApp.request` 走真实路由 + PGlite，但不触发任何模型请求：
 * `testPiConfig` 只做配置解析，`GET /api/agents` 只读模型目录。
 *
 * 环境隔离：
 * - 清空 provider 环境变量，避免开发机上的 API Key 让 `available/ok` 变成 true；
 * - `PI_CODING_AGENT_DIR` 指向临时目录，避免读到本机 `~/.pi/agent/auth.json`。
 */

const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
];

const CUSTOM_MODEL_ID = 'unit-test-model';

interface AgentsResponse {
  agents: Array<{
    id: string;
    name: string;
    available: boolean;
    models: Array<{ id: string; label: string }>;
  }>;
}

let tempAgentDir: string;

async function clearPiSettings() {
  await db.delete(userSettings).where(like(userSettings.key, 'pi_%'));
}

async function setPiSetting(key: string, value: string) {
  await db.delete(userSettings).where(eq(userSettings.key, key));
  await db.insert(userSettings).values({ id: generateId('set_'), key, value });
}

/** 写入可离线解析的 custom provider 配置（不会发起真实请求）。 */
async function configureCustomProvider() {
  await setPiSetting(PI_SETTING_KEYS.provider, 'custom');
  await setPiSetting(PI_SETTING_KEYS.model, CUSTOM_MODEL_ID);
  await setPiSetting(PI_SETTING_KEYS.baseUrl, 'http://127.0.0.1:9/v1');
  await setPiSetting(PI_SETTING_KEYS.api, 'openai-completions');
  await setPiSetting(PI_SETTING_KEYS.apiKey, 'local-test-key');
}

async function getAgents(): Promise<AgentsResponse> {
  const res = await apiApp.request('/api/agents');
  expect(res.status).toBe(200);
  return (await res.json()) as AgentsResponse;
}

async function getSettings(): Promise<{ settings: Record<string, string> }> {
  const res = await apiApp.request('/api/settings');
  expect(res.status).toBe(200);
  return (await res.json()) as { settings: Record<string, string> };
}

beforeAll(async () => {
  tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-api-agent-'));
});

afterAll(async () => {
  await fs.rm(tempAgentDir, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', tempAgentDir);
  vi.stubEnv('PI_OFFLINE', '1');
  for (const key of PROVIDER_ENV_KEYS) vi.stubEnv(key, '');
  await ensureDbReady();
  await clearPiSettings();
});

afterEach(async () => {
  await clearPiSettings();
  vi.unstubAllEnvs();
});

describe('GET /api/agents', () => {
  it('只返回内置 pi，且无配置时 available=false', async () => {
    const body = await getAgents();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({
      id: 'pi',
      available: false,
      streamFormat: 'pi-sdk',
    });
    expect(Array.isArray(body.agents[0].models)).toBe(true);
  });

  it('配置 custom provider 后 available=true 且 models 含自定义模型', async () => {
    await configureCustomProvider();

    const body = await getAgents();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].id).toBe('pi');
    expect(body.agents[0].available).toBe(true);
    expect(body.agents[0].models.map((m) => m.id)).toContain(CUSTOM_MODEL_ID);
  });
});

describe('GET /api/agents/pi/models', () => {
  it('返回模型数组（未配置时回退到内置目录）', async () => {
    const res = await apiApp.request('/api/agents/pi/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string; label: string }> };
    expect(Array.isArray(body.models)).toBe(true);
    for (const model of body.models) {
      expect(typeof model.id).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
    }
  });

  it('配置 custom provider 后返回注册的自定义模型', async () => {
    await configureCustomProvider();

    const res = await apiApp.request('/api/agents/pi/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: Array<{ id: string; label: string }> };
    expect(body.models.map((m) => m.id)).toContain(CUSTOM_MODEL_ID);
  });

  it('未知 agent id 返回 404', async () => {
    const res = await apiApp.request('/api/agents/other/models');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/agents/pi/test', () => {
  it('无配置时返回 ok=false、auth=missing', async () => {
    const res = await apiApp.request('/api/agents/pi/test', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      provider: string;
      model: string;
      auth: string;
    };
    expect(body.ok).toBe(false);
    expect(body.auth).toBe('missing');
    expect(body.provider).toBe('anthropic');
  });

  it('配置 custom provider 后返回 ok=true', async () => {
    await configureCustomProvider();

    const res = await apiApp.request('/api/agents/pi/test', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      provider: string;
      model: string;
      auth: string;
    };
    expect(body.ok).toBe(true);
    expect(body.provider).toBe('custom');
    expect(body.model).toBe(`custom/${CUSTOM_MODEL_ID}`);
    expect(body.auth).toBe('configured');
  });
});

describe('/api/settings — Pi 密钥保护', () => {
  it('GET 不返回 pi_api_key 原值，只返回 pi_apiKeySet=true', async () => {
    const secret = 'sk-unit-test-secret-value';
    await setPiSetting(PI_SETTING_KEYS.apiKey, secret);

    const res = await apiApp.request('/api/settings');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(secret);

    const body = JSON.parse(text) as { settings: Record<string, string> };
    expect(body.settings).not.toHaveProperty('pi_api_key');
    expect(body.settings.pi_apiKeySet).toBe('true');
  });

  it('PATCH 空字符串删除密钥，pi_apiKeySet 变为 false', async () => {
    await setPiSetting(PI_SETTING_KEYS.apiKey, 'sk-unit-test-secret-value');

    const patchRes = await apiApp.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pi_api_key: '' }),
    });
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({ ok: true });

    const rows = await db.select().from(userSettings).where(eq(userSettings.key, PI_SETTING_KEYS.apiKey));
    expect(rows).toHaveLength(0);

    const body = await getSettings();
    expect(body.settings).not.toHaveProperty('pi_api_key');
    expect(body.settings.pi_apiKeySet).toBe('false');
  });
});
