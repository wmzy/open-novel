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
    expect(data.sourceFile).toBe('outline/index.md');
  });

  it('outline 索引自愈：index.md 缺失时从 chapters/ 卡片重建（章号无 ? 占位）', async () => {
    const chaptersDir = path.join(projectDir, '.novel', 'outline', 'chapters');
    await fs.mkdir(chaptersDir, { recursive: true });
    await fs.writeFile(
      path.join(chaptersDir, '第2章.md'),
      '## 第 2 章：夜行\n> commitment: committed\n- **主要场景**：夜行',
    );
    await fs.writeFile(
      path.join(chaptersDir, '第1章.md'),
      '## 第 1 章：启程\n> commitment: open\n> open-questions:\n>   - 路线抉择',
    );

    const res = await apiApp.request(`/api/projects/${projectId}/document/outline`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    // index 由卡片自动重建：章号来自文件名、含承诺等级列，无 ? 占位
    expect(data.content).toContain('# 详细大纲索引（自动生成）');
    expect(data.content).toContain('| 1 | 启程 | 待决 | chapters/第1章.md |');
    expect(data.content).toContain('| 2 | 夜行 | 已定 | chapters/第2章.md |');
    expect(data.content).not.toContain('?');
    expect(data.sourceFile).toBe('outline/index.md');
  });

  it('旧格式回退：outline/index.md 不存在时读 outline-detailed.md', async () => {
    await fs.mkdir(path.join(projectDir, '.novel'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.novel', 'outline-detailed.md'),
      '# 旧格式大纲\n\n## 第 1 章\n\n内容。',
    );

    const res = await apiApp.request(`/api/projects/${projectId}/document/outline`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.content).toContain('旧格式大纲');
    expect(data.sourceFile).toBe('outline-detailed.md');
  });

  it('旧格式回退：concept/index.md 不存在时读 concept.md', async () => {
    await fs.mkdir(path.join(projectDir, '.novel'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.novel', 'concept.md'),
      '# 旧格式概念\n\n一个故事。',
    );

    const res = await apiApp.request(`/api/projects/${projectId}/document/concept`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.content).toContain('旧格式概念');
    expect(data.sourceFile).toBe('concept.md');
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
