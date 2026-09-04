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

  it('POST /chapters 同步创建磁盘文件，resync 后不被删除（幽灵章节修复）', async () => {
    // beforeAll 已 POST 第 1 章；GET 列表触发 resync（磁盘为事实源）
    const listRes = await app.request(`/api/projects/${projectId}/chapters`);
    expect(listRes.ok).toBe(true);
    const { chapters } = await listRes.json();
    expect(chapters.map((c: { number: number }) => c.number)).toContain(1);

    // 磁盘文件已存在且含标题行
    const onDisk = await fs.readFile(
      path.join(projectDir, '.novel', 'chapters', '第1章.md'),
      'utf-8',
    );
    expect(onDisk).toContain('# 开端');
  });

  it('DELETE /chapters/:num 清理伏笔悬挂引用（plantedIn/resolvedIn 置空）', async () => {
    // 建立第 2 章
    const createRes = await app.request(`/api/projects/${projectId}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: 2, title: '第二章' }),
    });
    expect(createRes.ok).toBe(true);

    // 写入伏笔文件：plantedIn=2、resolvedIn=2
    const fp = path.join(projectDir, '.novel', 'foreshadow.json');
    await fs.writeFile(
      fp,
      JSON.stringify({
        foreshadows: [
          { id: 1, content: '神秘信物', type: 'chekhov', status: 'resolved', plantedIn: 2, resolveDeadline: 5, resolvedIn: 2, dependsOn: [], weight: 'major' },
          { id: 2, content: '无关伏笔', type: 'emotional', status: 'pending', plantedIn: null, resolveDeadline: 10, resolvedIn: null, dependsOn: [], weight: 'light' },
        ],
      }),
      'utf-8',
    );

    const delRes = await app.request(`/api/projects/${projectId}/chapters/2`, { method: 'DELETE' });
    expect(delRes.ok).toBe(true);
    const data = await delRes.json();
    expect(data.foreshadowRefsCleared).toBe(2);

    const raw = JSON.parse(await fs.readFile(fp, 'utf-8'));
    expect(raw.foreshadows[0].plantedIn).toBeNull();
    expect(raw.foreshadows[0].resolvedIn).toBeNull();
    expect(raw.foreshadows[1].plantedIn).toBeNull(); // 无关条目不受影响
  });

  it('#9: DELETE /chapters/:num 重编号后续章节（正文/摘要/DB/伏笔引用同步平移）', async () => {
    // 建立第 3、4 章 + 大纲卡片 + 伏笔引用
    for (const n of [3, 4]) {
      const r = await app.request(`/api/projects/${projectId}/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: n, title: `第${n}章` }),
      });
      expect(r.ok).toBe(true);
      await fs.writeFile(
        path.join(projectDir, '.novel', 'chapters', `第${n}章.md`),
        `# 第${n}章\n\n正文内容。`,
        'utf-8',
      );
      await fs.writeFile(
        path.join(projectDir, '.novel', 'chapters', `第${n}章.summary.md`),
        `第${n}章摘要`,
        'utf-8',
      );
    }
    await fs.mkdir(path.join(projectDir, '.novel', 'outline', 'chapters'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.novel', 'outline', 'chapters', '第4章.md'), '大纲第4章', 'utf-8');
    await fs.writeFile(
      path.join(projectDir, '.novel', 'foreshadow.json'),
      JSON.stringify({
        foreshadows: [
          { id: 9, content: '伏笔A', type: 'chekhov', status: 'planted', plantedIn: 4, resolveDeadline: 8, resolvedIn: null, dependsOn: [], weight: 'major' },
        ],
      }),
      'utf-8',
    );

    // 删除第 3 章 + 重编号
    const delRes = await app.request(`/api/projects/${projectId}/chapters/3`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ renumber: true }),
    });
    expect(delRes.ok).toBe(true);
    const data = await delRes.json();
    expect(data.renumbered).toBe(1);
    expect(data.holeAt).toBeNull();

    // 磁盘：第4章 → 第3章
    await expect(fs.access(path.join(projectDir, '.novel', 'chapters', '第3章.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, '.novel', 'chapters', '第4章.md'))).rejects.toThrow();
    // 摘要与大纲卡片同步平移
    await expect(fs.access(path.join(projectDir, '.novel', 'chapters', '第3章.summary.md'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectDir, '.novel', 'outline', 'chapters', '第3章.md'))).resolves.toBeUndefined();
    // 伏笔引用前移：plantedIn 4 → 3，resolveDeadline 8 → 7
    const raw = JSON.parse(await fs.readFile(path.join(projectDir, '.novel', 'foreshadow.json'), 'utf-8'));
    expect(raw.foreshadows[0].plantedIn).toBe(3);
    expect(raw.foreshadows[0].resolveDeadline).toBe(7);
  });

  it('#9: DELETE 不重编号时返回 holeAt 提示', async () => {
    const r = await app.request(`/api/projects/${projectId}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: 5, title: '第五章' }),
    });
    expect(r.ok).toBe(true);
    const delRes = await app.request(`/api/projects/${projectId}/chapters/5`, { method: 'DELETE' });
    expect(delRes.ok).toBe(true);
    const data = await delRes.json();
    expect(data.holeAt).toBe(5);
    expect(data.renumbered).toBe(0);
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
      path.join(projectDir, '.novel', 'chapters', '第1章.md'),
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
