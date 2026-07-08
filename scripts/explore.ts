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

// ===== 发散 / 展开 / 报告（Task 5）=====
