// @vitest-environment node
/**
 * Pi 配置环境变量回退：Docker / CI / 一次性部署无需先写 user_settings。
 * 优先级：DB 设置 > 通用 PI_* env > provider 专用 env（OPENAI_API_KEY 等）> 默认值。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { userSettings } from '../../../src/db/schema';
import {
  PI_ENV_KEYS,
  PI_SETTING_KEYS,
  readPiSettings,
} from '../../../src/agent/pi/config';

const SETTING_KEYS = Object.values(PI_SETTING_KEYS);
const ENV_KEYS = [
  ...Object.values(PI_ENV_KEYS),
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
];

async function clearDb() {
  await db.delete(userSettings).where(inArray(userSettings.key, SETTING_KEYS));
}

async function setSetting(key: string, value: string) {
  await clearSetting(key);
  await db.insert(userSettings).values({ id: `env_${key}`, key, value });
}

async function clearSetting(key: string) {
  await db.delete(userSettings).where(eq(userSettings.key, key));
}

beforeEach(async () => {
  await ensureDbReady();
  for (const key of ENV_KEYS) delete process.env[key];
  await clearDb();
});

afterAll(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  await clearDb();
});

describe('readPiSettings 环境变量回退', () => {
  it('通用 PI_* 变量填充全部字段', async () => {
    process.env.PI_PROVIDER = 'openai';
    process.env.PI_MODEL = 'gpt-4.1-mini';
    process.env.PI_BASE_URL = 'http://127.0.0.1:8080/v1';
    process.env.PI_API = 'openai-completions';
    process.env.PI_API_KEY = 'env-key';
    process.env.PI_THINKING_LEVEL = 'high';
    process.env.PI_CONTEXT_WINDOW = '64000';
    process.env.PI_MAX_TOKENS = '4096';

    const settings = await readPiSettings();
    expect(settings).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: 'http://127.0.0.1:8080/v1',
      api: 'openai-completions',
      apiKey: 'env-key',
      thinkingLevel: 'high',
      contextWindow: 64_000,
      maxTokens: 4_096,
    });
  });

  it('DB 设置优先于环境变量', async () => {
    process.env.PI_PROVIDER = 'openai';
    process.env.PI_MODEL = 'env-model';
    process.env.PI_API_KEY = 'env-key';
    await setSetting(PI_SETTING_KEYS.provider, 'deepseek');
    await setSetting(PI_SETTING_KEYS.model, 'db-model');
    await setSetting(PI_SETTING_KEYS.apiKey, 'db-key');

    const settings = await readPiSettings();
    expect(settings.provider).toBe('deepseek');
    expect(settings.model).toBe('db-model');
    expect(settings.apiKey).toBe('db-key');
  });

  it('provider 专用 key 仍可推断 provider（无 PI_PROVIDER）', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    const settings = await readPiSettings();
    expect(settings.provider).toBe('openai');
    expect(settings.apiKey).toBe('openai-key');
  });

  it('非法数值回退默认值', async () => {
    process.env.PI_CONTEXT_WINDOW = 'nope';
    process.env.PI_MAX_TOKENS = '-5';
    const settings = await readPiSettings();
    expect(settings.contextWindow).toBe(128_000);
    expect(settings.maxTokens).toBe(16_384);
  });
});
