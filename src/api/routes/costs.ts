import { Hono } from 'hono';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { conversations, projects, runs as runsTable, runEvents, userSettings } from '../../db/schema';
import { parseChapterNumber } from '../../shared/chapter-names';

/**
 * 成本面板（只读聚合）：
 * GET /api/projects/:projectId/costs/summary — 按模型/run/章节/日聚合 runtime_usage 事件
 * GET /api/projects/:projectId/costs/budget  — cost_budget_usd 预算与超支状态
 *
 * 数据源是 run_events（Pi 每条 assistant 消息一条 runtime_usage，含
 * used/costUsd/model）。SQL 只做 run→conversation→project 过滤，聚合全部在
 * 内存 reduce——项目规模（百章/千 run、万级事件）可控，避免 jsonb 侧 SQL 聚合。
 */
const costsRouter = new Hono();

/** 预算设置键（user_settings，数值字符串；空/非法视为未设置）。 */
export const COST_BUDGET_SETTING_KEY = 'cost_budget_usd';

export interface ModelCostRow {
  model: string | null;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface RunCostRow {
  runId: string;
  mode: string;
  status: string;
  tokens: number;
  costUsd: number;
  startedAt: string | null;
}

export interface ChapterCostRow {
  chapter: number;
  tokens: number;
  costUsd: number;
}

export interface DayCostRow {
  /** UTC 日期（YYYY-MM-DD）。 */
  day: string;
  tokens: number;
  costUsd: number;
}

export interface CostTotals {
  tokens: number;
  costUsd: number;
  /** 有 runtime_usage 事件的 run 数（无消耗的 run 不计入）。 */
  runs: number;
  /** 至少一条 usage 事件缺失 costUsd 的 run 数（这些成本只计 tokens 不计金额）。 */
  unknownCostRuns: number;
}

export interface CostsSummary {
  byModel: ModelCostRow[];
  byRun: RunCostRow[];
  byChapter: ChapterCostRow[];
  byDay: DayCostRow[];
  total: CostTotals;
  budget: CostBudget;
}

export interface CostBudget {
  budgetUsd: number | null;
  /** spent/budget 百分比（未设预算为 null）。 */
  percent: number | null;
  exceeded: boolean;
}

interface UsageRecord {
  runId: string;
  tokens: number;
  costUsd: number | null;
  model: string | null;
  day: string;
}

/** 拉取项目全部 run 事件 + 提取好的 runtime_usage 记录。 */
async function loadProjectUsage(projectId: string): Promise<{
  usage: UsageRecord[];
  runRows: Array<typeof runsTable.$inferSelect>;
  eventRows: Array<typeof runEvents.$inferSelect>;
}> {
  const convRows = await db.select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.projectId, projectId));
  if (convRows.length === 0) return { usage: [], runRows: [], eventRows: [] };

  const convIds = convRows.map((c) => c.id);
  const runRows = await db.select().from(runsTable)
    .where(inArray(runsTable.conversationId, convIds));
  if (runRows.length === 0) return { usage: [], runRows: [], eventRows: [] };

  const eventRows = await db.select().from(runEvents)
    .where(inArray(runEvents.runId, runRows.map((r) => r.id)));

  // 事件两级结构：type 列是流类别（'agent'），data.type 才是事件类型
  const usage: UsageRecord[] = [];
  for (const row of eventRows) {
    if (row.type !== 'agent') continue;
    const data = row.data as { type?: string; used?: unknown; costUsd?: unknown; model?: unknown } | null;
    if (!data || data.type !== 'runtime_usage') continue;
    const tokens = Number(data.used);
    const cost = data.costUsd;
    usage.push({
      runId: row.runId,
      tokens: Number.isFinite(tokens) ? tokens : 0,
      costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      model: typeof data.model === 'string' && data.model ? data.model : null,
      day: row.createdAt.toISOString().slice(0, 10),
    });
  }
  return { usage, runRows, eventRows };
}

/**
 * 章节归属：run 写盘的章节文件（artifacts 事件 paths）+ revise 的
 * payload.targetFile。恰好指向一章才归属——多章 run（批量导入/分解）与
 * 无章节产出 run（概念、大纲等）不摊派，避免成本数字失真。
 */
function runChapter(run: typeof runsTable.$inferSelect, eventRows: Array<{ type: string; data: unknown }>): number | null {
  const chapters = new Set<number>();
  for (const row of eventRows) {
    if (row.type !== 'artifacts') continue;
    const data = row.data as { paths?: unknown } | null;
    if (!data || !Array.isArray(data.paths)) continue;
    for (const p of data.paths) {
      if (typeof p !== 'string') continue;
      const num = parseChapterNumber(path.basename(p));
      if (num !== null) chapters.add(num);
    }
  }
  const payload = run.payload as { targetFile?: unknown } | null;
  if (payload && typeof payload.targetFile === 'string') {
    const num = parseChapterNumber(path.basename(payload.targetFile));
    if (num !== null) chapters.add(num);
  }
  return chapters.size === 1 ? [...chapters][0] : null;
}

/** 金额累加后统一保留 4 位小数，消除浮点尾差（0.1+0.2 类）。 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

async function readBudgetUsd(): Promise<number | null> {
  const rows = await db.select().from(userSettings)
    .where(eq(userSettings.key, COST_BUDGET_SETTING_KEY)).limit(1);
  if (rows.length === 0) return null;
  const parsed = Number.parseFloat(rows[0].value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function budgetBlock(spentUsd: number, budgetUsd: number | null): CostBudget {
  return {
    budgetUsd,
    percent: budgetUsd !== null && budgetUsd > 0 ? Math.round((spentUsd / budgetUsd) * 100) : null,
    exceeded: budgetUsd !== null && spentUsd > budgetUsd,
  };
}

/**
 * 内部只读快照：run 启动时取项目累计花费 + 预算，供 runs 事件流做
 * run 级实时提醒。必须在 run 的任何 runtime_usage 事件落盘前调用，
 * 否则本次 run 的已产生成本会被重复计入。
 *
 * 只拉 runtime_usage 事件（每条 assistant 消息一条）而不是全部 agent 事件——
 * run 启动在延迟敏感路径上，不能把上万条 text_delta 也读进内存。
 * 汇总口径与 summary 完全一致（同一批 runtime_usage 事件求和后 round4）。
 */
export async function getProjectCostSnapshot(
  projectId: string,
): Promise<{ spentUsd: number; budgetUsd: number | null }> {
  const rows = await db
    .select({ data: runEvents.data })
    .from(runEvents)
    .innerJoin(runsTable, eq(runEvents.runId, runsTable.id))
    .innerJoin(conversations, eq(runsTable.conversationId, conversations.id))
    .where(and(
      eq(conversations.projectId, projectId),
      eq(runEvents.type, 'agent'),
      sql`${runEvents.data}->>'type' = 'runtime_usage'`,
    ));

  let total = 0;
  for (const row of rows) {
    const data = row.data as { costUsd?: unknown } | null;
    const cost = data?.costUsd;
    if (typeof cost === 'number' && Number.isFinite(cost)) total += cost;
  }
  return { spentUsd: round4(total), budgetUsd: await readBudgetUsd() };
}

async function computeSummary(projectId: string): Promise<Omit<CostsSummary, 'budget'>> {
  const { usage, runRows, eventRows } = await loadProjectUsage(projectId);

  // run 元数据索引 + 各 run 的事件（章节归属要读 artifacts 事件）
  const runById = new Map(runRows.map((r) => [r.id, r]));
  const eventsByRun = new Map<string, Array<{ type: string; data: unknown }>>();
  for (const row of eventRows) {
    let list = eventsByRun.get(row.runId);
    if (!list) eventsByRun.set(row.runId, (list = []));
    list.push({ type: row.type, data: row.data });
  }

  const byModel = new Map<string, { runs: Set<string>; tokens: number; costUsd: number }>();
  const byRun = new Map<string, { tokens: number; costUsd: number }>();
  const byChapter = new Map<number, { tokens: number; costUsd: number }>();
  const byDay = new Map<string, { tokens: number; costUsd: number }>();
  const unknownCostRuns = new Set<string>();
  let totalTokens = 0;
  let totalCost = 0;

  for (const u of usage) {
    totalTokens += u.tokens;
    totalCost += u.costUsd ?? 0;
    if (u.costUsd === null) unknownCostRuns.add(u.runId);

    const modelKey = u.model ?? '';
    let m = byModel.get(modelKey);
    if (!m) byModel.set(modelKey, (m = { runs: new Set(), tokens: 0, costUsd: 0 }));
    m.runs.add(u.runId);
    m.tokens += u.tokens;
    m.costUsd += u.costUsd ?? 0;

    let r = byRun.get(u.runId);
    if (!r) byRun.set(u.runId, (r = { tokens: 0, costUsd: 0 }));
    r.tokens += u.tokens;
    r.costUsd += u.costUsd ?? 0;

    let d = byDay.get(u.day);
    if (!d) byDay.set(u.day, (d = { tokens: 0, costUsd: 0 }));
    d.tokens += u.tokens;
    d.costUsd += u.costUsd ?? 0;
  }

  // 章节维度：对有 usage 的 run 逐个归属（run 级汇总后一次性入账，避免同 run 重复）
  for (const [runId, agg] of byRun) {
    const run = runById.get(runId);
    if (!run) continue;
    const chapter = runChapter(run, eventsByRun.get(runId) ?? []);
    if (chapter === null) continue;
    let c = byChapter.get(chapter);
    if (!c) byChapter.set(chapter, (c = { tokens: 0, costUsd: 0 }));
    c.tokens += agg.tokens;
    c.costUsd += agg.costUsd;
  }

  const createdAtOf = (id: string) => runById.get(id)?.createdAt.getTime() ?? 0;

  return {
    byModel: [...byModel.entries()]
      .map(([key, m]) => ({ model: key === '' ? null : key, runs: m.runs.size, tokens: m.tokens, costUsd: round4(m.costUsd) }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    byRun: [...byRun.entries()]
      .map(([runId, agg]) => {
        const run = runById.get(runId);
        return {
          runId,
          mode: run?.mode ?? 'unknown',
          status: run?.status ?? 'unknown',
          tokens: agg.tokens,
          costUsd: round4(agg.costUsd),
          startedAt: run?.startedAt ? run.startedAt.toISOString() : null,
        };
      })
      .sort((a, b) => createdAtOf(b.runId) - createdAtOf(a.runId) || a.runId.localeCompare(b.runId)),
    byChapter: [...byChapter.entries()]
      .map(([chapter, c]) => ({ chapter, tokens: c.tokens, costUsd: round4(c.costUsd) }))
      .sort((a, b) => a.chapter - b.chapter),
    byDay: [...byDay.entries()]
      .map(([day, d]) => ({ day, tokens: d.tokens, costUsd: round4(d.costUsd) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    total: {
      tokens: totalTokens,
      costUsd: round4(totalCost),
      runs: byRun.size,
      unknownCostRuns: unknownCostRuns.size,
    },
  };
}

/**
 * GET /summary — 全维度成本聚合 + 预算块。
 * 预算提醒取舍：不建定时器/轮询（零额外开销）；run 期间由 runs 路由消费
 * `cost_alert` 事件实时提醒，面板/接口按需返回同一口径的超支状态。
 */
costsRouter.get('/summary', async (c) => {
  const projectId = c.req.param('projectId')!;
  const exists = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (exists.length === 0) return c.json({ error: 'Project not found' }, 404);

  const summary = await computeSummary(projectId);
  const budgetUsd = await readBudgetUsd();
  return c.json({ ...summary, budget: budgetBlock(summary.total.costUsd, budgetUsd) });
});

/** GET /budget — 预算阈值 + 已花费（与 summary 同源计算）。 */
costsRouter.get('/budget', async (c) => {
  const projectId = c.req.param('projectId')!;
  const exists = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (exists.length === 0) return c.json({ error: 'Project not found' }, 404);

  const summary = await computeSummary(projectId);
  const budgetUsd = await readBudgetUsd();
  return c.json({ ...budgetBlock(summary.total.costUsd, budgetUsd), spentUsd: summary.total.costUsd });
});

export default costsRouter;
