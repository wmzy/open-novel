import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveNovelDir } from '../../shared/project-dir';
import { getActiveRunForProject } from '../../agent/run';
import { readEmbeddingConfig, EmbeddingError } from '../../agent/embeddings';
import {
  indexProjectSemantics,
  searchSemanticChunks,
  type SemanticChunkHit,
} from '../../agent/semantic-index';

const searchRouter = new Hono();

interface SearchResult {
  file: string;
  line: number;
  text: string;
  context: string;
  /** 语义命中附加字段 */
  chapter?: number;
  source?: 'body' | 'summary';
  score?: number;
  match?: 'text' | 'semantic';
}

type SearchMode = 'text' | 'semantic' | 'hybrid';

// Full-text search across project files
searchRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId') || '';
  const query = c.req.query('q');
  if (!query) return c.json({ error: 'q is required' }, 400);

  const rawMode = c.req.query('mode');
  if (rawMode !== undefined && rawMode !== 'text' && rawMode !== 'semantic' && rawMode !== 'hybrid') {
    return c.json({ error: 'invalid mode (text|semantic|hybrid)' }, 400);
  }
  const mode: SearchMode = (rawMode ?? 'text') as SearchMode;

  let projectDir: string;
  try {
    projectDir = await resolveNovelDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  // 默认（未传 mode）保持旧契约与旧结果：仅逐行文本匹配，响应不新增字段。
  if (rawMode === undefined || mode === 'text') {
    const results = await collectTextResults(projectDir, query);
    return c.json({ query, results: results.slice(0, 50) });
  }

  const semantic = await searchSemanticChunks(projectId, query, { topK: 20 });

  if (mode === 'semantic') {
    if (!semantic.configured || semantic.reason) {
      const textResults = await collectTextResults(projectDir, query);
      return c.json({
        query,
        mode,
        results: textResults.slice(0, 50),
        fallback: semantic.reason ?? 'not-configured',
      });
    }
    const results = await mapSemanticHits(projectDir, semantic.results);
    return c.json({ query, mode, results, fallback: null });
  }

  // hybrid：语义命中在前，文本命中补充（去重后限制 50 条）。
  const textResults = (await collectTextResults(projectDir, query))
    .map((r) => ({ ...r, match: 'text' as const }));
  const semanticResults = semantic.configured && !semantic.reason
    ? await mapSemanticHits(projectDir, semantic.results)
    : [];

  const merged = dedupeResults([...semanticResults, ...textResults]).slice(0, 50);
  return c.json({
    query,
    mode,
    results: merged,
    fallback: semantic.reason ?? null,
  });
});

/**
 * 手动重建项目语义索引。
 *
 * 与所有写路径一致：项目有活跃 run 时 409；嵌入服务调用失败时保留旧索引
 * 并返回 502（客户端可回退文本检索，不影响写作）。
 */
searchRouter.post('/reindex', async (c) => {
  const projectId = c.req.param('projectId') || '';

  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再重建索引',
      runId: activeRun.id,
    }, 409);
  }

  try {
    await resolveNovelDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const config = await readEmbeddingConfig();
  if (!config) {
    return c.json({
      error: 'embedding-not-configured',
      message: '未配置嵌入服务。请在「设置 → 语义检索」填写 Base URL 与模型后重试。',
    }, 400);
  }

  try {
    const force = c.req.query('force') === 'true';
    const result = await indexProjectSemantics(projectId, { config, force });
    return c.json({ ok: true, ...result });
  } catch (err) {
    const embeddingFailure = err instanceof EmbeddingError;
    return c.json({
      error: embeddingFailure ? 'embedding-request-failed' : 'reindex-failed',
      message: embeddingFailure
        ? '嵌入服务调用失败，已保留原有索引；语义检索将暂时回退为文本检索。'
        : '索引重建失败，已保留原有索引；请检查数据库状态后重试。',
    }, 502);
  }
});

async function collectTextResults(projectDir: string, query: string): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  try {
    await searchDirectory(projectDir, '', query.toLowerCase(), results);
  } catch { /* ignore search errors */ }
  return results;
}

/** 语义块映射为前端现有结果结构（file/line/text/context），并附加章号与分数。 */
async function mapSemanticHits(
  projectDir: string,
  hits: SemanticChunkHit[],
): Promise<SearchResult[]> {
  const fileCache = new Map<string, string>();
  const results: SearchResult[] = [];

  for (const hit of hits) {
    let content = fileCache.get(hit.file);
    if (content === undefined) {
      try {
        content = await fs.readFile(path.join(projectDir, hit.file), 'utf-8');
      } catch {
        content = '';
      }
      fileCache.set(hit.file, content);
    }

    const line = locateLine(content, hit.content);
    results.push({
      file: hit.file,
      line,
      text: hit.content.replace(/\s+/g, ' ').slice(0, 240),
      context: hit.content.slice(0, 800),
      chapter: hit.chapterNumber,
      source: hit.source,
      score: Number(hit.score.toFixed(4)),
      match: 'semantic',
    });
  }
  return results;
}

/** 用块开头文本在原文中定位行号；定位失败时回退第 1 行。 */
function locateLine(content: string, chunk: string): number {
  if (!content) return 1;
  const candidates = [chunk.slice(0, 60), chunk.slice(0, 30)];
  for (const needle of candidates) {
    const trimmed = needle.trim();
    if (!trimmed) continue;
    const idx = content.indexOf(trimmed);
    if (idx >= 0) return content.slice(0, idx).split('\n').length;
  }
  return 1;
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = `${r.file}|${r.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function searchDirectory(dir: string, prefix: string, query: string, results: SearchResult[]): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await searchDirectory(fullPath, relPath, query, results);
      } else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query)) {
              const context = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join('\n');
              results.push({
                file: relPath,
                line: i + 1,
                text: lines[i].trim(),
                context,
              });
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* ignore directory read errors */ }
}

export default searchRouter;
