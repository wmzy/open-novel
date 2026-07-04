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
 * 契约：源文本只读，必填 targetDir 指定新项目目标目录，.novel/ 建于 targetDir 下。
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

  it('源路径不存在返回 400', async () => {
    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/nonexistent/path/that/does/not/exist',
        targetDir: path.join(tmpDir, 'out'),
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('不存在');
  });

  it('未提供 targetDir 返回 400', async () => {
    const novelPath = path.join(tmpDir, 'mynovel.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A');
    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: novelPath }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('目标目录');
  });

  it('成功切章并在 targetDir 创建 .novel/ 骨架', async () => {
    const novelPath = path.join(tmpDir, 'mynovel.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A\n\n第二章 结束\n内容B');
    const targetDir = path.join(tmpDir, 'new-project');

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: novelPath, targetDir }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.project.id).toMatch(/^proj_/);
    createdIds.push(data.project.id);

    // .novel/ 建在 targetDir 下，不是源文件所在目录
    const ch1 = fs.readFileSync(path.join(targetDir, '.novel/chapters/第1章.md'), 'utf-8');
    expect(ch1).toContain('开始');
    const ch2 = fs.readFileSync(path.join(targetDir, '.novel/chapters/第2章.md'), 'utf-8');
    expect(ch2).toContain('结束');

    // 源文本所在目录不应被改动（无 .novel/）
    expect(fs.existsSync(path.join(tmpDir, '.novel'))).toBe(false);

    const config = JSON.parse(fs.readFileSync(path.join(targetDir, '.novel/config.json'), 'utf-8'));
    expect(config.chapterCount).toBe(2);
  });

  it('targetDir 已有 .novel/ 返回 400', async () => {
    const novelPath = path.join(tmpDir, 'mynovel.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A');
    const targetDir = path.join(tmpDir, 'new-project');
    fs.mkdirSync(path.join(targetDir, '.novel'), { recursive: true });

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: novelPath, targetDir }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('已是');
  });

  it('targetDir 不存在时自动创建', async () => {
    const novelPath = path.join(tmpDir, 'mynovel.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A');
    const targetDir = path.join(tmpDir, 'nested', 'deep', 'new-project');

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: novelPath, targetDir }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    createdIds.push(data.project.id);
    expect(fs.existsSync(path.join(targetDir, '.novel/config.json'))).toBe(true);
  });

  it('目录输入：多文件按文件名排序切章', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, '2.md'), '第二章内容');
    fs.writeFileSync(path.join(srcDir, '1.md'), '第一章内容');
    const targetDir = path.join(tmpDir, 'new-project');

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: srcDir, targetDir }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    createdIds.push(data.project.id);
    const ch1 = fs.readFileSync(path.join(targetDir, '.novel/chapters/第1章.md'), 'utf-8');
    expect(ch1).toContain('第一章内容');
    // 源目录未被改动
    expect(fs.existsSync(path.join(srcDir, '.novel'))).toBe(false);
  });

  it('无文本文件返回 400', async () => {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'image.png'), 'binary');

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: srcDir, targetDir: path.join(tmpDir, 'out') }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('未找到');
  });

  it('返回 runId（agent 驱动入口）', async () => {
    const novelPath = path.join(tmpDir, 'book.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A\n\n第二章 结束\n内容B');
    const targetDir = path.join(tmpDir, 'new-project');

    const res = await apiApp.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: novelPath,
        targetDir,
        agentId: 'claude',
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project).toBeDefined();
    createdIds.push(data.project.id);
    expect(data.runId).toBeDefined();
    expect(typeof data.runId).toBe('string');
    expect(data.runId.length).toBeGreaterThan(10);
  });
});
