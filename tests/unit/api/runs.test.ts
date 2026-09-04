import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects, runs as runsTable } from '../../../src/db/schema';
import { eq, inArray } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import { sanitizeStderr } from '../../../src/api/routes/runs';
import { createRun, finishRun, reconcileStaleRuns } from '../../../src/agent/run';

// 仅用于 autonomous 透传测试：mock composePrompt 使其在被调用后即抛错，
// 避免路由继续 launch 子进程；同时可断言传入参数。
const { mockCompose } = vi.hoisted(() => ({ mockCompose: vi.fn() }));
vi.mock('../../../src/agent/prompt-composer', () => ({ composePrompt: mockCompose }));
vi.mock('../../../src/agent/registry', () => ({ getAgentDef: () => ({ id: 'claude', label: 'Claude' }) }));
vi.mock('../../../src/agent/detection', () => ({ detectAgents: async () => [{ id: 'claude', available: true }] }));

describe('sanitizeStderr', () => {
  it('redacts OpenAI/Anthropic-style API keys (sk-...)', () => {
    const input = 'Error: invalid api key sk-ant-abc123def456ghi789jkl012mno345pqr';
    const out = sanitizeStderr(input);
    expect(out).toContain('sk-[REDACTED]');
    expect(out).not.toContain('sk-ant-abc123');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test_payload.signature';
    const out = sanitizeStderr(input);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('eyJhbGci');
  });

  it('redacts key=value credential pairs', () => {
    const cases = [
      'config: api_key=AIzaSyABCDEFGHIJKLMN0123456789xyz',
      'env: token="ghp_abcdef1234567890abcdef"',
      "set secret: 'mySuperSecretValue123'",
      'password=hunter2passwordExtra',
    ];
    for (const input of cases) {
      const out = sanitizeStderr(input);
      expect(out).toContain('[REDACTED]');
      // The original long secret value must not survive
      expect(out).not.toMatch(/(AIzaSy|ghp_|mySuperSecretValue|hunter2passwordExtra)/);
    }
  });

  it('preserves normal file paths and debug messages', () => {
    const input = 'WARN: /home/user/projects/novel/.novel/chapters/ch1.md not found\nDebug: agent started in /home/user/projects/novel';
    const out = sanitizeStderr(input);
    expect(out).toBe(input);
  });

  it('handles mixed content: path + secret in same line', () => {
    const input = 'Error reading /home/user/.config/key: api_key=sk-live-1234567890abcdefghijklmnop';
    const out = sanitizeStderr(input);
    expect(out).toContain('/home/user/.config/key');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-live-1234567890');
  });

  it('handles empty string', () => {
    expect(sanitizeStderr('')).toBe('');
  });
});

describe('POST /api/runs — autonomous 透传', () => {
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    mockCompose.mockReset();
    mockCompose.mockRejectedValue(new Error('stop-before-launch'));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runs-api-'));
    projectId = 'test_proj_autonomous';
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({ id: projectId, title: 't', path: tempDir, genre: 'wuxia' });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('body 中 autonomous=true 透传给 composePrompt', async () => {
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'concept', message: 'seed', autonomous: true }),
    });
    expect(mockCompose).toHaveBeenCalledWith(expect.objectContaining({ autonomous: true }));
  });

  it('缺省时 autonomous 为 false', async () => {
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'concept', message: 'seed' }),
    });
    expect(mockCompose).toHaveBeenCalledWith(expect.objectContaining({ autonomous: false }));
  });
});

describe('POST /api/runs — 样章门禁（sample-gate）', () => {
  let tempDir: string;
  let projectId: string;

  /** 在磁盘写 n 章正文（CJK 字数 ≥100）；zeroWordCount 控制额外写只含标题的空壳文件。 */
  async function seedChapters(n: number, zeroWordCount = 0) {
    await fs.mkdir(path.join(tempDir, '.novel', 'chapters'), { recursive: true });
    for (let i = 1; i <= n; i++) {
      await fs.writeFile(
        path.join(tempDir, '.novel', 'chapters', `第${i}章.md`),
        `# 第${i}章 标题\n\n${'这是样章正文内容。'.repeat(30)}`,
        'utf-8',
      );
    }
    for (let i = 1; i <= zeroWordCount; i++) {
      await fs.writeFile(
        path.join(tempDir, '.novel', 'chapters', `第${100 + i}章.md`),
        `# 第${100 + i}章`,
        'utf-8',
      );
    }
  }

  beforeEach(async () => {
    await ensureDbReady();
    mockCompose.mockReset();
    mockCompose.mockRejectedValue(new Error('stop-before-launch'));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runs-api-gate-'));
    projectId = 'test_proj_sample_gate';
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({ id: projectId, title: 't', path: tempDir, genre: 'wuxia' });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('stage=writing 且正文 <3 章时返回 409 sample-gate（0 章）', async () => {
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'writing', message: '写第4章' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('sample-gate');
    expect(data.completedSamples).toBe(0);
    expect(data.required).toBe(3);
    expect(data.message).toContain('样章');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('stage=writing 且正文仅 2 章时 409，completedSamples 反映实际章数', async () => {
    await seedChapters(2);
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'writing', message: '继续写' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('sample-gate');
    expect(data.completedSamples).toBe(2);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('wordCount=0 的空壳章节不计入样章门计数', async () => {
    await seedChapters(0, 3);
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'writing', message: '写第1章' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.completedSamples).toBe(0);
  });

  it('已有 ≥3 章正文的存量项目直通（不拦截）', async () => {
    await seedChapters(3);
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'writing', message: '写第4章' }),
    });
    expect(mockCompose).toHaveBeenCalled();
  });

  it('携带 force: true 时旁路门禁', async () => {
    await seedChapters(1);
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'writing', message: '写第2章', force: true }),
    });
    expect(mockCompose).toHaveBeenCalled();
  });

  it('stage=sample 放行（样章阶段本身写正文，0 章也可开始）', async () => {
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'sample', message: '开始写样章' }),
    });
    expect(mockCompose).toHaveBeenCalled();
  });

  it('非 writing 阶段不受门禁影响', async () => {
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'scenes', message: '规划场景' }),
    });
    expect(mockCompose).toHaveBeenCalled();
  });

  it('stage=drafting（/draft 命令）同样被样章门拦截', async () => {
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'drafting', message: '写第4章' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('sample-gate');
    expect(data.completedSamples).toBe(0);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('stage=revision（/revision 命令）同样被样章门拦截（防旁路写新章）', async () => {
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'revision', message: '写第2章' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('sample-gate');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('stage=polish（/polish 命令）同样被样章门拦截（防旁路写新章）', async () => {
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'polish', message: '写第2章' }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('sample-gate');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('已有 ≥3 章正文时 revision/polish 正常放行', async () => {
    await seedChapters(3);
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'revision', message: '修订第1章' }),
    });
    expect(mockCompose).toHaveBeenCalled();
  });

  it('未知 stage（typo）返回 400 invalid-stage', async () => {
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'writng', message: '写第1章' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('invalid-stage');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('隐藏阶段 decompose/enrich 通过 stage 校验', async () => {
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'decompose', message: '拆书' }),
    });
    expect(mockCompose).toHaveBeenCalled();
  });

  it('stage=drafting 携带 force: true 时旁路门禁', async () => {
    await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, agentId: 'claude', stage: 'drafting', message: '写第1章', force: true }),
    });
    expect(mockCompose).toHaveBeenCalled();
  });
});

describe('写路径项目串行锁', () => {
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runs-api-lock-'));
    projectId = 'test_proj_lock_guard';
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({ id: projectId, title: 't', path: tempDir, genre: 'wuxia' });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('活跃 run 存在时 POST /rollback 返回 409 run-in-progress', async () => {
    const run = createRun({ projectId, agentId: 'claude', skillId: 'novel', stage: 'writing', conversationId: 'conv_lock' });
    run.status = 'running';
    try {
      const res = await apiApp.request(`/api/runs/projects/${projectId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash: 'abc123' }),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('run-in-progress');
    } finally {
      finishRun(run, 'succeeded');
    }
  });

  it('无活跃 run 时 POST /rollback 正常进入回滚逻辑（commit 不存在返回 500）', async () => {
    const res = await apiApp.request(`/api/runs/projects/${projectId}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitHash: 'nonexistent' }),
    });
    // 锁不拦截；restoreSnapshot 失败 → 500（证明已越过锁检查）
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Rollback failed');
  });

  it('活跃 run 存在时 POST /chapters 创建章节被锁拒绝（409 run-in-progress）', async () => {
    const run = createRun({ projectId, agentId: 'claude', skillId: 'novel', stage: 'writing', conversationId: 'conv_lock_ch' });
    run.status = 'running';
    try {
      const res = await apiApp.request(`/api/projects/${projectId}/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: 1, title: '第一章' }),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('run-in-progress');
    } finally {
      finishRun(run, 'succeeded');
    }
  });

  it('活跃 run 存在时 POST /api/backup/restore 被全局排他拒绝', async () => {
    const run = createRun({ projectId, agentId: 'claude', skillId: 'novel', stage: 'writing', conversationId: 'conv_lock_bk' });
    run.status = 'running';
    try {
      const res = await apiApp.request('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'whatever.tar.gz' }),
      });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toContain('正在运行的写作任务');
    } finally {
      finishRun(run, 'succeeded');
    }
  });
});

describe('启动对账 reconcileStaleRuns', () => {
  it('把 DB 中滞留的 queued/running run 置为 failed，终态 run 不受影响', async () => {
    await ensureDbReady();
    const ids = ['recon_run_a', 'recon_run_b', 'recon_run_c', 'recon_run_d'];
    try {
      await db.insert(runsTable).values([
        { id: 'recon_run_a', agent: 'claude', status: 'running', createdAt: new Date() },
        { id: 'recon_run_b', agent: 'claude', status: 'queued', createdAt: new Date() },
        { id: 'recon_run_c', agent: 'claude', status: 'succeeded', createdAt: new Date() },
        { id: 'recon_run_d', agent: 'claude', status: 'failed', createdAt: new Date() },
      ]);
      const n = await reconcileStaleRuns();
      expect(n).toBe(2);
      const rows = await db.select().from(runsTable).where(inArray(runsTable.id, ids));
      const byId = new Map(rows.map((r) => [r.id, r.status]));
      expect(byId.get('recon_run_a')).toBe('failed');
      expect(byId.get('recon_run_b')).toBe('failed');
      expect(byId.get('recon_run_c')).toBe('succeeded');
      expect(byId.get('recon_run_d')).toBe('failed');
      // 幂等：再跑一次置 0 行
      expect(await reconcileStaleRuns()).toBe(0);
    } finally {
      await db.delete(runsTable).where(inArray(runsTable.id, ids)).catch(() => {});
    }
  });
});

describe('导入项目阶段推断（inferStageFromDisk）', () => {
  it('有 ≥3 章有效正文的目录导入后 currentStage=writing', async () => {
    await ensureDbReady();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-infer-'));
    await fs.mkdir(path.join(dir, '.novel', 'chapters'), { recursive: true });
    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(path.join(dir, '.novel', 'chapters', `第${i}章.md`), `# 第${i}章\n\n${'这是正文内容。'.repeat(20)}`, 'utf-8');
    }
    const res = await apiApp.request('/api/projects/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project.currentStage).toBe('writing');
    // 清理
    await db.delete(projects).where(eq(projects.id, data.project.id)).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('有 1-2 章正文的目录导入后 currentStage=sample', async () => {
    await ensureDbReady();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'import-infer2-'));
    await fs.mkdir(path.join(dir, '.novel', 'chapters'), { recursive: true });
    await fs.writeFile(path.join(dir, '.novel', 'chapters', '第1章.md'), `# 第1章\n\n${'这是正文内容。'.repeat(20)}`, 'utf-8');
    const res = await apiApp.request('/api/projects/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project.currentStage).toBe('sample');
    await db.delete(projects).where(eq(projects.id, data.project.id)).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
});
