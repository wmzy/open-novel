import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';

/**
 * POST /api/projects/import-text 逆向拆书入口端点测试。
 * 聚焦契约：路径校验、章节切分、.novel/ 骨架创建、config.json 落盘、DB 注册。
 */
describe('POST /api/projects/import-text', () => {
  let tmpDir: string;
  let createdIds: string[];

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-text-'));
    createdIds = [];
  });

  afterEach(async () => {
    for (const id of createdIds) {
      await db.delete(projects).where(eq(projects.id, id)).catch(() => {});
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('路径不存在返回 400', async () => {
    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/nonexistent/path/that/does/not/exist' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('不存在');
  });

  it('成功切章并创建 .novel/ 骨架', async () => {
    const novelPath = path.join(tmpDir, 'mynovel.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A\n\n第二章 结束\n内容B');

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: novelPath }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.project.id).toMatch(/^proj_/);
    createdIds.push(data.project.id);

    // 章节文件已标准化
    const dir = path.dirname(novelPath);
    const ch1 = fs.readFileSync(path.join(dir, '.novel/chapters/第1章.md'), 'utf-8');
    expect(ch1).toContain('开始');
    const ch2 = fs.readFileSync(path.join(dir, '.novel/chapters/第2章.md'), 'utf-8');
    expect(ch2).toContain('结束');

    // config.json 已创建
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.novel/config.json'), 'utf-8'));
    expect(config.chapterCount).toBe(2);
  });

  it('目录已有 .novel/ 返回 400', async () => {
    fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpDir }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('已是');
  });

  it('目录输入：多文件按文件名排序切章', async () => {
    fs.writeFileSync(path.join(tmpDir, '2.md'), '第二章内容');
    fs.writeFileSync(path.join(tmpDir, '1.md'), '第一章内容');

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpDir }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    createdIds.push(data.project.id);
    const ch1 = fs.readFileSync(path.join(tmpDir, '.novel/chapters/第1章.md'), 'utf-8');
    expect(ch1).toContain('第一章内容');
  });

  it('无文本文件返回 400', async () => {
    fs.writeFileSync(path.join(tmpDir, 'image.png'), 'binary');

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpDir }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('未找到');
  });
});
