import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { eq, inArray } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects, semanticChunks, userSettings } from '../../../src/db/schema';
import apiApp from '../../../src/api-app';

const SETTING_KEYS = [
  'embedding_enabled',
  'embedding_baseUrl',
  'embedding_model',
  'embedding_apiKey',
];

/** 关键词计数向量：龙/雨/剑/灯，用于验证语义近邻排序（确定性、无外部依赖）。 */
function vectorFor(text: string): number[] {
  return [
    (text.match(/龙/g) ?? []).length,
    (text.match(/雨/g) ?? []).length,
    (text.match(/剑/g) ?? []).length,
    (text.match(/灯/g) ?? []).length,
  ].map((n) => n + 0.01);
}

async function configureEmbedding(apiKey = 'sk-test-secret') {
  const res = await apiApp.request('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embedding_enabled: 'true',
      embedding_baseUrl: 'http://127.0.0.1:9/v1',
      embedding_model: 'mock-embedding',
      embedding_apiKey: apiKey,
    }),
  });
  expect(res.status).toBe(200);
}

async function clearEmbeddingSettings() {
  await db.delete(userSettings).where(inArray(userSettings.key, SETTING_KEYS));
}

describe('语义检索 API（mock embeddings）', () => {
  let tempDir: string;
  let projectId: string;
  let fetchCalls = 0;

  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    fetchCalls++;
    const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
    expect(body.model).toBe('mock-embedding');
    return new Response(JSON.stringify({
      data: body.input.map((input, index) => ({ index, embedding: vectorFor(input) })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  beforeEach(async () => {
    await ensureDbReady();
    fetchCalls = 0;
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-api-'));
    const chaptersDir = path.join(tempDir, '.novel', 'chapters');
    await fs.mkdir(chaptersDir, { recursive: true });
    await fs.writeFile(
      path.join(chaptersDir, '第1章.md'),
      `# 第一章 龙吟\n\n${'巨龙在山谷中盘踞，龙鳞映着月光。'.repeat(20)}`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(chaptersDir, '第2章.md'),
      `# 第二章 暴雨\n\n${'暴雨倾盆而下，雨水漫过石阶。'.repeat(20)}`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(chaptersDir, '第3章.md'),
      `# 第三章 拔剑\n\n${'长剑出鞘，剑光如雪。'.repeat(20)}`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(chaptersDir, '第2章.summary.md'),
      '主角在暴雨中赶路，雨水冲毁了山道。',
      'utf-8',
    );

    projectId = `sem_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.slice(0, 25);
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({
      id: projectId,
      title: '语义检索测试',
      path: tempDir,
      genre: 'fantasy',
    });
    await clearEmbeddingSettings();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await clearEmbeddingSettings().catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('未配置嵌入服务时语义模式回退文本检索，默认模式响应保持旧契约', async () => {
    const fallbackRes = await apiApp.request(
      `/api/projects/${projectId}/search?q=${encodeURIComponent('龙')}&mode=semantic`,
    );
    expect(fallbackRes.status).toBe(200);
    const fallback = await fallbackRes.json();
    expect(fallback.fallback).toBe('not-configured');
    expect(fallback.results.length).toBeGreaterThan(0);
    expect(fallback.results[0].file).toBe('chapters/第1章.md');

    const legacyRes = await apiApp.request(
      `/api/projects/${projectId}/search?q=${encodeURIComponent('龙')}`,
    );
    const legacy = await legacyRes.json();
    // 未传 mode：响应字段与旧版完全一致（无 mode/fallback 字段）
    expect(Object.keys(legacy).sort()).toEqual(['query', 'results']);
    expect(legacy.results[0].file).toBe('chapters/第1章.md');
    // 未配置路径不发任何嵌入请求
    expect(fetchCalls).toBe(0);
  });

  it('reindex 写入向量，semantic 搜索返回语义最近块', async () => {
    await configureEmbedding();

    const reindexRes = await apiApp.request(
      `/api/projects/${projectId}/search/reindex`,
      { method: 'POST' },
    );
    expect(reindexRes.status).toBe(200);
    const reindex = await reindexRes.json();
    expect(reindex.configured).toBe(true);
    expect(reindex.chunksIndexed).toBeGreaterThan(0);
    expect(fetchCalls).toBeGreaterThan(0);

    const rows = await db.select().from(semanticChunks)
      .where(eq(semanticChunks.projectId, projectId));
    expect(rows.length).toBe(reindex.chunksIndexed);
    // 正文与摘要都进入索引
    expect(rows.some((r) => r.source === 'body')).toBe(true);
    expect(rows.some((r) => r.source === 'summary')).toBe(true);
    expect(rows.every((r) => r.model === 'mock-embedding')).toBe(true);
    expect(rows.every((r) => Array.isArray(r.embedding) && r.embedding.length === 4)).toBe(true);

    const searchRes = await apiApp.request(
      `/api/projects/${projectId}/search?q=${encodeURIComponent('龙')}&mode=semantic`,
    );
    expect(searchRes.status).toBe(200);
    const search = await searchRes.json();
    expect(search.mode).toBe('semantic');
    expect(search.fallback).toBeNull();
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0].file).toBe('chapters/第1章.md');
    expect(search.results[0].match).toBe('semantic');
    expect(search.results[0].score).toBeGreaterThan(0.9);

    // 换一个语义查询：雨 → 第2章相关片段排第一（正文或摘要均可）
    const rainRes = await apiApp.request(
      `/api/projects/${projectId}/search?q=${encodeURIComponent('暴雨')}&mode=semantic`,
    );
    const rain = await rainRes.json();
    expect(rain.results[0].chapter).toBe(2);
  });

  it('增量索引：未变化章节不重新嵌入，改动章节只重建该章', async () => {
    await configureEmbedding();

    const firstRes = await apiApp.request(
      `/api/projects/${projectId}/search/reindex`,
      { method: 'POST' },
    );
    const first = await firstRes.json();
    expect(first.chunksIndexed).toBeGreaterThan(0);
    const callsAfterFirst = fetchCalls;

    const secondRes = await apiApp.request(
      `/api/projects/${projectId}/search/reindex`,
      { method: 'POST' },
    );
    const second = await secondRes.json();
    expect(second.chunksIndexed).toBe(0);
    expect(second.embeddedChunks).toBe(0);
    expect(second.chunksReused).toBe(first.chunksIndexed);
    expect(second.chaptersIndexed).toBe(0);
    expect(second.chaptersSkipped).toBe(second.chaptersScanned);
    expect(fetchCalls).toBe(callsAfterFirst);

    // 修改第1章正文 → 只重建第1章，其他章节跳过
    await fs.writeFile(
      path.join(tempDir, '.novel', 'chapters', '第1章.md'),
      `# 第一章 龙吟\n\n${'巨龙苏醒，龙吟震彻群山。'.repeat(20)}`,
      'utf-8',
    );
    const thirdRes = await apiApp.request(
      `/api/projects/${projectId}/search/reindex`,
      { method: 'POST' },
    );
    const third = await thirdRes.json();
    expect(third.chaptersIndexed).toBe(1);
    expect(third.embeddedChunks).toBeGreaterThan(0);
    expect(fetchCalls).toBeGreaterThan(callsAfterFirst);
  });

  it('嵌入服务失败时回退文本搜索并返回 embedding-error', async () => {
    await configureEmbedding();
    await apiApp.request(`/api/projects/${projectId}/search/reindex`, { method: 'POST' });

    fetchMock.mockRejectedValueOnce(new Error('mock network down'));
    const res = await apiApp.request(
      `/api/projects/${projectId}/search?q=${encodeURIComponent('龙')}&mode=semantic`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fallback).toBe('embedding-error');
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].file).toBe('chapters/第1章.md');
  });

  it('reindex 嵌入失败时保留旧索引并返回 502', async () => {
    await configureEmbedding();
    const first = await (await apiApp.request(
      `/api/projects/${projectId}/search/reindex`,
      { method: 'POST' },
    )).json();
    expect(first.chunksIndexed).toBeGreaterThan(0);

    // 修改正文使索引需要重新嵌入，再让嵌入服务失败
    await fs.writeFile(
      path.join(tempDir, '.novel', 'chapters', '第1章.md'),
      `# 第一章 龙吟\n\n${'巨龙再度苏醒。'.repeat(20)}`,
      'utf-8',
    );
    fetchMock.mockRejectedValueOnce(new Error('mock network down'));
    const res = await apiApp.request(
      `/api/projects/${projectId}/search/reindex`,
      { method: 'POST' },
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('embedding-request-failed');

    // 旧索引仍然完整可用（没有先删后插导致索引清空）
    const rows = await db.select().from(semanticChunks)
      .where(eq(semanticChunks.projectId, projectId));
    expect(rows.length).toBe(first.chunksIndexed);
  });

  it('未配置时 reindex 返回 400；缺少 q 返回 400；非法 mode 返回 400', async () => {
    const noConfig = await apiApp.request(
      `/api/projects/${projectId}/search/reindex`,
      { method: 'POST' },
    );
    expect(noConfig.status).toBe(400);
    expect((await noConfig.json()).error).toBe('embedding-not-configured');

    const noQuery = await apiApp.request(`/api/projects/${projectId}/search`);
    expect(noQuery.status).toBe(400);

    const badMode = await apiApp.request(
      `/api/projects/${projectId}/search?q=x&mode=nonsense`,
    );
    expect(badMode.status).toBe(400);
  });

  it('设置接口不回显 API Key，空字符串可清除密钥', async () => {
    await configureEmbedding('sk-test-secret');

    const res = await apiApp.request('/api/settings');
    const body = await res.json();
    expect(body.settings.embedding_apiKey).toBeUndefined();
    expect(body.settings.embedding_apiKeySet).toBe('true');
    expect(JSON.stringify(body)).not.toContain('sk-test-secret');

    await apiApp.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embedding_apiKey: '' }),
    });
    const afterRes = await apiApp.request('/api/settings');
    const after = await afterRes.json();
    expect(after.settings.embedding_apiKeySet).toBe('false');
  });
});
