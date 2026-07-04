import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { generateId } from '../../../src/utils/id';

/**
 * POST /api/projects/:id/import-source 测试。
 * 契约：将外部源文本切章写入已有项目的 .novel/chapters/，更新 chapterCount，
 * 不启动 agent（agent 拆解由 /api/runs stage=decompose 驱动）。
 */
describe('POST /api/projects/:id/import-source', () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-source-'));
    // 创建一个空项目目录 + .novel/ 骨架
    fs.mkdirSync(path.join(tmpDir, '.novel', 'chapters'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.novel', 'config.json'),
      JSON.stringify({ title: '测试', genre: 'general', chapterCount: 0 }),
    );
    // 注册 DB 记录
    const id = generateId('proj_');
    await db.insert(projects).values({
      id,
      title: '测试',
      path: tmpDir,
      genre: 'general',
      targetWords: 0,
      chapterCount: 0,
      perspective: 'third-person',
    });
    projectId = id;
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('项目不存在返回 404', async () => {
    const res = await apiApp.request('/api/projects/proj_nonexistent_xyz/import-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: '/tmp' }),
    });
    expect(res.status).toBe(404);
  });

  it('源路径不存在返回 400', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/import-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: '/nonexistent/path/xyz' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('不存在');
  });

  it('成功切章并写入当前项目 .novel/chapters/', async () => {
    const novelPath = path.join(tmpDir, 'raw.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A\n\n第二章 结束\n内容B');

    const res = await apiApp.request(`/api/projects/${projectId}/import-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: novelPath }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chapterCount).toBe(2);

    const ch1 = fs.readFileSync(path.join(tmpDir, '.novel/chapters/第1章.md'), 'utf-8');
    expect(ch1).toContain('开始');
    const ch2 = fs.readFileSync(path.join(tmpDir, '.novel/chapters/第2章.md'), 'utf-8');
    expect(ch2).toContain('结束');

    // config.json 已更新
    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.novel/config.json'), 'utf-8'));
    expect(config.chapterCount).toBe(2);

    // DB 已更新
    const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(row.chapterCount).toBe(2);
  });

  it('目录输入：多文件按文件名排序切章', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, '2.md'), '第二章内容');
    fs.writeFileSync(path.join(srcDir, '1.md'), '第一章内容');

    const res = await apiApp.request(`/api/projects/${projectId}/import-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: srcDir }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.chapterCount).toBe(2);

    const ch1 = fs.readFileSync(path.join(tmpDir, '.novel/chapters/第1章.md'), 'utf-8');
    expect(ch1).toContain('第一章内容');
  });

  it('无文本文件返回 400', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'image.png'), 'binary');

    const res = await apiApp.request(`/api/projects/${projectId}/import-source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: srcDir }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('未找到');
  });
});
