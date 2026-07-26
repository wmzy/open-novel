import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import { ensureGitInit, createSnapshot, ensureDraftBranch } from '../../../src/agent/snapshot';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

describe('review API', () => {
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-api-'));
    await ensureGitInit(tempDir);
    await fs.writeFile(path.join(tempDir, 'README.md'), 'init\n');
    await createSnapshot(tempDir, 'init');
    await ensureDraftBranch(tempDir);

    projectId = 'test_proj_review_1';
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({
      id: projectId,
      title: '审阅测试',
      path: tempDir,
      genre: 'wuxia',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('GET /review 无待审阅时返回空', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/review`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commits).toHaveLength(0);
    expect(data.files).toHaveLength(0);
  });

  it('GET /review 有 draft 改动时返回 diff', async () => {
    await fs.writeFile(path.join(tempDir, 'ch1.md'), '第一章\n');
    await createSnapshot(tempDir, '写第一章');

    const res = await apiApp.request(`/api/projects/${projectId}/review`);
    const data = await res.json();
    expect(data.commits.length).toBeGreaterThanOrEqual(1);
    expect(data.files.some((f: { path: string }) => f.path === 'ch1.md')).toBe(true);
  });

  it('POST /review/merge 把 main ff 到 draft', async () => {
    await fs.writeFile(path.join(tempDir, 'ch1.md'), '第一章\n');
    await createSnapshot(tempDir, '写第一章');

    const res = await apiApp.request(`/api/projects/${projectId}/review/merge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // merge 后 review 应为空
    const after = await apiApp.request(`/api/projects/${projectId}/review`);
    const afterData = await after.json();
    expect(afterData.commits).toHaveLength(0);
  });

  it('POST /review/discard 丢弃 draft 改动', async () => {
    await fs.writeFile(path.join(tempDir, 'ch1.md'), '第一章\n');
    await createSnapshot(tempDir, '写第一章');

    const res = await apiApp.request(`/api/projects/${projectId}/review/discard`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    await expect(fs.access(path.join(tempDir, 'ch1.md'))).rejects.toThrow();
  });

  it('项目不存在时返回 404', async () => {
    const res = await apiApp.request('/api/projects/nonexistent/review');
    expect(res.status).toBe(404);
  });
});

describe('迁移钩子：GET /:id 触发 ensureDraftBranch', () => {
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-api-'));
    await ensureGitInit(tempDir);
    await fs.writeFile(path.join(tempDir, 'README.md'), 'init\n');
    await createSnapshot(tempDir, 'init');
    // 注意：不预先 ensureDraftBranch，让 GET /:id 触发

    projectId = 'test_proj_migrate_1';
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({
      id: projectId,
      title: '迁移测试',
      path: tempDir,
      genre: 'wuxia',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('GET /api/projects/:id 后 draft 分支存在', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'draft'], { cwd: tempDir });
    expect(stdout.trim()).toBeTruthy();
  });
});
