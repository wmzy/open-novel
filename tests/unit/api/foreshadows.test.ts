/**
 * 伏笔债务系统 API 测试。
 * 来源：伏笔债务系统改造包（第 1 包）。
 * 说明：/api/projects/:projectId/foreshadows 路由在 api-app.ts 由主控统一挂载，
 * 这里用本地 Hono 实例按相同挂载方式直接测路由（避免依赖挂载顺序）；
 * POST /check/foreshadows 已在 api-app 挂载，走 apiApp.request 实测。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import foreshadowRouter from '../../../src/api/routes/foreshadows';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';

// 与 api-app.ts 相同的挂载方式（:projectId 参数名一致）
const app = new Hono();
app.route('/api/projects/:projectId/foreshadows', foreshadowRouter);

function writeNovelFile(tmpDir: string, name: string, content: unknown) {
  fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.novel', name), typeof content === 'string' ? content : JSON.stringify(content));
}

describe('伏笔债务路由 /api/projects/:projectId/foreshadows', () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreshadow-'));
    fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });
    projectId = 'test_foreshadow_1';
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.insert(projects).values({
      id: projectId,
      title: '伏笔债务测试',
      path: tmpDir,
      genre: 'general',
      chapterCount: 20,
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET：旧格式文件自动迁移并返回债务统计', async () => {
    writeNovelFile(tmpDir, 'state.json', {
      characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 10, updatedAt: '',
    });
    writeNovelFile(tmpDir, 'foreshadow.json', {
      foreshadows: [
        // 旧格式：plantedIn 自由文本 + 缺新字段
        { id: 1, content: '旧格式伏笔', status: 'planted', plantedIn: '第64-66章', resolvedIn: null },
        { id: 2, content: '带期限伏笔', status: 'planted', plantedIn: 3, resolveDeadline: 8 },
        { id: 3, content: '非法状态', status: 'unknown' },
      ],
    });

    const res = await app.request(`/api/projects/${projectId}/foreshadows`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.migrated).toBe(true);
    expect(data.warnings.some((w: string) => w.includes('status 非法'))).toBe(true);
    // "第64-66章" → 64
    expect(data.foreshadows[0].plantedIn).toBe(64);
    // currentChapter 以实际写作进度为准（lastUpdatedChapter=10），
    // 不再被未来埋设章（64）前移——否则逾期/临期/密度窗口全部失真
    expect(data.currentChapter).toBe(10);
    // #2 期限 8 < 10 → 逾期；#1 无期限
    expect(data.stats.overdue.map((f: { id: number }) => f.id)).toEqual([2]);
    // 未结清 2 条（#1 light + #2 light）→ 债务分 2
    expect(data.stats.debtScore).toBe(2);
    expect(data.stats.byStatus).toEqual({ pending: 0, planted: 2, resolved: 0, dropped: 0 });
    expect(data.chapterCount).toBe(20);
  });

  it('GET：未开写（lastUpdatedChapter=0）时 currentChapter 回退到最大规划埋设章', async () => {
    writeNovelFile(tmpDir, 'state.json', {
      characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 0, updatedAt: '',
    });
    writeNovelFile(tmpDir, 'foreshadow.json', {
      foreshadows: [
        { id: 1, content: '未来伏笔', status: 'pending', plantedIn: 18, resolveDeadline: null, resolvedIn: null },
      ],
    });
    const res = await app.request(`/api/projects/${projectId}/foreshadows`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.currentChapter).toBe(18);
  });

  it('GET：文件缺失时返回空清单与零债务，不报错', async () => {
    const res = await app.request(`/api/projects/${projectId}/foreshadows`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.foreshadows).toEqual([]);
    expect(data.stats.total).toBe(0);
    expect(data.stats.debtScore).toBe(0);
    expect(data.migrated).toBe(false);
  });

  it('GET：项目不存在返回 404', async () => {
    const res = await app.request('/api/projects/no_such_project/foreshadows');
    expect(res.status).toBe(404);
  });

  it('POST：最小 body 创建伏笔，服务端补默认值与自增 id', async () => {
    writeNovelFile(tmpDir, 'foreshadow.json', {
      foreshadows: [{ id: 3, content: '已有伏笔', type: 'world', status: 'planted', plantedIn: 1, resolveDeadline: null, resolvedIn: null, dependsOn: [], weight: 'major' }],
    });

    const res = await app.request(`/api/projects/${projectId}/foreshadows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '新伏笔', plantedIn: '第5章', resolveDeadline: 12 }),
    });
    expect(res.status).toBe(201);
    const { foreshadow } = await res.json();
    expect(foreshadow).toMatchObject({
      id: 4, // 已有最大 id 3 → 自增 4
      content: '新伏笔',
      type: 'chekhov',       // 默认类型
      status: 'pending',     // 默认状态
      weight: 'light',       // 默认权重
      plantedIn: 5,          // "第5章" → 5
      resolveDeadline: 12,
      dependsOn: [],
    });

    // 已落盘
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, '.novel', 'foreshadow.json'), 'utf-8'));
    expect(saved.foreshadows).toHaveLength(2);
    expect(saved.foreshadows[1].id).toBe(4);
  });

  it('POST：缺 content 或非法枚举返回 400', async () => {
    const noContent = await app.request(`/api/projects/${projectId}/foreshadows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'chekhov' }),
    });
    expect(noContent.status).toBe(400);

    const badStatus = await app.request(`/api/projects/${projectId}/foreshadows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x', status: 'unknown' }),
    });
    expect(badStatus.status).toBe(400);

    const badPlantedIn = await app.request(`/api/projects/${projectId}/foreshadows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x', plantedIn: '序章之前' }),
    });
    expect(badPlantedIn.status).toBe(400);
  });

  it('PATCH：更新状态/期限并写回；不存在返回 404；null 清空期限', async () => {
    writeNovelFile(tmpDir, 'foreshadow.json', {
      foreshadows: [{ id: 1, content: '待更新', type: 'chekhov', status: 'planted', plantedIn: 2, resolveDeadline: 9, resolvedIn: null, dependsOn: [], weight: 'light' }],
    });

    const ok = await app.request(`/api/projects/${projectId}/foreshadows/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'resolved', resolvedIn: 8 }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).foreshadow).toMatchObject({ status: 'resolved', resolvedIn: 8 });

    const clear = await app.request(`/api/projects/${projectId}/foreshadows/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolveDeadline: null }),
    });
    expect(clear.status).toBe(200);
    expect((await clear.json()).foreshadow.resolveDeadline).toBeNull();

    const missing = await app.request(`/api/projects/${projectId}/foreshadows/99`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'dropped' }),
    });
    expect(missing.status).toBe(404);
  });

  it('DELETE：删除条目并清理其余条目的 dependsOn 引用', async () => {
    writeNovelFile(tmpDir, 'foreshadow.json', {
      foreshadows: [
        { id: 1, content: '被依赖', type: 'chekhov', status: 'resolved', plantedIn: 1, resolveDeadline: null, resolvedIn: 3, dependsOn: [], weight: 'light' },
        { id: 2, content: '依赖者', type: 'identity', status: 'pending', plantedIn: 4, resolveDeadline: null, resolvedIn: null, dependsOn: [1, 3], weight: 'major' },
      ],
    });

    const res = await app.request(`/api/projects/${projectId}/foreshadows/1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, '.novel', 'foreshadow.json'), 'utf-8'));
    expect(saved.foreshadows).toHaveLength(1);
    expect(saved.foreshadows[0].dependsOn).toEqual([3]); // 已删的 #1 引用被清理

    const missing = await app.request(`/api/projects/${projectId}/foreshadows/1`, { method: 'DELETE' });
    expect(missing.status).toBe(404);
  });
});

describe('POST /api/projects/:projectId/check/foreshadows（债务扩展）', () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreshadow-check-'));
    fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });
    projectId = 'test_foreshadow_check_1';
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.insert(projects).values({
      id: projectId,
      title: '伏笔检测测试',
      path: tmpDir,
      genre: 'general',
      chapterCount: 12,
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('逾期检测按 resolveDeadline 判定并返回债务统计', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.novel/state.json'),
      JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 10, updatedAt: '' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.novel/foreshadow.json'),
      JSON.stringify({
        foreshadows: [
          // 期限 8 < currentChapter 10 → 逾期（不再依赖关键词提及启发）
          { id: 1, content: '逾期未收', type: 'chekhov', status: 'planted', plantedIn: 2, resolveDeadline: 8, resolvedIn: null, dependsOn: [], weight: 'major' },
          // 期限 11 ∈ (10, 20] → 即将到期
          { id: 2, content: '即将到期', type: 'world', status: 'planted', plantedIn: 3, resolveDeadline: 11, resolvedIn: null, dependsOn: [1], weight: 'light' },
        ],
      }),
    );

    const res = await apiApp.request(`/api/projects/${projectId}/check/foreshadows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    // 保留原有三分类（关键词遗忘检测）
    expect(data.forgotten).toEqual([]);
    expect(data.resolved).toEqual([]);
    // 债务扩展字段
    expect(data.overdue.map((f: { id: number }) => f.id)).toEqual([1]);
    expect(data.dueSoon.map((f: { id: number }) => f.id)).toEqual([2]);
    expect(data.debtScore).toBe(3); // major(2) + light(1)
    expect(data.currentChapter).toBe(10);
    expect(data.migrated).toBe(false);
  });

  it('旧格式文件迁移标记透传', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.novel/foreshadow.json'),
      JSON.stringify({
        foreshadows: [{ id: 1, content: '旧格式', status: 'planted', plantedIn: '第64-66章' }],
      }),
    );

    const res = await apiApp.request(`/api/projects/${projectId}/check/foreshadows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.migrated).toBe(true);
  });
});
