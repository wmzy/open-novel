import { randomUUID } from 'node:crypto';
import { eventStore } from './event-store';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface Run {
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
}

const runs = new Map<string, Run>();

/** 每个运行中 run 保留在内存的滑动窗口大小（条）。超出部分由 EventStore 落盘后从窗口滑出。 */
const WINDOW_SIZE = 200;

export function createRun(meta: { projectId: string; agentId: string; skillId: string; stage: string }): Run {
  let finishResolve: () => void;
  const finished = new Promise<void>((resolve) => { finishResolve = resolve; });

  const run: Run = {
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
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(id: string): Run | null {
  return runs.get(id) ?? null;
}

export function emitEvent(run: Run, event: string, data: unknown) {
  const id = run.nextEventId++;
  const record = { id, event, data, timestamp: Date.now() };
  run.events.push(record);
  if (run.events.length > WINDOW_SIZE) run.events.splice(0, run.events.length - WINDOW_SIZE);
  run.updatedAt = Date.now();
  for (const send of run.clients) send(event, data, id);
  eventStore.append(run.id, id, event, data);
}

export function finishRun(run: Run, status: RunStatus) {
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

export function cancelRun(run: Run) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.cancelRequested = true;
  if (run.child && !run.child.killed) {
    run.child.kill('SIGTERM');
  } else {
    finishRun(run, 'canceled');
  }
}

export function subscribeRun(run: Run, send: (event: string, data: unknown, id: number) => void) {
  run.clients.add(send);
}
