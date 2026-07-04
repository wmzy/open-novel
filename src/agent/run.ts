import { randomUUID } from 'node:crypto';
import { eventStore } from './event-store';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface RunSession {
  id: string;
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
  status: RunStatus;
  events: Array<{ id: number; event: string; data: unknown; timestamp: number }>;
  nextEventId: number;
  clients: Set<(event: string, data: unknown, id: number) => void>;
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
}

const runs = new Map<string, RunSession>();

/** 每个运行中 run 保留在内存的滑动窗口大小（条）。超出部分由 EventStore 落盘后从窗口滑出。 */
const WINDOW_SIZE = 200;

export function createRun(meta: { projectId: string; agentId: string; skillId: string; stage: string }): RunSession {
  let finishResolve: () => void;
  const finished = new Promise<void>((resolve) => { finishResolve = resolve; });

  const run: RunSession = {
    id: randomUUID(),
    projectId: meta.projectId,
    agentId: meta.agentId,
    skillId: meta.skillId,
    stage: meta.stage,
    status: 'queued',
    events: [],
    nextEventId: 1,
    clients: new Set(),
    child: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
    cancelRequested: false,
    finished,
    _finishResolve: finishResolve!,
    _pendingAsks: new Map(),
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(id: string): RunSession | null {
  return runs.get(id) ?? null;
}

export function emitEvent(run: RunSession, event: string, data: unknown) {
  const id = run.nextEventId++;
  const record = { id, event, data, timestamp: Date.now() };
  run.events.push(record);
  if (run.events.length > WINDOW_SIZE) run.events.splice(0, run.events.length - WINDOW_SIZE);
  run.updatedAt = Date.now();
  for (const send of run.clients) send(event, data, id);
  eventStore.append(run.id, id, event, data);
}

export function finishRun(run: RunSession, status: RunStatus) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.status = status;
  run.updatedAt = Date.now();
  emitEvent(run, 'end', { status });
  run._finishResolve();
  run.clients.clear();
  // 落盘剩余缓冲事件（含 'end'）后释放内存窗口；DB 成为事实来源。
  eventStore.release(run.id).then(() => { run.events = []; }).catch(() => {});
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
    run._pendingAsks.set(askId, resolve);
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
  resolver(response);
  return true;
}

export function subscribeRun(run: RunSession, send: (event: string, data: unknown, id: number) => void) {
  run.clients.add(send);
}
