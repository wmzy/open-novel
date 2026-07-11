import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';

vi.mock('../../../src/agent/registry', () => ({ getAgentDef: () => ({ id: 'claude', label: 'Claude' }) }));
vi.mock('../../../src/agent/detection', () => ({ detectAgents: async () => [] }));

let projectDir: string;
let projectId: string;

beforeEach(async () => {
  await ensureDbReady();
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-doc-test-'));
  projectId = 'proj_dt_' + Math.floor(Math.random() * 1e10).toString(36);
  await db.insert(projects).values({
    id: projectId,
    title: '测试小说',
    path: projectDir,
    genre: 'wuxia',
  });
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('GET /api/projects/:id/document/:type', () => {
  it('合并 concept 目录为单个 markdown', async () => {
    const conceptDir = path.join(projectDir, '.novel', 'concept');
    await fs.mkdir(conceptDir, { recursive: true });
    await fs.writeFile(
      path.join(conceptDir, 'index.md'),
      '# 概念索引：《测试》\n\n| 标题 | 摘要 | 文件 |\n|---|---|---|\n| 核心主题 | 测试主题 | 核心主题.md |\n',
    );
    await fs.writeFile(
      path.join(conceptDir, '核心主题.md'),
      '## 核心主题\n\n这是核心主题内容。',
    );

    const res = await apiApp.request(`/api/projects/${projectId}/document/concept`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.content).toContain('# 概念索引');
    expect(data.content).toContain('## 核心主题');
    expect(data.content).toContain('这是核心主题内容');
  });

  it('合并 outline 目录（含 chapters/ 子目录）', async () => {
    const outlineDir = path.join(projectDir, '.novel', 'outline');
    await fs.mkdir(path.join(outlineDir, 'chapters'), { recursive: true });
    await fs.writeFile(
      path.join(outlineDir, 'index.md'),
      '# 详细大纲索引：《测试》\n\n| 章 | 标题 | 文件 |\n|---|---|---|\n| 1 | 开头 | chapters/第1章.md |\n',
    );
    await fs.writeFile(
      path.join(outlineDir, 'chapters', '第1章.md'),
      '## 第 1 章：开头\n\n- **结构定位**：开篇',
    );

    const res = await apiApp.request(`/api/projects/${projectId}/document/outline`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.content).toContain('# 详细大纲索引');
    expect(data.content).toContain('## 第 1 章');
    expect(data.content).toContain('结构定位');
  });

  it('文档不存在返回 404', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/document/world`);
    expect(res.status).toBe(404);
  });

  it('无效类型返回 400', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/document/invalid`);
    expect(res.status).toBe(400);
  });
});
