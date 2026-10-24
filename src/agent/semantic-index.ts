/**
 * 语义块索引与检索（派生数据层）。
 *
 * 设计要点：
 * - 向量以 real[] 存储，余弦相似度在 JS 侧计算：当前 PGlite 0.5.8 未内置
 *   pgvector（dist 目录无 vector 扩展），统一 real[] 可同时适配 PGlite 与外部
 *   postgres，且无需 CREATE EXTENSION。
 * - 增量：每块存 sha256(content) 与 model；重索引只嵌入新增/变化的块，
 *   未变化章节（哈希序列一致）整章跳过。模型切换时整项目自动重建。
 * - 安全：索引是派生数据，任何失败都不影响正文；搜索失败由调用方回退文本检索。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { semanticChunks } from '../db/schema';
import { resolveNovelDir } from '../shared/project-dir';
import { parseChapterNumber } from '../shared/chapter-names';
import {
  chunkHashesMatch,
  chunkText,
  cosineSimilarity,
  type TextChunk,
} from '../shared/semantic';
import { generateId } from '../utils/id';
import {
  embedTexts,
  readEmbeddingConfig,
  EMBEDDING_INDEX_TIMEOUT_MS,
  EMBEDDING_SEARCH_TIMEOUT_MS,
  type EmbeddingConfig,
} from './embeddings';
import { getActiveRunForProject } from './run';

export type SemanticSource = 'body' | 'summary';

export interface SemanticIndexResult {
  configured: boolean;
  model?: string;
  chaptersScanned: number;
  chaptersIndexed: number;
  chaptersSkipped: number;
  chaptersRemoved: number;
  chunksIndexed: number;
  chunksReused: number;
  chunksRemoved: number;
  embeddedChunks: number;
  durationMs: number;
}

export interface SemanticChunkHit {
  chapterNumber: number;
  source: SemanticSource;
  chunkIndex: number;
  file: string;
  content: string;
  score: number;
}

export interface SemanticSearchResult {
  configured: boolean;
  results: SemanticChunkHit[];
  /** 未配置 / 嵌入调用失败 / 索引为空（含模型维度过期）。 */
  reason?: 'not-configured' | 'embedding-error' | 'index-empty';
}

interface ScannedSource {
  chapterNumber: number;
  source: SemanticSource;
  file: string;
  chunks: TextChunk[];
}

/** 每项目单飞：章节同步/手动重建可能并发触发，同一项目只跑一份索引。 */
const inflightIndexes = new Map<string, Promise<SemanticIndexResult>>();
/** 章节同步后的防抖计时器（每项目一个）。 */
const scheduledIndexes = new Map<string, NodeJS.Timeout>();

/** 章节同步后默认延迟：等待 run 收尾/磁盘写入稳定。 */
const SEMANTIC_INDEX_DEBOUNCE_MS = 4_000;

const SUMMARY_FILE_RE = /^(?:第\s*(\d+)\s*章|chapter-(\d+))\.summary\.md$/i;

function sourceKey(source: SemanticSource, chapterNumber: number): string {
  return `${source}:${chapterNumber}`;
}

async function readText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * 扫描 `.novel/chapters/`：正文与摘要各自分块。
 * 正文优先中文规范命名（第N章.md），兼容旧英文命名（chapter-N.md）。
 */
async function collectScannedSources(novelDir: string): Promise<ScannedSource[]> {
  const chaptersDir = path.join(novelDir, 'chapters');
  let files: string[];
  try {
    files = await fs.readdir(chaptersDir);
  } catch {
    return [];
  }

  const bodyFiles = new Map<number, string>();
  const summaryFiles = new Map<number, string>();

  for (const name of files) {
    const summaryMatch = name.match(SUMMARY_FILE_RE);
    if (summaryMatch) {
      const num = parseInt(summaryMatch[1] ?? summaryMatch[2], 10);
      if (Number.isNaN(num)) continue;
      const existing = summaryFiles.get(num);
      const canonical = `第${num}章.summary.md`;
      if (!existing || name === canonical || (!existing.startsWith('第') && name.startsWith('第'))) {
        summaryFiles.set(num, name);
      }
      continue;
    }
    // parseChapterNumber 已排除 .summary.md / .degraded.md
    const num = parseChapterNumber(name);
    if (num === null) continue;
    const existing = bodyFiles.get(num);
    const canonical = `第${num}章.md`;
    if (!existing || name === canonical || (!existing.startsWith('第') && name.startsWith('第'))) {
      bodyFiles.set(num, name);
    }
  }

  const sources: ScannedSource[] = [];
  const chapterNumbers = [...new Set([...bodyFiles.keys(), ...summaryFiles.keys()])]
    .sort((a, b) => a - b);

  for (const chapterNumber of chapterNumbers) {
    const bodyName = bodyFiles.get(chapterNumber);
    if (bodyName) {
      const content = await readText(path.join(chaptersDir, bodyName));
      const chunks = chunkText(content);
      if (chunks.length > 0) {
        sources.push({
          chapterNumber,
          source: 'body',
          file: `chapters/${bodyName}`,
          chunks,
        });
      }
    }
    const summaryName = summaryFiles.get(chapterNumber);
    if (summaryName) {
      const content = await readText(path.join(chaptersDir, summaryName));
      // `[自动生成]` 是占位摘要标记（非语义摘要），与滚动摘要层一致地跳过，
      // 避免占位文本污染语义召回。
      const chunks = content.includes('[自动生成]') ? [] : chunkText(content);
      if (chunks.length > 0) {
        sources.push({
          chapterNumber,
          source: 'summary',
          file: `chapters/${summaryName}`,
          chunks,
        });
      }
    }
  }

  return sources;
}

/**
 * 重建/增量更新项目语义索引。
 *
 * 显式调用（POST /search/reindex）失败时向上抛错；章节同步后的后台调用
 * 由 scheduleSemanticIndexing 吞掉错误并保留旧索引。
 */
export function indexProjectSemantics(
  projectId: string,
  options?: {
    novelDir?: string;
    config?: EmbeddingConfig | null;
    /** 忽略哈希复用，强制重新嵌入（模型切换不需要，靠 model 字段自动失效）。 */
    force?: boolean;
  },
): Promise<SemanticIndexResult> {
  const existing = inflightIndexes.get(projectId);
  if (existing) return existing;

  const task = runIndex(projectId, options).finally(() => {
    inflightIndexes.delete(projectId);
  });
  inflightIndexes.set(projectId, task);
  return task;
}

async function runIndex(
  projectId: string,
  options?: { novelDir?: string; config?: EmbeddingConfig | null; force?: boolean },
): Promise<SemanticIndexResult> {
  const startedAt = Date.now();
  const config = options?.config !== undefined
    ? options.config
    : await readEmbeddingConfig();

  if (!config) {
    return {
      configured: false,
      chaptersScanned: 0,
      chaptersIndexed: 0,
      chaptersSkipped: 0,
      chaptersRemoved: 0,
      chunksIndexed: 0,
      chunksReused: 0,
      chunksRemoved: 0,
      embeddedChunks: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const novelDir = options?.novelDir ?? await resolveNovelDir(projectId);
  const scanned = await collectScannedSources(novelDir);

  const existingRows = await db
    .select({
      id: semanticChunks.id,
      chapterNumber: semanticChunks.chapterNumber,
      source: semanticChunks.source,
      chunkIndex: semanticChunks.chunkIndex,
      contentHash: semanticChunks.contentHash,
      model: semanticChunks.model,
      embedding: semanticChunks.embedding,
    })
    .from(semanticChunks)
    .where(eq(semanticChunks.projectId, projectId));

  const existingByKey = new Map<string, typeof existingRows>();
  for (const row of existingRows) {
    const key = sourceKey(row.source as SemanticSource, row.chapterNumber);
    const list = existingByKey.get(key);
    if (list) list.push(row);
    else existingByKey.set(key, [row]);
  }

  const scannedKeys = new Set<string>();
  const changed: ScannedSource[] = [];
  let chunksReused = 0;

  for (const source of scanned) {
    const key = sourceKey(source.source, source.chapterNumber);
    scannedKeys.add(key);
    const rows = existingByKey.get(key) ?? [];
    // 必须按 chunkIndex 排序后再比较哈希序列，否则 DB 返回顺序不稳定会导致
    // 未变化章节被误判为变化而重复嵌入。
    const sortedRows = [...rows].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const hashes = sortedRows.map((r) => r.contentHash);
    const modelStale = rows.some((r) => r.model !== config.model);
    if (!options?.force && !modelStale && chunkHashesMatch(hashes, source.chunks)) {
      chunksReused += source.chunks.length;
      continue;
    }
    changed.push(source);
  }

  // 复用旧向量：仅限同一模型且块哈希一致的内容（章节重编号/段落移动也能复用）。
  const vectorByHash = new Map<string, number[]>();
  if (!options?.force) {
    for (const row of existingRows) {
      if (row.model !== config.model) continue;
      if (!Array.isArray(row.embedding) || row.embedding.length === 0) continue;
      if (!vectorByHash.has(row.contentHash)) vectorByHash.set(row.contentHash, row.embedding);
    }
  }

  // 收集所有变化章节中缺向量的唯一块（跨章去重，相同段落只嵌入一次）。
  const pendingByHash = new Map<string, string>();
  for (const source of changed) {
    for (const chunk of source.chunks) {
      if (vectorByHash.has(chunk.hash)) {
        chunksReused++;
        continue;
      }
      if (!pendingByHash.has(chunk.hash)) pendingByHash.set(chunk.hash, chunk.content);
    }
  }

  const pending = [...pendingByHash.entries()];
  if (pending.length > 0) {
    const embeddedVectors = await embedTexts(
      pending.map(([, content]) => content),
      config,
      { timeoutMs: EMBEDDING_INDEX_TIMEOUT_MS },
    );
    for (let i = 0; i < pending.length; i++) {
      const vector = embeddedVectors[i];
      if (!vector || vector.length === 0) {
        throw new Error('嵌入服务返回空向量');
      }
      vectorByHash.set(pending[i][0], vector);
    }
  }

  // 所有向量就绪后才写库：嵌入失败时旧索引保持完整。
  const staleKeys = [...existingByKey.keys()].filter((key) => !scannedKeys.has(key));

  const rowsToInsert: Array<typeof semanticChunks.$inferInsert> = [];
  for (const source of changed) {
    for (const chunk of source.chunks) {
      const vector = vectorByHash.get(chunk.hash);
      if (!vector) continue; // 理论上不会发生：刚嵌入过或已复用
      rowsToInsert.push({
        id: generateId('sem_'),
        projectId,
        chapterNumber: source.chapterNumber,
        source: source.source,
        chunkIndex: chunk.index,
        file: source.file,
        content: chunk.content,
        contentHash: chunk.hash,
        model: config.model,
        embedding: vector,
        dim: vector.length,
      });
    }
  }

  let chunksRemoved = 0;
  for (const key of staleKeys) chunksRemoved += existingByKey.get(key)?.length ?? 0;
  for (const source of changed) {
    chunksRemoved += existingByKey.get(sourceKey(source.source, source.chapterNumber))?.length ?? 0;
  }

  await db.transaction(async (tx) => {
    for (const key of staleKeys) {
      const [source, chapterRaw] = key.split(':');
      const chapterNumber = parseInt(chapterRaw, 10);
      await tx.delete(semanticChunks).where(and(
        eq(semanticChunks.projectId, projectId),
        eq(semanticChunks.source, source),
        eq(semanticChunks.chapterNumber, chapterNumber),
      ));
    }
    for (const source of changed) {
      await tx.delete(semanticChunks).where(and(
        eq(semanticChunks.projectId, projectId),
        eq(semanticChunks.source, source.source),
        eq(semanticChunks.chapterNumber, source.chapterNumber),
      ));
    }
    // 分批插入：Postgres 单条 SQL 参数上限 65535，每行主要开销是向量维度，
    // 按维度反推批次大小（1536 维 → 13 行/批），避免高维模型撞参数上限。
    const dim = rowsToInsert[0]?.dim ?? 1;
    const INSERT_BATCH = Math.max(1, Math.min(50, Math.floor(20_000 / Math.max(1, dim))));
    for (let i = 0; i < rowsToInsert.length; i += INSERT_BATCH) {
      await tx.insert(semanticChunks).values(rowsToInsert.slice(i, i + INSERT_BATCH));
    }
  });

  const scannedChapterNumbers = new Set(scanned.map((s) => s.chapterNumber));
  const changedChapterNumbers = new Set(changed.map((source) => source.chapterNumber));
  const removedChapterNumbers = new Set(
    staleKeys.map((key) => parseInt(key.split(':')[1], 10)).filter((n) => !Number.isNaN(n)),
  );

  return {
    configured: true,
    model: config.model,
    chaptersScanned: scannedChapterNumbers.size,
    chaptersIndexed: changedChapterNumbers.size,
    chaptersSkipped: scannedChapterNumbers.size - changedChapterNumbers.size,
    chaptersRemoved: removedChapterNumbers.size,
    chunksIndexed: rowsToInsert.length,
    chunksReused,
    chunksRemoved,
    embeddedChunks: pending.length,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 语义检索：对查询做嵌入，与项目全部块计算余弦相似度并取 top-k。
 * 未配置/网络失败/索引为空时返回 reason，由路由回退文本搜索。
 */
export async function searchSemanticChunks(
  projectId: string,
  query: string,
  options?: {
    topK?: number;
    minScore?: number;
    /** 只检索小于该章号的章节（上下文注入用于「更早章节」）。 */
    maxChapter?: number;
    config?: EmbeddingConfig | null;
    timeoutMs?: number;
  },
): Promise<SemanticSearchResult> {
  // 多数嵌入模型有 token 上限；查询只用于召回，截断到 4000 字符足够表达意图。
  const trimmed = query.trim().slice(0, 4000);
  if (!trimmed) return { configured: false, results: [], reason: 'not-configured' };

  const config = options?.config !== undefined
    ? options.config
    : await readEmbeddingConfig();
  if (!config) return { configured: false, results: [], reason: 'not-configured' };

  let queryVector: number[];
  try {
    const [vector] = await embedTexts([trimmed], config, {
      timeoutMs: options?.timeoutMs ?? EMBEDDING_SEARCH_TIMEOUT_MS,
      batchSize: 1,
    });
    if (!vector || vector.length === 0) {
      return { configured: true, results: [], reason: 'embedding-error' };
    }
    queryVector = vector;
  } catch {
    return { configured: true, results: [], reason: 'embedding-error' };
  }

  let rows: Array<{
    chapterNumber: number;
    source: string;
    chunkIndex: number;
    file: string;
    content: string;
    model: string;
    embedding: number[];
    dim: number;
  }>;
  try {
    const conditions = [eq(semanticChunks.projectId, projectId)];
    const maxChapter = options?.maxChapter;
    if (maxChapter !== undefined) {
      conditions.push(lt(semanticChunks.chapterNumber, maxChapter));
    }
    rows = await db
      .select({
        chapterNumber: semanticChunks.chapterNumber,
        source: semanticChunks.source,
        chunkIndex: semanticChunks.chunkIndex,
        file: semanticChunks.file,
        content: semanticChunks.content,
        model: semanticChunks.model,
        embedding: semanticChunks.embedding,
        dim: semanticChunks.dim,
      })
      .from(semanticChunks)
      .where(and(...conditions));
  } catch {
    return { configured: true, results: [], reason: 'index-empty' };
  }

  // 模型已切换或维度不一致的旧向量不可比较：视为索引为空，等待重索引。
  const comparable = rows.filter(
    (row) => row.model === config.model && row.dim === queryVector.length,
  );
  if (comparable.length === 0) {
    return { configured: true, results: [], reason: 'index-empty' };
  }

  const minScore = options?.minScore ?? 0.05;
  const topK = Math.max(1, options?.topK ?? 12);
  const hits: SemanticChunkHit[] = [];
  for (const row of comparable) {
    if (!Array.isArray(row.embedding)) continue;
    const score = cosineSimilarity(queryVector, row.embedding);
    if (!Number.isFinite(score) || score < minScore) continue;
    hits.push({
      chapterNumber: row.chapterNumber,
      source: row.source as SemanticSource,
      chunkIndex: row.chunkIndex,
      file: row.file,
      content: row.content,
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return { configured: true, results: hits.slice(0, topK) };
}

/**
 * 章节同步/正文保存后调度一次后台增量索引（非阻塞）。
 *
 * 项目有活跃 run 时跳过：agent 正在写盘，半成品不应进入索引；
 * 下一次章节同步（run 结束后前端会重新拉取 chapters）会再次触发。
 * 未配置嵌入服务时什么都不做——未配置路径与旧行为完全一致。
 */
export function scheduleSemanticIndexing(
  projectId: string,
  delayMs = SEMANTIC_INDEX_DEBOUNCE_MS,
): void {
  if (scheduledIndexes.has(projectId)) return;
  const timer = setTimeout(() => {
    scheduledIndexes.delete(projectId);
    void (async () => {
      try {
        if (getActiveRunForProject(projectId)) return;
        const config = await readEmbeddingConfig();
        if (!config) return;
        await indexProjectSemantics(projectId, { config });
      } catch (err) {
        // 索引是派生数据：失败只影响语义检索，文本检索照旧可用。
        const msg = err instanceof Error ? err.message : 'unknown error';
        console.warn(`[semantic] 后台索引失败（已保留旧索引）：${msg}`);
      }
    })();
  }, delayMs);
  timer.unref?.();
  scheduledIndexes.set(projectId, timer);
}
