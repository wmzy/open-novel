import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import { sanitizeStderr } from '../../../src/api/routes/runs';

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
});
