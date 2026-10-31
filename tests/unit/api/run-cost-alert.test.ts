// @vitest-environment node
/**
 * Run 级实时预算提醒端到端接线：POST /api/runs → runtime_usage → cost_alert。
 *
 * 用一个最小 fake Pi（不启动真实 session）验证 runs 路由的 tracker 消费与
 * SSE 事件写入口径；成本数值本身由 shared/cost-budget 单测覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects, runs as runsTable, userSettings } from '../../../src/db/schema';
import { getRun } from '../../../src/agent/run';
import { COST_BUDGET_SETTING_KEY } from '../../../src/api/routes/costs';

const { startPiAgentMock } = vi.hoisted(() => ({ startPiAgentMock: vi.fn() }));

vi.mock('../../../src/agent/prompt-composer', () => ({
  composePrompt: vi.fn(async () => 'composed prompt'),
}));
vi.mock('../../../src/agent/pi/runtime', () => ({
  startPiAgent: startPiAgentMock,
  callPiOnce: vi.fn(),
}));

import apiApp from '../../../src/api-app';

const PROJECT_ID = 'cost_alert_project';

let tempDir: string;
let runId: string | null = null;
let conversationId: string | null = null;

beforeEach(async () => {
  await ensureDbReady();
  runId = null;
  conversationId = null;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-alert-project-'));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: '预算提醒测试',
    path: tempDir,
    genre: 'novel',
    targetWords: 1000,
    chapterCount: 1,
    currentStage: 'concept',
  });
  await db.delete(userSettings).where(eq(userSettings.key, COST_BUDGET_SETTING_KEY));
  await db.insert(userSettings).values({
    id: 'set_cost_alert_budget',
    key: COST_BUDGET_SETTING_KEY,
    value: '0.1',
  });

  startPiAgentMock.mockReset();
  startPiAgentMock.mockImplementation((options: {
    onEvent: (event: Record<string, unknown>) => void;
  }) => ({
    promise: (async () => {
      // 模拟 Pi 的 runtime_usage（costUsd 0.5 > 预算 0.1）
      options.onEvent({
        type: 'runtime_usage',
        used: 100,
        size: 1000,
        costUsd: 0.5,
        model: 'fake-model',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { code: 0, aborted: false };
    })(),
    abort: vi.fn(),
  }));
});

afterEach(async () => {
  if (runId) await db.delete(runsTable).where(eq(runsTable.id, runId)).catch(() => {});
  if (conversationId) {
    await db.delete(runsTable).where(eq(runsTable.conversationId, conversationId)).catch(() => {});
  }
  await db.delete(projects).where(eq(projects.id, PROJECT_ID)).catch(() => {});
  await db.delete(userSettings).where(eq(userSettings.key, COST_BUDGET_SETTING_KEY)).catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('POST /api/runs — run 级预算提醒', () => {
  it('首次越过预算 emit 一次 cost_alert，带项目累计/本次 run 成本', async () => {
    const res = await apiApp.request('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJECT_ID,
        agentId: 'pi',
        stage: 'concept',
        message: '写概念',
        skillId: 'novel',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { runId: string; conversationId: string };
    runId = body.runId;
    conversationId = body.conversationId;

    const run = getRun(runId);
    expect(run).toBeTruthy();
    await run!.finished;

    const events = await run!.stream.replay(0);
    const alerts = events
      .filter((e) => e.event === 'agent')
      .map((e) => e.data as Record<string, unknown>)
      .filter((e) => e.type === 'cost_alert');

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'cost_alert',
      spentUsd: 0.5,
      budgetUsd: 0.1,
      percent: 500,
      runCostUsd: 0.5,
    });
  }, 20_000);
});
