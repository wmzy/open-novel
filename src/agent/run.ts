import { randomUUID } from 'node:crypto';
import type { StreamEvent } from './types';

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
}

const runs = new Map<string, Run>();

export function createRun(meta: { projectId: string; agentId: string; skillId: string; stage: string }): Run {
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
  if (run.events.length > 2000) run.events.splice(0, run.events.length - 2000);
  run.updatedAt = Date.now();
  for (const send of run.clients) send(event, data, id);
}

export function finishRun(run: Run, status: RunStatus) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.status = status;
  run.updatedAt = Date.now();
  emitEvent(run, 'end', { status });
  run.clients.clear();
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
