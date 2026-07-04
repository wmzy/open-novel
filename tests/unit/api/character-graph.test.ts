import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';

/**
 * GET /api/projects/:id/character-graph 端点测试。
 * 数据源：state.json.characters[].relationships；复用 buildRelationshipGraph 纯函数。
 */
describe('GET /api/projects/:id/character-graph', () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'char-graph-'));
    fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.novel/state.json'),
      JSON.stringify({
        characters: [
          { name: '甲', relationships: { '乙': '师徒' } },
          { name: '乙', relationships: { '甲': '师徒' } },
        ],
        timeline: '', activeForeshadows: [], lastUpdatedChapter: 1, updatedAt: '',
      }),
    );
    projectId = 'test_char_graph_1';
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.insert(projects).values({
      id: projectId,
      title: '关系图测试',
      path: tmpDir,
      genre: 'general',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('返回角色关系图 mermaid 源码', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/character-graph`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.graph).toContain('graph LR');
    expect(data.graph).toContain('甲');
    expect(data.graph).toContain('师徒');
  });

  it('无角色关系时返回 graph null', async () => {
    // 覆盖 state.json 为空
    fs.writeFileSync(
      path.join(tmpDir, '.novel/state.json'),
      JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 0, updatedAt: '' }),
    );
    const res = await apiApp.request(`/api/projects/${projectId}/character-graph`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.graph).toBeNull();
  });

  it('state.json 缺失时返回 graph null（不报错）', async () => {
    fs.unlinkSync(path.join(tmpDir, '.novel/state.json'));
    const res = await apiApp.request(`/api/projects/${projectId}/character-graph`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.graph).toBeNull();
  });
});
