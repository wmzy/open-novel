import { RunStream } from './run-stream';
import { db } from '../db/drizzle';
import { runs as runsTable } from '../db/schema';
import { inArray } from 'drizzle-orm';
import { config } from '../config';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface RunSession {
  id: string;
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
  status: RunStatus;
  /** 统一事件流：push/subscribe/落盘/close 固化。取代原 events 窗口 + clients 集合 + eventStore。 */
  stream: RunStream;
  child: ReturnType<typeof import('node:child_process').spawn> | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  cancelRequested: boolean;
  finished: Promise<void>;
  _finishResolve: () => void;
  /**
   * 挂起的 ACP elicitation 请求。
   *
   * key = askId，value = resolver。acp-bridge 的 elicitation/create handler
   * registerAsk 注册后 await；前端回传时 runs.ts 的 POST /ask/:askId
   * 调 resolveAsk 唤醒，handler 返回用户答案给 omp。
   */
  _pendingAsks: Map<string, (response: { action: 'accept' | 'cancel'; content?: unknown }) => void>;
  /** 每个挂起提问的自动取消定时器（askTimeoutMs 到期自动 cancel，防死锁）。 */
  _askTimers: Map<string, NodeJS.Timeout>;
  /**
   * ask 挂起/清空时的超时计时钩子（由 runs.ts launchAndTrack 注入）。
   * 提问挂起期间 run 处于暂停等待状态（agent 子进程阻塞在 stdin/协议上），
   * 超时计时应同步暂停，用户回答后恢复——避免用户长时间思考被误杀。
   */
  _pauseTimeout?: () => void;
  _resumeTimeout?: () => void;
}

const runs = new Map<string, RunSession>();

export function createRun(meta: { projectId: string; agentId: string; skillId: string; stage: string; conversationId: string }): RunSession {
  let finishResolve: () => void;
  const finished = new Promise<void>((resolve) => { finishResolve = resolve; });

  const id = crypto.randomUUID();
  const run: RunSession = {
    id,
    projectId: meta.projectId,
    agentId: meta.agentId,
    skillId: meta.skillId,
    stage: meta.stage,
    status: 'queued',
    stream: new RunStream(id, meta.conversationId),
    child: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
    cancelRequested: false,
    finished,
    _finishResolve: finishResolve!,
    _pendingAsks: new Map(),
    _askTimers: new Map(),
  };
  runs.set(id, run);
  return run;
}

export function getRun(id: string): RunSession | null {
  return runs.get(id) ?? null;
}

/**
 * 项目级串行锁：返回该项目当前处于运行态的 run（queued/running）。
 * 同项目同时刻只允许一个 run——并行写 state.json/character-states.md 会
 * 互相污染（last-writer-wins）。
 */
export function getActiveRunForProject(projectId: string): RunSession | null {
  for (const r of runs.values()) {
    if (r.projectId === projectId && (r.status === 'running' || r.status === 'queued')) {
      return r;
    }
  }
  return null;
}

/** 任意项目存在活跃 run（供备份恢复等全局排他操作使用）。 */
export function getAnyActiveRun(): RunSession | null {
  for (const r of runs.values()) {
    if (r.status === 'running' || r.status === 'queued') return r;
  }
  return null;
}

/**
 * 启动对账：进程重启后内存 runs 全部丢失，DB 中滞留 queued/running 的 run
 * 永远不会被 close handler 收尾。启动时统一置为 failed（幂等），
 * 前端 active-run 不再返回僵尸 runId，retry 端点也可用。返回置失败的行数。
 */
export async function reconcileStaleRuns(): Promise<number> {
  try {
    const result = await db.update(runsTable)
      .set({ status: 'failed', finishedAt: new Date() })
      .where(inArray(runsTable.status, ['queued', 'running']))
      .returning({ id: runsTable.id });
    return result.length;
  } catch {
    return 0;
  }
}

export function emitEvent(run: RunSession, event: string, data: unknown) {
  run.stream.push(event, data);
  run.updatedAt = Date.now();
}

export function finishRun(run: RunSession, status: RunStatus) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.status = status;
  run.updatedAt = Date.now();
  // 清理挂起提问的自动取消定时器：run 已终结，不再需要死锁保护
  for (const t of run._askTimers.values()) clearTimeout(t);
  run._askTimers.clear();
  emitEvent(run, 'end', { status });
  run._finishResolve();
  // RunStream 落盘由调用方在 close() 时完成；这里只清理 RunSession 注册。
  setTimeout(() => runs.delete(run.id), 30 * 60 * 1000).unref?.();
}

export function cancelRun(run: RunSession) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.cancelRequested = true;
  if (run.child && !run.child.killed) {
    run.child.kill('SIGTERM');
  } else {
    finishRun(run, 'canceled');
  }
}

/**
 * 注册一个挂起的 elicitation，返回 promise（acp-bridge handler await 它）。
 *
 * 前端回传答案时 resolveAsk 唤醒。
 */
export function registerAsk(
  run: RunSession,
  askId: string,
): Promise<{ action: 'accept' | 'cancel'; content?: unknown }> {
  return new Promise((resolve) => {
    const first = run._pendingAsks.size === 0;
    run._pendingAsks.set(askId, resolve);
    // 提问挂起：暂停 run 超时计时，等待用户回答（用户思考时间不计入超时）
    if (first) run._pauseTimeout?.();
    // 提问最长挂起：askTimeoutMs 到期自动取消，防止无人回答的提问让 run 与
    // 项目串行锁被永久占用（用户关闭浏览器后无人回传答案的死锁场景）。
    const timer = setTimeout(() => {
      if (!run._pendingAsks.has(askId)) return;
      emitEvent(run, 'agent', {
        type: 'status',
        label: `提问超过 ${Math.round(config.agent.askTimeoutMs / 3600000)} 小时无人回答，已自动取消本次任务（不再继续执行）`,
      });
      // 先唤醒挂起的 elicitation handler（否则 acp-bridge await 永远不返回），
      // 再取消整个 run：无人回答的提问不应让 agent 带着缺省的答案继续写盘。
      resolveAsk(run, askId, { action: 'cancel' });
      cancelRun(run);
    }, config.agent.askTimeoutMs);
    timer.unref?.();
    run._askTimers.set(askId, timer);
  });
}

/**
 * 前端回传用户答案时调用，唤醒挂起的 elicitation handler。
 *
 * 返回 true 表示找到并唤醒了对应的 ask，false 表示 ask 已过期/不存在。
 */
export function resolveAsk(
  run: RunSession,
  askId: string,
  response: { action: 'accept' | 'cancel'; content?: unknown },
): boolean {
  const resolver = run._pendingAsks.get(askId);
  if (!resolver) return false;
  run._pendingAsks.delete(askId);
  const timer = run._askTimers.get(askId);
  if (timer) {
    clearTimeout(timer);
    run._askTimers.delete(askId);
  }
  resolver(response);
  // 全部提问已答：恢复超时计时
  if (run._pendingAsks.size === 0) run._resumeTimeout?.();
  return true;
}

/**
 * 订阅 run 的事件流：重放 fromSeq 之后的历史 + 实时推送新事件。
 * 返回取消订阅函数。
 */
export function subscribeRun(
  run: RunSession,
  fromSeq: number,
  send: (event: string, data: unknown, id: number) => void,
): () => void {
  return run.stream.subscribe(fromSeq, send);
}
