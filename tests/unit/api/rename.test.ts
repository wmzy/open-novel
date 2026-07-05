import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';

/**
 * rename API 端点测试。
 * 核心的 performRename 替换逻辑由 tests/unit/shared/rename.test.ts 覆盖；
 * 此处聚焦端点契约：参数校验、预检拦截、真实文件替换端到端。
 */
describe('POST /api/projects/:projectId/rename', () => {
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-api-'));
    const novelDir = path.join(tempDir, '.novel');
    await fs.mkdir(path.join(novelDir, 'characters'), { recursive: true });
    await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
    await fs.writeFile(
      path.join(novelDir, 'characters', 'profiles.md'),
      '## 一、宋公明（主角）\n\n## 二、林冲（配角）\n',
    );
    await fs.writeFile(
      path.join(novelDir, 'chapters', '第1章.md'),
      '# 第一章\n\n宋公明推开了门。\n',
    );
    projectId = 'test_proj_rename_1';
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({
      id: projectId,
      title: '测试重命名',
      path: tempDir,
      genre: 'wuxia',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('缺少 oldName/newName 时返回 400', async () => {
    const res = await apiApp.request('/api/projects/fake-proj/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('required');
  });

  it('精确全名替换成功并返回统计', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldName: '宋公明', newName: '林寒声' }),
    });
    if (res.status !== 200) {
      const dbg = await res.json();
      throw new Error(`rename failed: ${JSON.stringify(dbg)}`);
    }
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filesModified).toBeGreaterThanOrEqual(2);
    expect(body.totalReplacements).toBeGreaterThanOrEqual(2);
    expect(body.newNameValid).toBe(true);

    const ch1 = await fs.readFile(path.join(tempDir, '.novel', 'chapters', '第1章.md'), 'utf-8');
    expect(ch1).toContain('林寒声');
    expect(ch1).not.toContain('宋公明');
  });

  it('oldName 是其他全名子串时返回 409', async () => {
    // "宋公" 是 "宋公明" 的子串 → 应被子串冲突预检拦截
    // newName 选一个能通过 checkName 的（避免先被音韵检查拦截）
    const res = await apiApp.request(`/api/projects/${projectId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldName: '宋公', newName: '林寒声' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('precheck_failed');
    expect(body.substringConflicts).toContain('宋公明');
  });

  it('单字 oldName 被拒绝（避免误伤）', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldName: '沈', newName: '林' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('完整全名');
  });
});
