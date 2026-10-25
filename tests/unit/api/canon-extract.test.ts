// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import apiApp from '../../../src/api-app';
import { createRun, finishRun } from '../../../src/agent/run';
import { readCanon } from '../../../src/shared/canon';

// 只替换 callPiOnce（canon-extractor 的默认 LLM 通道），保留模块其余导出
// （api-app → runs.ts 还依赖 startPiAgent 等）。
vi.mock('../../../src/agent/pi/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agent/pi/runtime')>();
  return { ...actual, callPiOnce: vi.fn(async () => '{}') };
});

// vi.mock 会被提升到 import 之前，此处拿到的是 mock 后的 callPiOnce
const { callPiOnce } = await import('../../../src/agent/pi/runtime');

const PROJECT_ID = 'canon_extract_project';
let projectDir: string;

const CHAPTER_BODY = '第3章 风雪夜\n\n沈青梧揭开斗篷，左臂旧伤隐隐作痛。她效力于幽州军。\n';
const EXTRACT_REPLY = '```json\n'
  + '{"entities":[{"name":"沈青梧","type":"character","description":"北境药师，左臂有旧伤"}],'
  + '"facts":[{"subject":"沈青梧","predicate":"效力于","object":"幽州军"}],'
  + '"knowledge":{"沈青梧":{"knows":["主帅已阵亡"]}}}\n'
  + '```';

beforeEach(async () => {
  await ensureDbReady();
  vi.mocked(callPiOnce).mockReset().mockImplementation(async () => '{}');
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-extract-api-'));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: 'Canon Extract',
    path: projectDir,
    genre: 'novel',
    targetWords: 1000,
    chapterCount: 3,
    currentStage: 'writing',
  });
  await fs.mkdir(path.join(projectDir, '.novel', 'chapters'), { recursive: true });
  await fs.writeFile(path.join(projectDir, '.novel', 'chapters', '第3章.md'), CHAPTER_BODY, 'utf-8');
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('POST /api/projects/:id/canon/extract', () => {
  it('对磁盘章节正文执行提取并写回台账，透传 model 与正文', async () => {
    vi.mocked(callPiOnce).mockImplementation(async () => EXTRACT_REPLY);
    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/canon/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter: 3, model: 'glm-4.7' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(true);
    expect(body.entities).toBe(1);
    expect(body.facts).toBe(1);
    expect(body.knowledge).toBe(1);

    // 默认通道接线：callPiOnce 收到正文 + 章号 prompt、cwd=项目目录、model 覆盖
    const [prompt, cwd, timeoutMs, options] = vi.mocked(callPiOnce).mock.calls[0];
    expect(prompt).toContain('第 3 章');
    expect(prompt).toContain('沈青梧');
    expect(cwd).toBe(projectDir);
    expect(timeoutMs).toBeGreaterThan(0);
    expect((options as { model?: string | null } | undefined)?.model).toBe('glm-4.7');

    // 台账落盘
    const ledger = await readCanon(projectDir);
    expect(ledger.entities.map((e) => e.name)).toContain('沈青梧');
    const log = await fs.readFile(path.join(projectDir, '.novel', 'canon', 'changes.jsonl'), 'utf-8');
    expect(JSON.parse(log.trim().split('\n')[0]).chapter).toBe(3);
  });

  it('兼容「第N章 标题.md」近似命名', async () => {
    vi.mocked(callPiOnce).mockImplementation(async () => EXTRACT_REPLY);
    await fs.rename(
      path.join(projectDir, '.novel', 'chapters', '第3章.md'),
      path.join(projectDir, '.novel', 'chapters', '第3章 风雪夜.md'),
    );
    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/canon/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter: 3 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { applied?: boolean }).applied).toBe(true);
  });

  it('章节正文不存在 → 404', async () => {
    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/canon/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter: 9 }),
    });
    expect(res.status).toBe(404);
    expect(callPiOnce).not.toHaveBeenCalled();
  });

  it('body.chapter 缺失/非法 → 400', async () => {
    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/canon/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('run 进行中 → 409 run-in-progress（处理器正确 return 锁响应，而非 404）', async () => {
    const run = createRun({
      projectId: PROJECT_ID,
      agentId: 'pi',
      skillId: 'novel',
      stage: 'writing',
      conversationId: 'conv-canon-extract-test',
    });
    try {
      const res = await apiApp.request(`/api/projects/${PROJECT_ID}/canon/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapter: 3 }),
      });
      expect(res.status).toBe(409);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('run-in-progress');
      expect(body.runId).toBe(run.id);
      expect(callPiOnce).not.toHaveBeenCalled();
    } finally {
      finishRun(run, 'canceled');
      await run.finished;
    }
  });

  it('模型输出非法 → 200 + ok:false（端点不炸、不写台账）', async () => {
    vi.mocked(callPiOnce).mockImplementation(async () => '我无法完成该任务。');
    const res = await apiApp.request(`/api/projects/${PROJECT_ID}/canon/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter: 3 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.applied).toBe(false);
    expect(typeof body.error).toBe('string');
    expect((await readCanon(projectDir)).entities).toHaveLength(0);
  });
});
