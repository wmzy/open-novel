/**
 * 语义检索共享基础件：文本分块 / 内容哈希 / 余弦相似度 / 嵌入配置解析。
 *
 * 该模块只做纯计算（除 node:crypto 哈希外无副作用），供索引、搜索、
 * 上下文注入与单元测试共用。浏览器端不导入（设置页只读写字符串键）。
 */

import { createHash } from 'node:crypto';

// ===== 配置键 =====

/**
 * 嵌入服务配置存放在 user_settings（key/value 字符串），与 preferred_agent 等
 * 现有设置同一机制。默认关闭：未同时配置 baseUrl 与 model 时不启用语义检索。
 */
export const EMBEDDING_SETTING_KEYS = {
  enabled: 'embedding_enabled',
  baseUrl: 'embedding_baseUrl',
  model: 'embedding_model',
  apiKey: 'embedding_apiKey',
} as const;

/** 密钥类设置：读取设置时必须脱敏，任何日志/响应都不得回显。 */
export const EMBEDDING_SECRET_SETTING_KEYS: readonly string[] = [
  EMBEDDING_SETTING_KEYS.apiKey,
];

export interface EmbeddingConfig {
  /** 已去除尾部斜杠的 OpenAI 兼容服务地址（如 https://api.openai.com/v1）。 */
  baseUrl: string;
  model: string;
  /** 本地服务可省略；该值绝不允许回传前端或写日志。 */
  apiKey: string | null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 从设置键值对解析嵌入配置。
 * - `embedding_enabled` 显式为 false/0/off 时强制关闭；
 * - baseUrl 或 model 缺失 / baseUrl 非 http(s) → 视为未配置（null）；
 * - apiKey 可留空（Ollama 等本地服务无需鉴权）。
 */
export function normalizeEmbeddingConfig(
  raw: Record<string, string | undefined>,
): EmbeddingConfig | null {
  const enabled = (raw[EMBEDDING_SETTING_KEYS.enabled] ?? '').trim().toLowerCase();
  if (enabled === 'false' || enabled === '0' || enabled === 'off') return null;

  const baseUrl = (raw[EMBEDDING_SETTING_KEYS.baseUrl] ?? '').trim().replace(/\/+$/, '');
  const model = (raw[EMBEDDING_SETTING_KEYS.model] ?? '').trim();
  if (!baseUrl || !model || !isHttpUrl(baseUrl)) return null;

  const apiKey = (raw[EMBEDDING_SETTING_KEYS.apiKey] ?? '').trim() || null;
  return { baseUrl, model, apiKey };
}

/** 由 baseUrl 得到 OpenAI 兼容的 /embeddings 端点（已带该后缀时不再重复拼接）。 */
export function embeddingsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/embeddings$/i.test(trimmed) ? trimmed : `${trimmed}/embeddings`;
}

// ===== 文本分块 =====

/** 单个分块目标长度（字符数；中文 1 字 = 1）。 */
export const SEMANTIC_CHUNK_MAX_CHARS = 600;
/** 相邻分块重叠字符数：保留跨段上下文，避免关键句被切断。 */
export const SEMANTIC_CHUNK_OVERLAP_CHARS = 80;
/** 单章单来源（正文/摘要）最多分块数，防止异常超大文件拖垮索引。 */
export const SEMANTIC_MAX_CHUNKS_PER_SOURCE = 200;

export interface TextChunk {
  index: number;
  content: string;
  /** sha256(content) —— 增量索引按块哈希判定是否复用向量。 */
  hash: string;
}

/** 内容哈希（sha256 十六进制），用于增量索引。 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 段落内超长文本按句读标点切分；找不到标点时硬切。
 * 返回片段长度均不超过 maxChars。
 */
function splitOversizedParagraph(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > maxChars) {
    const lowerBound = Math.max(1, Math.floor(maxChars * 0.6));
    let cut = -1;
    for (let i = maxChars; i >= lowerBound; i--) {
      if (/[。！？!?；;，,、\s]/.test(rest[i - 1])) {
        cut = i;
        break;
      }
    }
    if (cut <= 0) cut = maxChars;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * 将章节正文/摘要切分为带重叠的语义块。
 *
 * - 优先在段落边界切分；单段超长时退回句读边界；
 * - 块间重叠 `overlapChars`，便于跨段语义检索；
 * - 每块计算 sha256 哈希，索引器据此只嵌入新增/变化的内容；
 * - 空文本返回空数组，块数受 `maxChunks` 限制。
 */
export function chunkText(
  text: string,
  options?: { maxChars?: number; overlapChars?: number; maxChunks?: number },
): TextChunk[] {
  const maxChars = Math.max(50, options?.maxChars ?? SEMANTIC_CHUNK_MAX_CHARS);
  const overlapChars = Math.min(
    Math.max(0, options?.overlapChars ?? SEMANTIC_CHUNK_OVERLAP_CHARS),
    maxChars - 1,
  );
  const maxChunks = Math.max(1, options?.maxChunks ?? SEMANTIC_MAX_CHUNKS_PER_SOURCE);

  const normalized = text.replace(/\r\n?/g, '\n').replace(/\0/g, '').trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const blocks: string[] = [];
  let current = '';
  let previous = '';

  const flush = () => {
    if (!current) return;
    blocks.push(current);
    previous = current;
    current = '';
    if (blocks.length >= maxChunks) return;
  };

  for (const paragraph of paragraphs) {
    if (blocks.length >= maxChunks) break;
    const units = paragraph.length > maxChars
      ? splitOversizedParagraph(paragraph, maxChars)
      : [paragraph];

    for (const unit of units) {
      if (blocks.length >= maxChunks) break;
      if (!current) {
        current = unit;
        continue;
      }
      const sep = '\n\n';
      if (current.length + sep.length + unit.length <= maxChars) {
        current += sep + unit;
        continue;
      }

      flush();
      if (blocks.length >= maxChunks) break;

      // 重叠窗口：从已输出块尾部取至多 overlapChars，且给新段落留足空间。
      const room = maxChars - unit.length - sep.length;
      const tailLen = Math.min(overlapChars, room);
      const tail = room > 0 && tailLen > 0 && previous
        ? previous.slice(-tailLen)
        : '';
      current = tail ? `${tail}${sep}${unit}` : unit;
    }
  }
  flush();

  return blocks.slice(0, maxChunks).map((content, index) => ({
    index,
    content,
    hash: hashText(content),
  }));
}

/**
 * 判断已存索引的哈希序列是否与当前分块完全一致。
 * 增量索引据此整章跳过：长度或任一位置哈希变化都视为需要重建。
 */
export function chunkHashesMatch(
  existingHashes: readonly string[],
  chunks: readonly Pick<TextChunk, 'hash'>[],
): boolean {
  if (existingHashes.length !== chunks.length) return false;
  for (let i = 0; i < chunks.length; i++) {
    if (existingHashes[i] !== chunks[i].hash) return false;
  }
  return true;
}

// ===== 相似度 =====

/**
 * 余弦相似度。维度不一致、包含非有限数值或零向量时返回 0，
 * 使跨模型/损坏向量不会污染排序。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
