import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import app from '../../src/api-app';
import { ensureDbReady } from '../../src/db/drizzle';
import { initPlugins } from '../../src/plugins/registry';

/**
 * 章节局部重写 + 章节正文/状态管理的集成测试。
 * 覆盖：
 *  - chapters GET/PATCH 对正文（落盘）与状态的处理
 *  - rewrite 端点的参数校验路径（无需真实 agent）
 */
describe('Rewrite & Chapter content API', () => {
  let projectId: string;
  let projectDir: string;

  beforeAll(async () => {
    await ensureDbReady();
    initPlugins();

    // 创建测试项目（POST 会自动初始化 .novel/ 工作区）
    projectDir = `/tmp/open-novel-rewrite-test-${Date.now()}`;
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '重写测试', genre: 'fantasy', path: projectDir }),
    });
    const data = await res.json();
    projectId = data.project.id;

    // 建立第 1 章记录
    await app.request(`/api/projects/${projectId}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: 1, title: '开端' }),
    });
  });

  it('PATCH /chapters/:num 写入正文后落盘，GET 能读回', async () => {
    const content = '# 第 1 章\n\n夜色如墨，山道上只有一盏孤灯。';
    const patchRes = await app.request(`/api/projects/${projectId}/chapters/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    expect(patchRes.ok).toBe(true);
    const patched = await patchRes.json();
    expect(patched.chapter.content).toBe(content);

    // 验证确实写入磁盘
    const onDisk = await fs.readFile(
      path.join(projectDir, '.novel', 'chapters', 'chapter-1.md'),
      'utf-8',
    );
    expect(onDisk).toBe(content);

    // GET 读回
    const getRes = await app.request(`/api/projects/${projectId}/chapters/1`);
    const got = await getRes.json();
    expect(got.chapter.content).toBe(content);
  });

  it('PATCH /chapters/:num 更新状态，非法状态被忽略', async () => {
    const res1 = await app.request(`/api/projects/${projectId}/chapters/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'review' }),
    });
    expect(res1.ok).toBe(true);
    expect((await res1.json()).chapter.status).toBe('review');

    // 非法状态不应改变现有值
    const res2 = await app.request(`/api/projects/${projectId}/chapters/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'bogus-status' }),
    });
    expect(res2.ok).toBe(true);
    expect((await res2.json()).chapter.status).toBe('review');
  });

  it('PATCH /chapters/:num 带 content 字段不会污染 DB（仅落盘）', async () => {
    // content 不是 DB 列，传入不应报错；状态等其他列仍可更新
    const res = await app.request(`/api/projects/${projectId}/chapters/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '新正文', status: 'finalized' }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.chapter.content).toBe('新正文');
    expect(data.chapter.status).toBe('finalized');
  });

  it('POST /rewrite 缺少 chapterNum 返回 400', async () => {
    const res = await app.request(`/api/projects/${projectId}/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedText: 'x'.repeat(60), instruction: '更紧凑', agentId: 'claude' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /rewrite 选中文本过短返回 400', async () => {
    const res = await app.request(`/api/projects/${projectId}/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterNum: 1, selectedText: '', instruction: '更紧凑', agentId: 'claude' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /rewrite 缺少 instruction 返回 400', async () => {
    const res = await app.request(`/api/projects/${projectId}/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterNum: 1, selectedText: 'x'.repeat(60), agentId: 'claude' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /rewrite 未知 agentId 返回 404', async () => {
    const res = await app.request(`/api/projects/${projectId}/rewrite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chapterNum: 1,
        selectedText: 'x'.repeat(60),
        instruction: '更紧凑',
        agentId: 'no-such-agent',
      }),
    });
    expect(res.status).toBe(404);
  });
});
