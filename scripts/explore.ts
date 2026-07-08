#!/usr/bin/env node
/**
 * 夜间多路探索调度器（Night Explore）
 *
 * 睡前给一句话种子 → 夜间 LLM 自主发散 N 条前期设定路线 → 每条独立成 project。
 * 早上对比 N 套前期，挑选/嫁接最优的一条作主线。
 *
 * 用法：pnpm explore --seed "武侠·失忆剑客寻仇" --routes 3 --depth outline
 *
 * 依赖：open-novel dev server 必须运行（pnpm dev）。
 */

// ===== CLI 参数 =====

export interface ExploreOptions {
  seed: string;
  routes: number;
  /** world | characters | outline | scenes */
  depth: string;
  api: string;
  baseDir: string;
  agent: string | null;
  skill: string;
  pollIntervalMs: number;
}

export function parseArgs(argv: string[]): ExploreOptions {
  const opts: Partial<ExploreOptions> = {
    routes: 3,
    depth: 'outline',
    api: process.env.EXPLORE_API || 'http://localhost:3006',
    baseDir: `./_explore/night-${Date.now()}`,
    agent: null,
    skill: 'wuxia',
    pollIntervalMs: 10_000,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--seed': opts.seed = argv[++i]; break;
      case '--routes': opts.routes = parseInt(argv[++i], 10); break;
      case '--depth': opts.depth = argv[++i]; break;
      case '--api': opts.api = argv[++i]; break;
      case '--base-dir': opts.baseDir = argv[++i]; break;
      case '--agent': opts.agent = argv[++i]; break;
      case '--skill': opts.skill = argv[++i]; break;
      case '--poll-interval': opts.pollIntervalMs = parseInt(argv[++i], 10) * 1000; break;
    }
  }

  if (!opts.seed) throw new Error('--seed 是必需参数');
  return opts as ExploreOptions;
}

// ===== API 辅助 =====

export interface ProjectInfo {
  id: string;
  path: string;
}

export async function createProject(
  api: string,
  params: { title: string; genre: string; path: string; chapterCount?: number },
): Promise<ProjectInfo> {
  const res = await fetch(`${api}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`createProject failed: ${res.statusText}`);
  const data = (await res.json()) as { project: ProjectInfo };
  return data.project;
}

export interface RunInfo {
  runId: string;
  conversationId: string;
}

export async function triggerRun(
  api: string,
  params: {
    projectId: string;
    agentId: string;
    stage: string;
    message: string;
    skillId?: string;
  },
): Promise<RunInfo> {
  const res = await fetch(`${api}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, autonomous: true }),
  });
  if (!res.ok) throw new Error(`triggerRun failed: ${res.statusText}`);
  return (await res.json()) as RunInfo;
}

/**
 * 重试失败的 run：用相同的 conversationId + message 重新 POST /api/runs。
 * 服务端的 retry 端点只返回元数据，不创建新 run——客户端需自己重发。
 */
export async function retryRun(
  api: string,
  params: {
    projectId: string;
    agentId: string;
    stage: string;
    message: string;
    skillId?: string;
    conversationId: string;
  },
): Promise<RunInfo> {
  const res = await fetch(`${api}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, autonomous: true }),
  });
  if (!res.ok) throw new Error(`retryRun failed: ${res.statusText}`);
  return (await res.json()) as RunInfo;
}

interface RunStatusResponse {
  status: string;
  pendingAskIds: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 轮询 GET /api/runs/:id/status 直到 run 终结。
 * 若 run 挂起 elicitation（pendingAskIds 非空），自动应答（accept）避免卡死。
 * 超时返回 'failed'。
 */
export async function waitForRun(
  api: string,
  runId: string,
  opts: { pollIntervalMs: number; timeoutMs?: number },
): Promise<'succeeded' | 'failed'> {
  const timeoutMs = opts.timeoutMs ?? 1_800_000; // 30 min default
  const deadline = Date.now() + timeoutMs;
  const answered = new Set<string>();

  while (Date.now() < deadline) {
    const res = await fetch(`${api}/api/runs/${runId}/status`);
    if (res.ok) {
      const data = (await res.json()) as RunStatusResponse;

      // elicitation 兜底：自动应答
      for (const askId of data.pendingAskIds) {
        if (!answered.has(askId)) {
          answered.add(askId);
          await fetch(`${api}/api/runs/${runId}/ask/${askId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'accept' }),
          }).catch(() => {});
        }
      }

      if (data.status === 'succeeded' || data.status === 'failed' || data.status === 'canceled') {
        return data.status === 'succeeded' ? 'succeeded' : 'failed';
      }
    }
    await sleep(opts.pollIntervalMs);
  }
  return 'failed';
}

// ===== 发散 / 展开 / 报告 =====

import fs from 'node:fs/promises';
import nodePath from 'node:path';

// ===== 阶段顺序 =====

export const STAGE_ORDER: Record<string, string[]> = {
  world: ['world'],
  characters: ['world', 'characters'],
  outline: ['world', 'characters', 'outline'],
  scenes: ['world', 'characters', 'outline', 'scenes'],
};

// ===== 消息构建 =====

export function buildDivergeMessage(seed: string, routeCount: number): string {
  return `基于种子「${seed}」，发散出 ${routeCount} 条差异化的故事概念方向。

要求：
1. 每条概念需包含：一句话核心、主角原型、核心冲突、世界类型、情感基调。
2. 将每条概念分别写入 .novel/concept-route-1.md 至 .novel/concept-route-${routeCount}.md。
3. ${routeCount} 条路线之间必须在核心冲突、世界类型、情感基调上有**实质性差异**，不能只是换皮或微调。
4. 每条都要有独立的戏剧张力和可展开性。

不要调用 question 工具提问——自主选择最有戏剧性的方向。`;
}

export function buildExpandMessage(_stage: string): string {
  return `基于 .novel/concept.md 中的种子概念，自治推进本阶段。

要求：
1. 仔细阅读 concept.md，理解故事核心。
2. 按本阶段的质量标准产出完整内容，写入对应的 .novel/ 文件。
3. 所有创作决策自主做出，不要用 question 工具提问。
4. **不要调用 PATCH API 推进阶段**——阶段推进由外部调度器控制。`;
}

// ===== 发散产物解析 =====

export interface ConceptRoute {
  index: number;
  filename: string;
  content: string;
  summary: string;
}

export async function parseConceptRoutes(projectDir: string): Promise<ConceptRoute[]> {
  const novelDir = nodePath.join(projectDir, '.novel');
  const routes: ConceptRoute[] = [];
  for (let i = 1; i <= 20; i++) {
    const filename = `concept-route-${i}.md`;
    const filePath = nodePath.join(novelDir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      routes.push({ index: i, filename, content, summary: content.slice(0, 300) });
    } catch {
      break;
    }
  }
  return routes;
}

// ===== 发散阶段 =====

async function detectFirstAgent(api: string): Promise<string> {
  const res = await fetch(`${api}/api/agents`);
  if (!res.ok) throw new Error('无法获取 agent 列表');
  const data = (await res.json()) as { agents: Array<{ id: string; available: boolean }> };
  const first = data.agents.find((a) => a.available);
  if (!first) throw new Error('没有可用的 agent');
  return first.id;
}

export async function diverge(
  opts: ExploreOptions,
): Promise<{ seedProject: ProjectInfo; routes: ConceptRoute[] }> {
  const seedPath = nodePath.resolve(opts.baseDir, 'seed-project');
  const seedProject = await createProject(opts.api, {
    title: `探索种子：${opts.seed.slice(0, 20)}`,
    genre: opts.skill,
    path: seedPath,
  });

  const message = buildDivergeMessage(opts.seed, opts.routes);
  const agentId = opts.agent || (await detectFirstAgent(opts.api));
  const { runId, conversationId } = await triggerRun(opts.api, {
    projectId: seedProject.id,
    agentId,
    stage: 'concept',
    message,
    skillId: opts.skill,
  });

  let status = await waitForRun(opts.api, runId, { pollIntervalMs: opts.pollIntervalMs });

  // 重试一次
  if (status === 'failed') {
    const { runId: retryRunId } = await retryRun(opts.api, {
      projectId: seedProject.id,
      agentId,
      stage: 'concept',
      message,
      skillId: opts.skill,
      conversationId,
    });
    status = await waitForRun(opts.api, retryRunId, { pollIntervalMs: opts.pollIntervalMs });
  }

  if (status === 'failed') return { seedProject, routes: [] };

  const routes = await parseConceptRoutes(seedPath);
  return { seedProject, routes };
}

// ===== 展开阶段 =====

export interface RouteResult {
  index: number;
  project: ProjectInfo;
  stages: string[];
  failedAt: string | null;
  conceptSummary: string;
}

export async function expandRoute(
  opts: ExploreOptions,
  route: ConceptRoute,
  agentId: string,
): Promise<RouteResult> {
  const routePath = nodePath.resolve(opts.baseDir, `route-${route.index}`);
  const project = await createProject(opts.api, {
    title: `路线 ${route.index}：${route.summary.slice(0, 20)}`,
    genre: opts.skill,
    path: routePath,
  });

  // 拷贝 concept 作种子
  await fs.mkdir(nodePath.join(routePath, '.novel'), { recursive: true });
  await fs.writeFile(nodePath.join(routePath, '.novel', 'concept.md'), route.content);

  const stages = STAGE_ORDER[opts.depth] || STAGE_ORDER.outline;
  const completed: string[] = [];
  let failedAt: string | null = null;

  for (const stage of stages) {
    // 推进项目阶段
    await fetch(`${opts.api}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentStage: stage }),
    });

    const message = buildExpandMessage(stage);
    const { runId, conversationId } = await triggerRun(opts.api, {
      projectId: project.id,
      agentId,
      stage,
      message,
      skillId: opts.skill,
    });

    let status = await waitForRun(opts.api, runId, { pollIntervalMs: opts.pollIntervalMs });

    // 重试一次
    if (status === 'failed') {
      const { runId: retryRunId } = await retryRun(opts.api, {
        projectId: project.id,
        agentId,
        stage,
        message,
        skillId: opts.skill,
        conversationId,
      });
      status = await waitForRun(opts.api, retryRunId, { pollIntervalMs: opts.pollIntervalMs });
    }

    if (status === 'failed') {
      failedAt = stage;
      break;
    }
    completed.push(stage);
  }

  return { index: route.index, project, stages: completed, failedAt, conceptSummary: route.summary };
}

// ===== 报告生成 =====

export function buildReport(opts: ExploreOptions, results: RouteResult[]): string {
  const lines: string[] = [
    `# 夜间探索报告`,
    ``,
    `## 种子`,
    opts.seed,
    ``,
    `## 路线概览`,
    ``,
  ];

  for (const r of results) {
    const status = r.failedAt
      ? `⚠️ 部分完成（${r.stages.join('→')} 后在 ${r.failedAt} 失败）`
      : `✅ 完成（${r.stages.join('→')}）`;
    lines.push(`### 路线 ${r.index}：${r.conceptSummary.slice(0, 40)}`);
    lines.push(`- 状态：${status}`);
    lines.push(`- Project：${r.project.path}`);
    lines.push(`- concept 摘要：${r.conceptSummary}`);
    lines.push(``);
  }

  lines.push(`## 如何使用`);
  lines.push(`1. 打开各 route-{i} 的 .novel/ 目录对比`);
  lines.push(`2. 选定主线后，将对应 route 目录 import 为正式项目（POST /api/projects/import）`);
  lines.push(`3. 或从不同路线中挑选文件嫁接`);

  return lines.join('\n');
}

// ===== main =====

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[${new Date().toISOString()}] 夜间探索启动`);
  console.log(`  种子：${opts.seed}`);
  console.log(`  路线数：${opts.routes}，深度：${opts.depth}`);

  // 健康检查
  const health = await fetch(`${opts.api}/api/projects`);
  if (!health.ok) {
    console.error(`API 不可达（${opts.api}），请先运行 pnpm dev`);
    process.exit(1);
  }

  // 发散
  console.log(`\n[发散阶段] 生成 ${opts.routes} 条概念方向...`);
  const { routes } = await diverge(opts);
  if (routes.length === 0) {
    console.error('发散失败：未产出任何 concept-route 文件。检查种子描述或 agent 状态。');
    process.exit(1);
  }
  console.log(`  产出 ${routes.length} 条路线`);

  // 展开
  console.log(`\n[展开阶段] 逐条推进至 ${opts.depth}...`);
  const agentId = opts.agent || (await detectFirstAgent(opts.api));
  const results: RouteResult[] = [];
  let consecutiveFailures = 0;

  for (const route of routes) {
    console.log(`\n  路线 ${route.index}：${route.summary.slice(0, 40)}`);
    const result = await expandRoute(opts, route, agentId);
    results.push(result);

    if (result.failedAt && result.stages.length === 0) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        console.error(`连续 ${consecutiveFailures} 条路线首阶段失败，疑似额度耗尽，停止整批。`);
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
  }

  // 报告
  const report = buildReport(opts, results);
  const reportPath = nodePath.resolve(opts.baseDir, 'report.md');
  await fs.mkdir(opts.baseDir, { recursive: true });
  await fs.writeFile(reportPath, report, 'utf-8');
  console.log(`\n[${new Date().toISOString()}] 探索完成`);
  console.log(`  报告：${reportPath}`);
  console.log(`  完成 ${results.filter((r) => !r.failedAt).length}/${routes.length} 条路线`);
}

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

// 仅在直接执行时运行 main（测试 import 时不触发）
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
