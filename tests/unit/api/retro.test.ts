import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import retroRouter from '../../../src/api/routes/retro';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';

/**
 * POST /api/projects/:id/retro 与 GET /api/projects/:id/state-hygiene 端点测试。
 *
 * 来源：状态分离/回溯影响分析工作包新建。api-app.ts 挂载点由主控统一接线
 * （app.route('/api/projects/:projectId', retroRouter)），此处本地挂同款路由，
 * 待主控接线后可与其它路由测试合并到统一的 apiApp 直连模式。
 */
const apiApp = new Hono();
apiApp.route('/api/projects/:projectId', retroRouter);

describe('POST /api/projects/:id/retro（回溯影响分析）', () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-'));
    const novel = path.join(tmpDir, '.novel');

    // 设定档案：被修订的文件，含两个角色实体
    fs.mkdirSync(path.join(novel, 'characters'), { recursive: true });
    fs.writeFileSync(
      path.join(novel, 'characters', 'profiles.md'),
      [
        '# 角色档案',
        '',
        '## 林青（主角）',
        '- 姓名：林青',
        '- 定位：北境斥候，背负旧案',
        '',
        '## 苏晚',
        '- 姓名：苏晚',
        '- 定位：临安说书人',
        '',
      ].join('\n'),
    );

    // 正文：第1章提及实体，第2章不提及；摘要文件不参与扫描
    fs.mkdirSync(path.join(novel, 'chapters'), { recursive: true });
    fs.writeFileSync(path.join(novel, 'chapters', '第1章.md'), '# 第一章\n林青踏雪出了关隘，回头看了一眼烽燧。');
    fs.writeFileSync(path.join(novel, 'chapters', '第2章.md'), '# 第二章\n老人独坐灯下，擦拭一枚旧棋子。');
    fs.writeFileSync(path.join(novel, 'chapters', '第1章.summary.md'), '林青出关的摘要。');

    // 大纲卡片：第1章提及实体
    fs.mkdirSync(path.join(novel, 'outline', 'chapters'), { recursive: true });
    fs.writeFileSync(
      path.join(novel, 'outline', 'chapters', '第1章.md'),
      '#### 第1章：出关\n| 出场角色 | 林青 |\n| 核心事件 | 夜出北境 |',
    );

    // 伏笔：F1 提及实体，F2 不提及
    fs.writeFileSync(
      path.join(novel, 'foreshadow.json'),
      JSON.stringify([
        { id: 'F1', content: '林青随身玉佩刻着的字样暗藏身世线索', status: 'pending' },
        { id: 'F2', content: '城南市集的糖人摊每逢初一收摊', status: 'pending' },
      ]),
    );

    projectId = 'test_retro_1';
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.insert(projects).values({
      id: projectId,
      title: '回溯影响测试',
      path: tmpDir,
      genre: 'general',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('提及实体的章节/大纲/伏笔被命中，未提及的不命中', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/retro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'characters/profiles.md', note: '修订主角定位' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    // 实体识别来自修订文件本身
    expect(data.entities).toContain('林青');
    expect(data.entities).toContain('苏晚');

    // 正文：仅第1章命中，摘要文件不参与扫描
    expect(data.chapters).toHaveLength(1);
    expect(data.chapters[0].chapter).toBe(1);
    expect(data.chapters[0].file).toBe('chapters/第1章.md');
    expect(data.chapters[0].entities).toContain('林青');

    // 大纲：第1章卡片命中
    expect(data.outlines).toHaveLength(1);
    expect(data.outlines[0].chapter).toBe(1);

    // 伏笔：仅 F1 命中
    expect(data.foreshadows).toHaveLength(1);
    expect(data.foreshadows[0].id).toBe('F1');
    expect(data.foreshadows[0].entities).toContain('林青');

    // 建议动作覆盖三类受影响面
    expect(data.actions.some((a: string) => a.includes('第1章正文'))).toBe(true);
    expect(data.actions.some((a: string) => a.includes('大纲第1章'))).toBe(true);
    expect(data.actions.some((a: string) => a.includes('F1'))).toBe(true);

    // 产物落盘 .novel/retro/，结构含五个段落
    expect(data.reportPath).toMatch(/^retro\/\d{8}-\d{6}\.md$/);
    const md = fs.readFileSync(path.join(tmpDir, '.novel', data.reportPath), 'utf-8');
    expect(md).toContain('## 变更来源');
    expect(md).toContain('characters/profiles.md');
    expect(md).toContain('修订主角定位');
    expect(md).toContain('## 受影响章节');
    expect(md).toContain('## 受影响大纲');
    expect(md).toContain('## 受影响伏笔');
    expect(md).toContain('## 建议动作清单');
  });

  it('body 缺少 file 返回 400', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/retro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('设定文件不存在返回 404', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/retro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'characters/ghost.md' }),
    });
    expect(res.status).toBe(404);
  });

  it('路径逃逸（..）返回 400', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/retro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: '../state.json' }),
    });
    expect(res.status).toBe(400);
  });

  it('项目不存在返回 404', async () => {
    const res = await apiApp.request('/api/projects/proj_retro_nonexistent/retro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'characters/profiles.md' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:id/state-hygiene（状态卫生只读检测）', () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-'));
    const novel = path.join(tmpDir, '.novel');
    fs.mkdirSync(novel, { recursive: true });
    projectId = 'test_hygiene_1';
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.insert(projects).values({
      id: projectId,
      title: '状态卫生测试',
      path: tmpDir,
      genre: 'general',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('报告污染角色与字段，且不执行分离（state.json 不变）', async () => {
    const novel = path.join(tmpDir, '.novel');
    const stateJson = JSON.stringify({
      characters: [
        // 污染：从未出场但带运行态字段
        { name: '林青', location: '北境', emotion: '警惕', knows: [], relationships: {}, lastAppearance: 0 },
        // 正常运行态
        { name: '苏晚', location: '临安', emotion: '平静', knows: [], relationships: {}, lastAppearance: 2 },
      ],
      timeline: '',
      activeForeshadows: [],
      lastUpdatedChapter: 2,
      updatedAt: '',
    });
    fs.writeFileSync(path.join(novel, 'state.json'), stateJson);
    fs.writeFileSync(
      path.join(novel, 'state-intent.json'),
      JSON.stringify({ characters: [{ name: '赵歧', notes: '期望位置：南疆' }], updatedAt: '' }),
    );

    const res = await apiApp.request(`/api/projects/${projectId}/state-hygiene`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.pollution).toEqual([{ name: '林青', fields: ['location', 'emotion'] }]);
    expect(data.intentCount).toBe(1);

    // 只读：state.json 内容原样保留
    expect(fs.readFileSync(path.join(novel, 'state.json'), 'utf-8')).toBe(stateJson);
  });

  it('无污染时返回空清单', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.novel', 'state.json'),
      JSON.stringify({
        characters: [
          { name: '林青', location: '', emotion: '', knows: [], relationships: {}, lastAppearance: 0 },
        ],
        timeline: '',
        activeForeshadows: [],
        lastUpdatedChapter: 0,
        updatedAt: '',
      }),
    );
    const res = await apiApp.request(`/api/projects/${projectId}/state-hygiene`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pollution).toEqual([]);
    expect(data.intentCount).toBe(0);
  });
});
