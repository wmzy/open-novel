/**
 * 事实核查路由 /api/projects/:projectId/check/fact-check 的机械检查路径。
 * 不调用 agent（deep:false），覆盖 POV 知情越界与人名近似笔误的端到端返回结构。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import checkRouter from '../../../src/api/routes/check';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';

const app = new Hono();
app.route('/api/projects/:projectId/check', checkRouter);

describe('POST /api/projects/:projectId/check/fact-check (deep:false)', () => {
  let tmpDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-check-'));
    projectId = 'test_fact_check_1';
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.insert(projects).values({
      id: projectId,
      title: '事实核查测试',
      path: tmpDir,
      genre: 'general',
      chapterCount: 3,
    });

    const novel = path.join(tmpDir, '.novel');
    fs.mkdirSync(path.join(novel, 'chapters'), { recursive: true });
    fs.mkdirSync(path.join(novel, 'outline', 'chapters'), { recursive: true });
    fs.writeFileSync(
      path.join(novel, 'outline', 'chapters', '第2章.md'),
      '## 第 2 章：夜谈\n- **POV**：林青\n- **核心事件**：夜谈',
    );
    fs.writeFileSync(
      path.join(novel, 'chapters', '第2章.md'),
      '林清说：“林青，原来你的身世是这样。”\n林青沉默着，没有应声。',
    );
    fs.mkdirSync(path.join(novel, 'characters'), { recursive: true });
    fs.writeFileSync(
      path.join(novel, 'characters', 'profiles.md'),
      '# 角色档案\n\n## 林青（青哥）\n- **性格**：沉稳\n',
    );
    fs.writeFileSync(
      path.join(novel, 'character-knowledge.json'),
      JSON.stringify({
        characters: [{
          name: '林青',
          knows: [],
          doesNotKnow: ['自己的真实身世'],
          updatedChapter: 2,
        }],
      }),
    );
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('返回 POV 越界与人名笔误，每条带 severity/chapter/quote', async () => {
    const res = await app.request(`/api/projects/${projectId}/check/fact-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterNum: 2, deep: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      pov: string | null;
      findings: Array<{ type: string; severity: string; chapter: number; quote: string; detail: string; source: string }>;
      mechanical: unknown[];
      semantic: unknown[];
    };
    expect(body.pov).toBe('林青');
    expect(body.mechanical.length).toBeGreaterThanOrEqual(2);
    expect(body.semantic).toEqual([]);

    const leak = body.findings.find((finding) => finding.type === 'pov-leakage');
    expect(leak).toBeDefined();
    expect(leak!.severity).toBe('major');
    expect(leak!.chapter).toBe(2);
    expect(leak!.quote).toContain('身世');
    expect(leak!.source).toBe('mechanical');

    const nameIssue = body.findings.find((finding) => finding.type === 'name-inconsistency');
    expect(nameIssue).toBeDefined();
    expect(nameIssue!.severity).toBe('minor');
    expect(nameIssue!.quote).toContain('林清');
  });

  it('章节正文不存在时 404', async () => {
    const res = await app.request(`/api/projects/${projectId}/check/fact-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterNum: 99, deep: false }),
    });
    expect(res.status).toBe(404);
  });
});
