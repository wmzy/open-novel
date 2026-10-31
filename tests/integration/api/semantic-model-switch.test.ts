/**
 * 嵌入模型切换：改模型后既有向量立即失效，且后台自动重建（不必等章节同步）。
 *
 * 覆盖两条链路：
 *  - 检索：searchSemanticChunks 按「当前配置的模型」过滤向量，旧模型向量不参与比较；
 *  - 写作期语义回忆：buildSemanticRecallContext 同样按当前模型过滤。
 * 因此换模型后必须重建，否则检索退化为 index-empty、语义回忆注入为空。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { eq, inArray } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects, semanticChunks, userSettings } from '../../../src/db/schema';
import apiApp from '../../../src/api-app';
import { buildSemanticRecallContext } from '../../../src/agent/context-manager';

const SETTING_KEYS = [
  'embedding_enabled',
  'embedding_baseUrl',
  'embedding_model',
  'embedding_apiKey',
];

/** 确定性向量：按字符命中数，够用于区分模型与排序。 */
function vectorFor(text: string): number[] {
  return [
    (text.match(/龙/g) ?? []).length,
    (text.match(/雨/g) ?? []).length,
    (text.match(/剑/g) ?? []).length,
  ].map((n) => n + 0.01);
}

describe('嵌入模型切换 → 索引重建', () => {
  let tempDir: string;
  let projectId: string;
  /** 收到的嵌入请求模型名序列。 */
  let requestedModels: string[] = [];

  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { input: string[]; model: string };
    requestedModels.push(body.model);
    return new Response(JSON.stringify({
      data: body.input.map((input, index) => ({ index, embedding: vectorFor(input) })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  async function patchSettings(patch: Record<string, string>) {
    const res = await apiApp.request('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(200);
  }

  beforeEach(async () => {
    await ensureDbReady();
    requestedModels = [];
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-model-'));
    const chaptersDir = path.join(tempDir, '.novel', 'chapters');
    await fs.mkdir(chaptersDir, { recursive: true });
    await fs.writeFile(
      path.join(chaptersDir, '第1章.md'),
      `# 第一章 龙吟\n\n${'巨龙盘踞山谷。'.repeat(20)}`,
      'utf-8',
    );
    await fs.writeFile(
      path.join(chaptersDir, '第2章.md'),
      `# 第二章 暴雨\n\n${'暴雨倾盆。'.repeat(20)}`,
      'utf-8',
    );

    projectId = `semm_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`.slice(0, 25);
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({
      id: projectId,
      title: '模型切换测试',
      path: tempDir,
      genre: 'fantasy',
    });
    await db.delete(userSettings).where(inArray(userSettings.key, SETTING_KEYS));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.delete(userSettings).where(inArray(userSettings.key, SETTING_KEYS)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('换模型后旧向量不再参与检索，后台重建后恢复可用', async () => {
    await patchSettings({
      embedding_enabled: 'true',
      embedding_baseUrl: 'http://127.0.0.1:9/v1',
      embedding_model: 'model-a',
      embedding_apiKey: 'sk-test',
    });

    const first = await (await apiApp.request(
      `/api/projects/${projectId}/search/reindex`,
      { method: 'POST' },
    )).json();
    expect(first.chunksIndexed).toBeGreaterThan(0);
    expect(requestedModels.every((m) => m === 'model-a')).toBe(true);

    const rowsA = await db.select().from(semanticChunks)
      .where(eq(semanticChunks.projectId, projectId));
    expect(rowsA.every((r) => r.model === 'model-a')).toBe(true);

    // 换模型：PATCH 触发后台重建
    await patchSettings({ embedding_model: 'model-b' });

    // 等待后台重建完成（轮询 DB 中 model-b 的行）
    let rowsB: typeof rowsA = [];
    for (let i = 0; i < 40; i++) {
      rowsB = await db.select().from(semanticChunks)
        .where(eq(semanticChunks.projectId, projectId));
      if (rowsB.length > 0 && rowsB.every((r) => r.model === 'model-b')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsB.every((r) => r.model === 'model-b')).toBe(true);
    expect(requestedModels.some((m) => m === 'model-b')).toBe(true);

    // 重建后检索与语义回忆都恢复可用
    const search = await (await apiApp.request(
      `/api/projects/${projectId}/search?q=${encodeURIComponent('龙')}&mode=semantic`,
    )).json();
    expect(search.fallback).toBeNull();
    expect(search.results.length).toBeGreaterThan(0);

    const recall = await buildSemanticRecallContext(projectId, tempDir, 3);
    expect(recall.length).toBeGreaterThan(0);
  }, 20_000);
});
