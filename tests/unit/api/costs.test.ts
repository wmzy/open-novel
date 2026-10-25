// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { conversations, projects, runEvents, runs as runsTable, userSettings } from '../../../src/db/schema';
import costsRouter, { COST_BUDGET_SETTING_KEY } from '../../../src/api/routes/costs';

// 本路由尚未由父任务挂载进 api-app，测试内自行挂到与线上一致的前缀
const app = new Hono().route('/api/projects/:projectId/costs', costsRouter);

const PROJ_A = 'costs_proj_a';
const PROJ_B = 'costs_proj_b';

interface SummaryBody {
  byModel: Array<{ model: string | null; runs: number; tokens: number; costUsd: number }>;
  byRun: Array<{ runId: string; mode: string; status: string; tokens: number; costUsd: number; startedAt: string | null }>;
  byChapter: Array<{ chapter: number; tokens: number; costUsd: number }>;
  byDay: Array<{ day: string; tokens: number; costUsd: number }>;
  total: { tokens: number; costUsd: number; runs: number; unknownCostRuns: number };
  budget: { budgetUsd: number | null; percent: number | null; exceeded: boolean };
}

async function summary(projectId: string): Promise<SummaryBody> {
  const res = await app.request(`/api/projects/${projectId}/costs/summary`);
  expect(res.status).toBe(200);
  return res.json() as Promise<SummaryBody>;
}

async function budget(projectId: string) {
  const res = await app.request(`/api/projects/${projectId}/costs/budget`);
  expect(res.status).toBe(200);
  return res.json() as Promise<{ budgetUsd: number | null; spentUsd: number; percent: number | null; exceeded: boolean }>;
}

let seq = 0;

async function insertUsage(opts: {
  runId: string;
  used: number;
  costUsd: number | null;
  model?: string | null;
  createdAt?: Date;
}) {
  seq += 1;
  await db.insert(runEvents).values({
    id: `cev_${PROJ_A}_${seq}`,
    runId: opts.runId,
    seq,
    type: 'agent',
    data: { type: 'runtime_usage', used: opts.used, size: 128000, costUsd: opts.costUsd, model: opts.model ?? null },
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
}

async function insertArtifacts(runId: string, paths: string[]) {
  seq += 1;
  await db.insert(runEvents).values({
    id: `cev_${PROJ_A}_${seq}`,
    runId,
    seq,
    type: 'artifacts',
    data: { count: paths.length, paths },
  });
}

/** 两项目各一条对话 + 三个 run（A）/ 一个 run（B）。 */
async function seed() {
  await db.insert(conversations).values([
    { id: 'conv_cost_a', projectId: PROJ_A, agentId: 'pi', stage: 'writing' },
    { id: 'conv_cost_b', projectId: PROJ_B, agentId: 'pi', stage: 'writing' },
  ]);
  await db.insert(runsTable).values([
    { id: 'run_cost_1', conversationId: 'conv_cost_a', agent: 'pi', status: 'succeeded', mode: 'generate' },
    { id: 'run_cost_2', conversationId: 'conv_cost_a', agent: 'pi', status: 'succeeded', mode: 'revise', payload: { targetFile: 'chapters/第3章.md' } },
    { id: 'run_cost_3', conversationId: 'conv_cost_a', agent: 'pi', status: 'failed', mode: 'generate' },
    { id: 'run_cost_b1', conversationId: 'conv_cost_b', agent: 'pi', status: 'succeeded', mode: 'generate' },
  ]);
}

beforeEach(async () => {
  await ensureDbReady();
  seq = 0;
  // runs.conversationId 是 set null 外联：删项目后 run 行会残留成孤儿，需显式清理
  await db.delete(runsTable).where(inArray(runsTable.id, ['run_cost_1', 'run_cost_2', 'run_cost_3', 'run_cost_b1']));
  await db.delete(projects).where(eq(projects.id, PROJ_A));
  await db.delete(projects).where(eq(projects.id, PROJ_B));
  await db.delete(userSettings).where(eq(userSettings.key, COST_BUDGET_SETTING_KEY));
  await db.insert(projects).values([
    { id: PROJ_A, title: '成本A', path: await fs.mkdtemp(path.join(os.tmpdir(), 'costs-a-')), genre: 'wuxia' },
    { id: PROJ_B, title: '成本B', path: await fs.mkdtemp(path.join(os.tmpdir(), 'costs-b-')), genre: 'wuxia' },
  ]);
  await seed();
});

afterEach(async () => {
  // 级联清掉 conversations → runs → run_events
  await db.delete(projects).where(eq(projects.id, PROJ_A));
  await db.delete(projects).where(eq(projects.id, PROJ_B));
  await db.delete(userSettings).where(eq(userSettings.key, COST_BUDGET_SETTING_KEY));
});

describe('GET /api/projects/:projectId/costs/summary', () => {
  it('各维度聚合数字与造数精确一致', async () => {
    const day1 = new Date('2026-10-20T10:00:00Z');
    const day2 = new Date('2026-10-21T10:00:00Z');
    // run1：两条 usage（不同模型、不同天），写第 5 章 → 归属第 5 章
    await insertUsage({ runId: 'run_cost_1', used: 1000, costUsd: 0.5, model: 'model-a', createdAt: day1 });
    await insertUsage({ runId: 'run_cost_1', used: 500, costUsd: 0.25, model: 'model-b', createdAt: day2 });
    await insertArtifacts('run_cost_1', ['chapters/第5章.md']);
    // run2：一条 usage 缺 model 且 costUsd 缺失，revise 目标第 3 章 → 归属第 3 章
    await insertUsage({ runId: 'run_cost_2', used: 200, costUsd: null, createdAt: day2 });
    // run3：无 usage 事件 → 不计入任何维度

    const body = await summary(PROJ_A);

    expect(body.total).toEqual({ tokens: 1700, costUsd: 0.75, runs: 2, unknownCostRuns: 1 });

    expect(body.byModel).toHaveLength(3);
    const byModel = new Map(body.byModel.map((m) => [m.model, m]));
    expect(byModel.get('model-a')).toEqual({ model: 'model-a', runs: 1, tokens: 1000, costUsd: 0.5 });
    expect(byModel.get('model-b')).toEqual({ model: 'model-b', runs: 1, tokens: 500, costUsd: 0.25 });
    expect(byModel.get(null)).toEqual({ model: null, runs: 1, tokens: 200, costUsd: 0 });

    // 同批插入的 run createdAt 相同，顺序按 runId 决胜——断言按 id 索引
    const byRun = new Map(body.byRun.map((r) => [r.runId, r]));
    expect(byRun.get('run_cost_1')).toMatchObject({ mode: 'generate', status: 'succeeded', tokens: 1500, costUsd: 0.75, startedAt: null });
    expect(byRun.get('run_cost_2')).toMatchObject({ mode: 'revise', status: 'succeeded', tokens: 200, costUsd: 0, startedAt: null });
    expect(body.byRun).toHaveLength(2);

    expect(body.byChapter).toEqual([
      { chapter: 3, tokens: 200, costUsd: 0 },
      { chapter: 5, tokens: 1500, costUsd: 0.75 },
    ]);

    expect(body.byDay).toEqual([
      { day: '2026-10-20', tokens: 1000, costUsd: 0.5 },
      { day: '2026-10-21', tokens: 700, costUsd: 0.25 },
    ]);

    // 未设预算：budget 块为 null / false
    expect(body.budget).toEqual({ budgetUsd: null, percent: null, exceeded: false });
  });

  it('跨项目隔离：只聚合本项目对话下的 run', async () => {
    await insertUsage({ runId: 'run_cost_1', used: 100, costUsd: 0.1, model: 'model-a' });
    await insertUsage({ runId: 'run_cost_b1', used: 999, costUsd: 9.9, model: 'model-a' });

    const a = await summary(PROJ_A);
    const b = await summary(PROJ_B);

    expect(a.total).toEqual({ tokens: 100, costUsd: 0.1, runs: 1, unknownCostRuns: 0 });
    expect(a.byRun.map((r) => r.runId)).toEqual(['run_cost_1']);
    expect(b.total).toEqual({ tokens: 999, costUsd: 9.9, runs: 1, unknownCostRuns: 0 });
    expect(b.byRun.map((r) => r.runId)).toEqual(['run_cost_b1']);
  });

  it('多章产出与无章产出的 run 不归属章节，但仍计入总额', async () => {
    // run1 一次写两章（批量导入场景）→ 不归属
    await insertUsage({ runId: 'run_cost_1', used: 400, costUsd: 1.2, model: 'model-a' });
    await insertArtifacts('run_cost_1', ['chapters/第1章.md', 'chapters/第2章.md']);
    // run3 无任何文件产出、无 revise 目标 → 不归属
    await insertUsage({ runId: 'run_cost_3', used: 100, costUsd: 0.3, model: 'model-a' });

    const body = await summary(PROJ_A);
    expect(body.byChapter).toEqual([]);
    expect(body.total).toEqual({ tokens: 500, costUsd: 1.5, runs: 2, unknownCostRuns: 0 });
  });

  it('项目不存在返回 404', async () => {
    const res = await app.request('/api/projects/no_such_project/costs/summary');
    expect(res.status).toBe(404);
  });

  it('无 usage 数据时返回空聚合', async () => {
    const body = await summary(PROJ_A);
    expect(body.total).toEqual({ tokens: 0, costUsd: 0, runs: 0, unknownCostRuns: 0 });
    expect(body.byModel).toEqual([]);
    expect(body.byRun).toEqual([]);
    expect(body.byChapter).toEqual([]);
    expect(body.byDay).toEqual([]);
  });
});

describe('GET /api/projects/:projectId/costs/budget', () => {
  beforeEach(async () => {
    await insertUsage({ runId: 'run_cost_1', used: 1700, costUsd: 0.75, model: 'model-a' });
  });

  it('未设预算：budgetUsd null、exceeded false', async () => {
    expect(await budget(PROJ_A)).toEqual({ budgetUsd: null, spentUsd: 0.75, percent: null, exceeded: false });
  });

  it('预算内：percent 四舍五入', async () => {
    await db.insert(userSettings).values({ id: 'set_cost_budget_1', key: COST_BUDGET_SETTING_KEY, value: '1' });
    expect(await budget(PROJ_A)).toEqual({ budgetUsd: 1, spentUsd: 0.75, percent: 75, exceeded: false });
  });

  it('超支：exceeded true，summary.budget 同源', async () => {
    await db.insert(userSettings).values({ id: 'set_cost_budget_2', key: COST_BUDGET_SETTING_KEY, value: '0.5' });
    expect(await budget(PROJ_A)).toEqual({ budgetUsd: 0.5, spentUsd: 0.75, percent: 150, exceeded: true });
    const s = await summary(PROJ_A);
    expect(s.budget).toEqual({ budgetUsd: 0.5, percent: 150, exceeded: true });
  });

  it('非法预算值视为未设置', async () => {
    await db.insert(userSettings).values({ id: 'set_cost_budget_3', key: COST_BUDGET_SETTING_KEY, value: 'not-a-number' });
    expect(await budget(PROJ_A)).toEqual({ budgetUsd: null, spentUsd: 0.75, percent: null, exceeded: false });
  });
});
