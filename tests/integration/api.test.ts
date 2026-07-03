import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
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
      const diskBefore = fs.readFileSync(
        path.join(novelDir, 'outline-detailed.md'),
        'utf-8',
      );
      const res = await app.request(`/api/projects/${projectId}/templates/outline-detailed`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.name).toBe('outline-detailed');
      expect(data.path).toBe('outline-detailed.md');
      // 生成的预览内容包含第 8 章（8 章项目）
      expect(data.content).toContain('第 8 章');
      // 仅预览：磁盘内容未被覆盖，仍为静态 3 章模板
      const diskAfter = fs.readFileSync(
        path.join(novelDir, 'outline-detailed.md'),
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
      expect(fs.existsSync(path.join(novelDir, 'outline-detailed.md'))).toBe(true);
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
      expect(data.written.every((w: { backedUp: boolean }) => w.backedUp)).toBe(true);
      expect(fs.existsSync(path.join(novelDir, 'outline-detailed.md.bak'))).toBe(true);
    });
  });
});
