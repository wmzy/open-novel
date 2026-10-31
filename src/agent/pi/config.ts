/**
 * 内置 Pi SDK 的配置层。
 *
 * 设置全部落在 `user_settings`，密钥只在服务端读取；运行时通过
 * `ModelRuntime` 的内存凭据注入，不写 `~/.pi/agent/auth.json`。
 *
 * provider 约定：
 * - 内置 provider（anthropic/openai/deepseek/google/openrouter/...）直接使用 Pi 目录；
 * - `custom` 用于本地反向代理 / Ollama / 任意 OpenAI-compatible 网关，
 *   必须提供 baseUrl 与 model。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { userSettings } from '../../db/schema';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { RuntimeModelOption } from '../types';

export const PI_SETTING_KEYS = {
  provider: 'pi_provider',
  model: 'pi_model',
  baseUrl: 'pi_base_url',
  api: 'pi_api',
  apiKey: 'pi_api_key',
  thinkingLevel: 'pi_thinking_level',
  contextWindow: 'pi_context_window',
  maxTokens: 'pi_max_tokens',
  /** 按阶段默认模型：JSON 字符串 `{ [stage]: modelId }`，只允许 7 主阶段键。 */
  stageModels: 'pi_stage_models',
} as const;

/** 密钥类设置：GET /api/settings 不返回原值，只返回 `${key}Set`。 */
export const PI_SECRET_SETTING_KEYS = [PI_SETTING_KEYS.apiKey] as const;

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PiSettings {
  provider: string;
  model: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  thinkingLevel: PiThinkingLevel;
  contextWindow: number;
  maxTokens: number;
}

export const PI_BUILTIN_PROVIDERS = [
  'anthropic',
  'openai',
  'deepseek',
  'google',
  'openrouter',
  'groq',
  'mistral',
  'xai',
  'custom',
] as const;

const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  deepseek: 'deepseek-chat',
  google: 'gemini-2.5-pro',
  openrouter: 'anthropic/claude-sonnet-4',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest',
  xai: 'grok-4',
  custom: '',
};

const DEFAULT_API: Record<string, string> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-responses',
  deepseek: 'openai-completions',
  google: 'google-generative-ai',
  openrouter: 'openai-completions',
  groq: 'openai-completions',
  mistral: 'openai-completions',
  xai: 'openai-completions',
  custom: 'openai-completions',
};

const ENV_KEYS: Array<[string, string]> = [
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['openai', 'OPENAI_API_KEY'],
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['google', 'GEMINI_API_KEY'],
  ['openrouter', 'OPENROUTER_API_KEY'],
  ['groq', 'GROQ_API_KEY'],
  ['mistral', 'MISTRAL_API_KEY'],
  ['xai', 'XAI_API_KEY'],
];

/**
 * 通用环境变量：Docker / CI / 一次性部署无需先写 DB 设置。
 * 优先级：user_settings > 通用 env > provider 专用 env（如 OPENAI_API_KEY）> 默认值。
 * `PI_PROVIDER` 未设置时仍按 provider 专用 key 推断；使用 `PI_API_KEY` 时应同时
 * 设置 `PI_PROVIDER`（否则默认 anthropic）。
 */
export const PI_ENV_KEYS = {
  provider: 'PI_PROVIDER',
  model: 'PI_MODEL',
  baseUrl: 'PI_BASE_URL',
  api: 'PI_API',
  apiKey: 'PI_API_KEY',
  thinkingLevel: 'PI_THINKING_LEVEL',
  contextWindow: 'PI_CONTEXT_WINDOW',
  maxTokens: 'PI_MAX_TOKENS',
} as const;

function readEnv(key: string): string {
  return (process.env[key] ?? '').trim();
}

/** 设置目录只用于 Pi 的资源发现/会话元数据；会话本身是内存态。 */
export function piAgentDir(): string {
  // 显式 Pi 目录（测试/高级部署）优先；否则放在 open-novel 自己的 home 下。
  const explicit = process.env.PI_CODING_AGENT_DIR?.trim();
  const root = process.env.OPEN_NOVEL_HOME || path.join(os.homedir(), '.open-novel');
  const dir = explicit ? path.resolve(explicit) : path.join(root, 'pi-agent');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function asThinkingLevel(value: string | undefined): PiThinkingLevel {
  const allowed: PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return allowed.includes(value as PiThinkingLevel) ? (value as PiThinkingLevel) : 'medium';
}

function asPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** 从环境推断一个初始 provider（首次启动、尚未保存设置时使用）。 */
function detectEnvProvider(): string {
  for (const [provider, envKey] of ENV_KEYS) {
    if (process.env[envKey]?.trim()) return provider;
  }
  return 'anthropic';
}

/** 读取设置；缺失的字段回退到环境变量/Pi 目录默认值。 */
export async function readPiSettings(): Promise<PiSettings> {
  const rows = await db.select().from(userSettings);
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const provider = (
    map.get(PI_SETTING_KEYS.provider)
    || readEnv(PI_ENV_KEYS.provider)
    || detectEnvProvider()
  ).trim();
  const envKey = ENV_KEYS.find(([id]) => id === provider)?.[1];
  const apiKey = (
    map.get(PI_SETTING_KEYS.apiKey)
    || readEnv(PI_ENV_KEYS.apiKey)
    || (envKey ? readEnv(envKey) : '')
    || ''
  ).trim();

  return {
    provider,
    model: (map.get(PI_SETTING_KEYS.model) || readEnv(PI_ENV_KEYS.model) || DEFAULT_MODEL[provider] || '').trim(),
    baseUrl: (map.get(PI_SETTING_KEYS.baseUrl) || readEnv(PI_ENV_KEYS.baseUrl)).trim(),
    api: (map.get(PI_SETTING_KEYS.api) || readEnv(PI_ENV_KEYS.api) || DEFAULT_API[provider] || 'openai-completions').trim(),
    apiKey,
    thinkingLevel: asThinkingLevel(map.get(PI_SETTING_KEYS.thinkingLevel) || readEnv(PI_ENV_KEYS.thinkingLevel)),
    contextWindow: asPositiveInt(map.get(PI_SETTING_KEYS.contextWindow) || readEnv(PI_ENV_KEYS.contextWindow), 128_000),
    maxTokens: asPositiveInt(map.get(PI_SETTING_KEYS.maxTokens) || readEnv(PI_ENV_KEYS.maxTokens), 16_384),
  };
}

/**
 * 构造 Pi ModelRuntime。
 *
 * - 自定义 provider 必须注册模型元数据（Pi 需要 contextWindow/maxTokens/cost）；
 * - 内置 provider 可以用 baseUrl 覆盖（反代），密钥走运行时注入；
 * - 未配置密钥时仍返回 runtime，便于模型列表/设置页显示，实际调用会给出明确错误。
 */
export async function createPiModelRuntime(): Promise<{ runtime: ModelRuntime; settings: PiSettings }> {
  const settings = await readPiSettings();
  const runtime = await ModelRuntime.create({
    // 只用 open-novel 设置里的凭据，不读取 ~/.pi/agent/auth.json。
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });

  const provider = settings.provider || 'anthropic';

  if (provider === 'custom') {
    if (!settings.baseUrl) {
      throw new Error('自定义 provider 需要填写 API Base URL（例如本地反向代理 http://127.0.0.1:8080/v1）');
    }
    const modelId = settings.model || 'default';
    runtime.registerProvider('custom', {
      name: '自定义 / 本地反代',
      baseUrl: settings.baseUrl,
      api: settings.api || 'openai-completions',
      apiKey: settings.apiKey || 'local',
      models: [
        {
          id: modelId,
          name: modelId,
          api: settings.api || 'openai-completions',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: settings.contextWindow,
          maxTokens: settings.maxTokens,
        },
      ],
    });
    return { runtime, settings };
  }

  if (settings.baseUrl) {
    // 例如把 anthropic 指向本地反代：保留内置模型目录，只改 endpoint。
    runtime.registerProvider(provider, {
      baseUrl: settings.baseUrl,
      api: settings.api || DEFAULT_API[provider],
    });
  }
  if (settings.apiKey) {
    await runtime.setRuntimeApiKey(provider, settings.apiKey);
  }
  return { runtime, settings };
}

/**
 * 解析本次 run 使用的模型。
 *
 * 明确指定的 model 找不到时直接报错（避免静默降级到另一个模型）；
 * 未指定时优先取“有凭据的模型”，否则取目录第一项。
 */
export async function resolvePiModel(
  runtime: ModelRuntime,
  settings: PiSettings,
): Promise<NonNullable<ReturnType<ModelRuntime['getModel']>>> {
  const provider = settings.provider || 'anthropic';
  if (settings.model) {
    const model = runtime.getModel(provider, settings.model);
    if (model) return model;
    throw new Error(`未找到模型 ${provider}/${settings.model}；请检查模型 ID 或 provider 配置`);
  }

  const available = await runtime.getAvailable(provider);
  if (available[0]) return available[0] as NonNullable<ReturnType<ModelRuntime['getModel']>>;

  const all = runtime.getModels(provider);
  if (all[0]) return all[0] as NonNullable<ReturnType<ModelRuntime['getModel']>>;

  throw new Error(`provider ${provider} 没有可用模型；请在设置中填写模型 ID`);
}

/** 设置页/对话面板的模型下拉。优先返回有凭据的模型，否则返回完整目录。 */
export async function listPiModels(): Promise<{ provider: string; models: RuntimeModelOption[]; configured: boolean }> {
  const { runtime, settings } = await createPiModelRuntime();
  const provider = settings.provider || 'anthropic';
  const available = await runtime.getAvailable(provider);
  const models = (available.length > 0 ? available : runtime.getModels(provider)).map((model) => ({
    id: model.id,
    label: model.name || model.id,
  }));
  const configured = provider === 'custom' ? Boolean(settings.baseUrl) : Boolean(settings.apiKey);
  return { provider, models, configured };
}

/**
 * 配置检查：不调用模型，只验证 provider/model/auth 是否可解析。
 * 给设置页“测试连接”使用，避免产生一次生成费用。
 */
export async function testPiConfig(): Promise<{
  ok: boolean;
  provider: string;
  model: string;
  auth: string;
  message: string;
}> {
  const { runtime, settings } = await createPiModelRuntime();
  const model = await resolvePiModel(runtime, settings);
  const auth = await runtime.getAuth(model);
  const configured = runtime.hasConfiguredAuth(settings.provider);
  return {
    ok: Boolean(auth) || settings.provider === 'custom',
    provider: settings.provider,
    model: `${model.provider}/${model.id}`,
    auth: configured ? 'configured' : 'missing',
    message: configured || settings.provider === 'custom'
      ? '配置可解析；实际连通性由首次生成请求验证'
      : '未检测到 API Key；请在设置中填写，或设置对应环境变量',
  };
}

/** 仅供测试/路由使用的轻量查询。 */
export async function getPiSetting(key: string): Promise<string | undefined> {
  const [row] = await db.select().from(userSettings).where(eq(userSettings.key, key)).limit(1);
  return row?.value;
}

/** 7 个主阶段：pi_stage_models 的合法键。 */
export const PI_MAIN_STAGES = [
  'concept',
  'world',
  'characters',
  'outline',
  'scenes',
  'sample',
  'writing',
] as const;

export type PiMainStage = (typeof PI_MAIN_STAGES)[number];

/** 写作族子阶段：没有独立模型配置，统一回退 writing 的阶段默认模型。 */
const WRITING_FAMILY_STAGES = new Set(['drafting', 'revision', 'polish', 'decompose', 'enrich', 'retro']);

/**
 * 读取按阶段默认模型（pi_stage_models）。
 *
 * 宽容解析：损坏 JSON / 非对象 → 空（回退全局）；未知阶段键丢弃；
 * 空模型值丢弃——避免把无效配置带进模型解析链路。
 */
export async function readStagePiModels(): Promise<Partial<Record<PiMainStage, string>>> {
  const raw = await getPiSetting(PI_SETTING_KEYS.stageModels);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const source = parsed as Record<string, unknown>;
  const result: Partial<Record<PiMainStage, string>> = {};
  for (const stage of PI_MAIN_STAGES) {
    const value = source[stage];
    if (typeof value === 'string' && value.trim()) result[stage] = value.trim();
  }
  return result;
}

/**
 * 解析某阶段应使用的默认模型 ID。
 *
 * 精确匹配主阶段 → 写作族子阶段（drafting/revision/polish/decompose/enrich/retro）
 * 回退 writing → 其余（含未知/未传 stage）返回 undefined，表示用全局设置。
 */
export async function resolveStagePiModel(stage: string | undefined): Promise<string | undefined> {
  if (!stage) return undefined;
  const stageModels = await readStagePiModels();
  const exact = stageModels[stage as PiMainStage];
  if (exact) return exact;
  if (WRITING_FAMILY_STAGES.has(stage)) return stageModels.writing;
  return undefined;
}
