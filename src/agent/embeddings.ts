/**
 * OpenAI 兼容嵌入服务客户端与配置读取。
 *
 * 安全约束：API Key 只从 user_settings 读出后放进 Authorization 头，
 * 绝不写日志、绝不进入抛出的错误消息、绝不经设置 GET 回显。
 *
 * 默认关闭：未配置 baseUrl/model 时 readEmbeddingConfig() 返回 null，
 * 所有语义功能静默退回文本路径。
 */

import { inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { userSettings } from '../db/schema';
import {
  EMBEDDING_SETTING_KEYS,
  embeddingsEndpoint,
  normalizeEmbeddingConfig,
  type EmbeddingConfig,
} from '../shared/semantic';

export type { EmbeddingConfig } from '../shared/semantic';

/** 索引批处理的单次请求超时（毫秒）。 */
export const EMBEDDING_INDEX_TIMEOUT_MS = 15_000;
/** 搜索/上下文注入的单次请求超时（毫秒）——必须短于写作 run 的等待耐心。 */
export const EMBEDDING_SEARCH_TIMEOUT_MS = 8_000;
/** 每批送入嵌入服务的文本数。 */
export const EMBEDDING_BATCH_SIZE = 32;

export type EmbeddingErrorCode =
  | 'http'
  | 'network'
  | 'timeout'
  | 'invalid-response';

/** 嵌入服务错误。消息只含状态码/类别，不含 URL、请求体或密钥。 */
export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;

  constructor(code: EmbeddingErrorCode, message: string) {
    super(message);
    this.name = 'EmbeddingError';
    this.code = code;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 读取当前嵌入配置。任何缺项（未启用 / 未配置地址或模型 / 地址非法）
 * 都返回 null，调用方据此完全跳过网络与向量计算。
 */
export async function readEmbeddingConfig(): Promise<EmbeddingConfig | null> {
  try {
    const keys = Object.values(EMBEDDING_SETTING_KEYS);
    const rows = await db
      .select({ key: userSettings.key, value: userSettings.value })
      .from(userSettings)
      .where(inArray(userSettings.key, keys));
    const map: Record<string, string> = {};
    for (const row of rows) map[row.key] = row.value;
    return normalizeEmbeddingConfig(map);
  } catch {
    // DB 未就绪 / 测试环境缺表：语义功能视为未配置，不阻断主流程。
    return null;
  }
}

/**
 * 将设置值按批发送到 `{baseUrl}/embeddings`。
 *
 * 返回顺序与入参一致；任何一批失败都会抛 EmbeddingError（调用方保留旧索引）。
 * `fetchImpl` 仅用于测试注入。
 */
export async function embedTexts(
  texts: readonly string[],
  config: EmbeddingConfig,
  options?: { timeoutMs?: number; batchSize?: number; fetchImpl?: FetchLike },
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const timeoutMs = options?.timeoutMs ?? EMBEDDING_INDEX_TIMEOUT_MS;
  const batchSize = Math.max(1, options?.batchSize ?? EMBEDDING_BATCH_SIZE);
  const fetchImpl: FetchLike = options?.fetchImpl ?? ((input, init) => fetch(input, init));

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const batchVectors = await requestEmbeddingBatch(batch, config, fetchImpl, timeoutMs);
    const dim = vectors[0]?.length ?? batchVectors[0]?.length ?? 0;
    if (batchVectors.some((vector) => vector.length !== dim)) {
      throw new EmbeddingError('invalid-response', '嵌入服务跨批次返回向量维度不一致');
    }
    vectors.push(...batchVectors);
  }
  return vectors;
}

async function requestEmbeddingBatch(
  batch: readonly string[],
  config: EmbeddingConfig,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<number[][]> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let response: Response;
  try {
    response = await fetchImpl(embeddingsEndpoint(config.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, input: batch }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new EmbeddingError('timeout', `嵌入服务请求超时（${timeoutMs}ms）`);
    }
    throw new EmbeddingError('network', '嵌入服务网络请求失败');
  }

  if (!response.ok) {
    throw new EmbeddingError('http', `嵌入服务返回 HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new EmbeddingError('invalid-response', '嵌入服务响应不是合法 JSON');
  }

  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== batch.length) {
    throw new EmbeddingError('invalid-response', '嵌入服务返回数量与请求不一致');
  }

  // OpenAI 约定 data[i].index；缺失时按返回顺序使用。
  const ordered = [...data].sort((a, b) => {
    const ai = typeof (a as { index?: unknown })?.index === 'number'
      ? (a as { index: number }).index
      : 0;
    const bi = typeof (b as { index?: unknown })?.index === 'number'
      ? (b as { index: number }).index
      : 0;
    return ai - bi;
  });

  let dim = -1;
  return ordered.map((item) => {
    const embedding = (item as { embedding?: unknown })?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new EmbeddingError('invalid-response', '嵌入服务返回空向量');
    }
    if (dim === -1) dim = embedding.length;
    if (embedding.length !== dim) {
      throw new EmbeddingError('invalid-response', '嵌入服务返回向量维度不一致');
    }
    const vector = embedding.map((v) => (typeof v === 'number' ? v : Number(v)));
    if (vector.some((v) => !Number.isFinite(v))) {
      throw new EmbeddingError('invalid-response', '嵌入服务返回非数值向量');
    }
    return vector;
  });
}
