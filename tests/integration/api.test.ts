import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import app from '../../src/api-app';
import { ensureDbReady } from '../../src/db/drizzle';
import { initPlugins } from '../../src/plugins/registry';

describe('API Integration', () => {
  beforeAll(async () => {
    await ensureDbReady();
    initPlugins();
  });

  it('GET /api/health returns ok', async () => {
    const res = await app.request('/api/health');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('GET /api/projects returns array', async () => {
    const res = await app.request('/api/projects');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.projects)).toBe(true);
  });

  it('POST /api/projects creates a project', async () => {
    const testDir = `/tmp/open-novel-test-${Date.now()}`;
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test Novel', genre: 'fantasy', path: testDir }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.project.title).toBe('Test Novel');
  });

  it('POST /api/projects defaults path to ~/novels/<拼音 slug> when omitted', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'on-home-'));
    vi.stubEnv('HOME', home);
    try {
      const ts = Date.now();
      const res = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `测试${ts}`, genre: 'general' }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      // 中文标题转无调拼音（测试 → ceshi），非字母数字折叠。
      expect(data.project.path).toBe(path.join(home, 'novels', `ceshi${ts}`));
      expect(fs.existsSync(data.project.path)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/projects expands ~ prefix in explicit path', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'on-home-'));
    vi.stubEnv('HOME', home);
    try {
      const res = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Tilde Test', genre: 'general', path: '~/my-novel-dir' }),
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.project.path).toBe(path.join(home, 'my-novel-dir'));
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/projects dedupes default dir for same title', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'on-home-'));
    vi.stubEnv('HOME', home);
    try {
      const first = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '同名小说', genre: 'general' }),
      });
      expect(first.ok).toBe(true);
      const second = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '同名小说', genre: 'general' }),
      });
      expect(second.ok).toBe(true);
      const p1 = (await first.json()).project;
      const p2 = (await second.json()).project;
      expect(p1.path).toBe(path.join(home, 'novels', 'tongmingxiaoshuo'));
      // 同名 → 追加序号，避免 409 拦截
      expect(p2.path).toBe(path.join(home, 'novels', 'tongmingxiaoshuo-2'));
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/projects caps long CJK title slug at 80 chars', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'on-home-'));
    vi.stubEnv('HOME', home);
    try {
      // title 列允许 200 字；拼音展开后远超单个路径组件 255 字节上限。
      const title = `长篇标题${Date.now()}`.padEnd(200, '字');
      const res = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, genre: 'general' }),
      });
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(path.basename(data.project.path).length).toBeLessThanOrEqual(80);
      expect(fs.existsSync(path.join(data.project.path, '.novel'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/projects serializes concurrent same-title default creates', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'on-home-'));
    vi.stubEnv('HOME', home);
    try {
      const title = `并发同名${Date.now()}`;
      const create = () => app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, genre: 'general' }),
      });
      // 并发提交：路径选择与插入必须串行，否则会选中同一目录并各插一条记录。
      const [r1, r2] = await Promise.all([create(), create()]);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      const [p1, p2] = [await r1.json(), await r2.json()];
      const paths = [p1.project.path, p2.project.path].sort();
      expect(paths[0]).not.toBe(paths[1]);
      expect(paths[1]).toBe(`${paths[0]}-2`);
      expect(fs.existsSync(path.join(paths[0], '.novel'))).toBe(true);
      expect(fs.existsSync(path.join(paths[1], '.novel'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/projects skips default dir whose .novel was deleted but row remains', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'on-home-'));
    vi.stubEnv('HOME', home);
    try {
      const title = `残留项目${Date.now()}`;
      const create = () => app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, genre: 'general' }),
      });
      const first = await create();
      expect(first.status).toBe(201);
      const p1 = (await first.json()).project;
      // 模拟用户手删工作区文件但 DB 记录残留（GET / 显示 pathExists:false）。
      fs.rmSync(path.join(p1.path, '.novel'), { recursive: true, force: true });
      const second = await create();
      expect(second.status).toBe(201);
      const p2 = (await second.json()).project;
      // 不能因 DB 残留记录命中 path-exists 409，而应自动跳到 -2。
      expect(p2.path).toBe(`${p1.path}-2`);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('POST /api/projects with intent writes .novel/intent.md', async () => {
    const testDir = `/tmp/open-novel-intent-${Date.now()}`;
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Intent Test',
        path: testDir,
        genre: 'wuxia',
        intent: { pacing: '每章 4000 字，张弛有度' },
      }),
    });
    expect(res.ok).toBe(true);
    const intentPath = path.join(testDir, '.novel', 'intent.md');
    expect(fs.existsSync(intentPath)).toBe(true);
    const content = fs.readFileSync(intentPath, 'utf-8');
    expect(content).toContain('## 节奏偏好');
    expect(content).toContain('每章 4000 字，张弛有度');
    // 未提供的维度保持「未设定」
    expect(content).toContain('核心角色（弧线优先）：未设定');
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('POST /api/projects without intent does not create intent.md', async () => {
    const testDir = `/tmp/open-novel-nointent-${Date.now()}`;
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No Intent', path: testDir, genre: 'wuxia' }),
    });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.novel', 'intent.md'))).toBe(false);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('GET /api/agents returns detected agents', async () => {
    const res = await app.request('/api/agents');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.agents)).toBe(true);
  });

  it('GET /api/plugins returns loaded plugins', async () => {
    const res = await app.request('/api/plugins');
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.plugins)).toBe(true);
  });

  it('GET /api/unknown returns 404', async () => {
    // The API app does not serve a root '/' route (the HTML shell is delivered
    // by Vite/static hosting). Verify the API routing contract instead: an
    // unmatched /api path yields a 404 rather than a false 200.
    const res = await app.request('/api/this-route-does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST /api/backup 无变更时跳过并返回已有备份', async () => {
    const first = await app.request('/api/backup', { method: 'POST' });
    expect(first.ok).toBe(true);
    const firstData = await first.json();
    expect(firstData.ok).toBe(true);
    expect(firstData.skipped).toBe(false);
    expect(firstData.filename).toMatch(/^pglite-.*\.tar\.gz$/);

    const second = await app.request('/api/backup', { method: 'POST' });
    expect(second.ok).toBe(true);
    const secondData = await second.json();
    expect(secondData.ok).toBe(true);
    expect(secondData.skipped).toBe(true);
    expect(secondData.filename).toBe(firstData.filename);
  });

  describe('template generation endpoints', () => {
    let projectId: string;
    let novelDir: string;

    beforeAll(async () => {
      const dir = `/tmp/open-novel-tmpl-${Date.now()}`;
      const res = await app.request('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '模板测试',
          genre: 'general',
          path: dir,
          chapterCount: 8,
          targetWords: 40000,
          perspective: 'first-person',
        }),
      });
      const data = await res.json();
      projectId = data.project.id;
      novelDir = path.join(dir, '.novel');
    });

    it('GET preview returns generated content without writing file', async () => {
      // initWorkspace 已拷贝静态模板（3 章），读取磁盘原始内容用于对比
      // outline-detailed 现在是拆分型，预览用 outline-brief 代替
      const diskBefore = fs.readFileSync(
        path.join(novelDir, 'outline-brief.md'),
        'utf-8',
      );
      const res = await app.request(`/api/projects/${projectId}/templates/outline-brief`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.name).toBe('outline-brief');
      expect(data.path).toBe('outline-brief.md');
      // 生成的预览内容包含 8 章（8 章项目）的概要结构
      expect(data.content).toContain('8');
      // 仅预览：磁盘内容未被覆盖，仍为静态 3 章模板
      const diskAfter = fs.readFileSync(
        path.join(novelDir, 'outline-brief.md'),
        'utf-8',
      );
      expect(diskAfter).toBe(diskBefore);
      expect(diskAfter).not.toContain('第 8 章');
    });

    it('GET unknown template name returns 400', async () => {
      const res = await app.request(`/api/projects/${projectId}/templates/nope`);
      expect(res.status).toBe(400);
    });

    it('POST generate-templates writes all files to .novel/', async () => {
      const res = await app.request(`/api/projects/${projectId}/generate-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.written.length).toBe(5);
      // outline-detailed 是拆分型：写入 outline/ 目录
      expect(fs.existsSync(path.join(novelDir, 'outline', 'index.md'))).toBe(true);
      expect(fs.existsSync(path.join(novelDir, 'outline', 'chapters', '第1章.md'))).toBe(true);
      expect(fs.existsSync(path.join(novelDir, 'scenes.md'))).toBe(true);
      expect(fs.existsSync(path.join(novelDir, 'characters', 'profiles.md'))).toBe(true);
      expect(fs.existsSync(path.join(novelDir, 'outline-brief.md'))).toBe(true);
    });

    it('POST again backs up existing files as .bak', async () => {
      const res = await app.request(`/api/projects/${projectId}/generate-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      // outline-detailed 是目录型，不会备份为 .bak；其余 4 个文件会备份
      const backedUpCount = data.written.filter((w: { backedUp: boolean }) => w.backedUp).length;
      expect(backedUpCount).toBeGreaterThanOrEqual(4);
      expect(fs.existsSync(path.join(novelDir, 'outline-brief.md.bak'))).toBe(true);
    });
  });
});
