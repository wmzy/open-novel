import { RunStream } from './run-stream';

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
  };
  runs.set(id, run);
  return run;
}

export function getRun(id: string): RunSession | null {
  return runs.get(id) ?? null;
}

export function emitEvent(run: RunSession, event: string, data: unknown) {
  run.stream.push(event, data);
  run.updatedAt = Date.now();
}

export function finishRun(run: RunSession, status: RunStatus) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.status = status;
  run.updatedAt = Date.now();
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
