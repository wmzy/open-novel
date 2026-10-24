/**
 * 批量写作状态持久化（.novel/batch.json）。
 *
 * 批量写作由前端驱动：每章是一次真实的 POST /api/runs（项目串行锁 +
 * 样章门 + runs 表注册），章节结束后前端调用 /batch/advance 推进。
 * 服务端只持久化「当前章 / 暂停 / 失败恢复点」，因此：
 * - 浏览器刷新 / 服务重启后仍能恢复进度（mount-replay）；
 * - 不产生隐藏的后台循环：没有前端继续驱动时批量自然停住。
 *
 * 文件写入采用临时文件 + rename，避免半写 JSON 被读取。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateId } from '../utils/id';
import {
  advanceBatchState,
  cancelBatchState,
  pauseBatchState,
  resumeBatchState,
  startBatchState,
  type BatchState,
} from '../shared/batch';

const BATCH_FILE = 'batch.json';

function novelDir(projectDir: string): string {
  return path.join(projectDir, '.novel');
}

export function batchFilePath(projectDir: string): string {
  return path.join(novelDir(projectDir), BATCH_FILE);
}

/** 读取批量状态（缺失/损坏返回 null）。 */
export async function readBatchState(projectDir: string): Promise<BatchState | null> {
  try {
    const raw = await fs.readFile(batchFilePath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const candidate =
      parsed && typeof parsed === 'object' && 'batch' in parsed
        ? (parsed as { batch?: unknown }).batch
        : parsed;
    if (!candidate || typeof candidate !== 'object') return null;
    const s = candidate as Partial<BatchState>;
    if (
      typeof s.id !== 'string' ||
      typeof s.projectId !== 'string' ||
      !Number.isInteger(s.from) ||
      !Number.isInteger(s.to) ||
      !Number.isInteger(s.currentChapter) ||
      typeof s.status !== 'string'
    ) {
      return null;
    }
    return {
      id: s.id,
      projectId: s.projectId,
      from: s.from as number,
      to: s.to as number,
      currentChapter: s.currentChapter as number,
      status: s.status as BatchState['status'],
      pauseRequested: s.pauseRequested === true,
      resumeChapter: typeof s.resumeChapter === 'number' ? s.resumeChapter : null,
      reason: typeof s.reason === 'string' ? s.reason : null,
      lastRunId: typeof s.lastRunId === 'string' ? s.lastRunId : null,
      lastRunChapter: Number.isInteger(s.lastRunChapter) ? (s.lastRunChapter as number) : null,
      agentId: typeof s.agentId === 'string' ? s.agentId : null,
      skillId: typeof s.skillId === 'string' ? s.skillId : null,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** 原子写入批量状态。 */
export async function writeBatchState(projectDir: string, state: BatchState): Promise<void> {
  const file = batchFilePath(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ batch: state }, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

// 同项目读-改-写串行化：pause/advance/resume 可能交错到达，
// 无锁会 last-writer-wins 丢掉暂停请求或跳章。
const queues = new Map<string, Promise<unknown>>();

async function withBatchLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(projectDir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // 队列条目只保存「尾部 promise」，不随请求数增长。
  queues.set(projectDir, run.then(() => undefined, () => undefined));
  return run;
}

/** 创建并落盘一个新批量（不启动 run）。 */
export async function startBatch(
  projectDir: string,
  projectId: string,
  from: number,
  to: number,
  opts: { agentId?: string; skillId?: string } = {},
): Promise<BatchState> {
  return withBatchLock(projectDir, async () => {
    const state = startBatchState({
      id: generateId('batch_'),
      projectId,
      from,
      to,
      agentId: opts.agentId,
      skillId: opts.skillId,
    });
    await writeBatchState(projectDir, state);
    return state;
  });
}

/** 记录当前章关联的 runId（前端启动成功后回填）。 */
export async function recordBatchRunStarted(
  projectDir: string,
  chapter: number,
  runId: string,
): Promise<BatchState | null> {
  return withBatchLock(projectDir, async () => {
    const state = await readBatchState(projectDir);
    if (!state || state.status !== 'running' || state.currentChapter !== chapter) return state;
    const next = {
      ...state,
      lastRunId: runId,
      lastRunChapter: chapter,
      updatedAt: new Date().toISOString(),
    };
    await writeBatchState(projectDir, next);
    return next;
  });
}

/** 一章 run 结束后的状态推进（幂等：过期章节号原样返回）。 */
export async function advanceBatch(
  projectDir: string,
  chapter: number,
  succeeded: boolean,
  reason?: string | null,
): Promise<BatchState | null> {
  return withBatchLock(projectDir, async () => {
    const state = await readBatchState(projectDir);
    if (!state) return null;
    const next = advanceBatchState(state, { chapter, succeeded, reason });
    if (next !== state) await writeBatchState(projectDir, next);
    return next;
  });
}

/** 暂停：有 run 在途时只登记请求，当前章完成后落 paused。 */
export async function pauseBatch(
  projectDir: string,
  runActive: boolean,
): Promise<BatchState | null> {
  return withBatchLock(projectDir, async () => {
    const state = await readBatchState(projectDir);
    if (!state) return null;
    const next = pauseBatchState(state, { runActive });
    if (next !== state) await writeBatchState(projectDir, next);
    return next;
  });
}

/** 从暂停/失败恢复（不启动 run，前端拿到状态后发送下一章）。 */
export async function resumeBatch(projectDir: string): Promise<BatchState | null> {
  return withBatchLock(projectDir, async () => {
    const state = await readBatchState(projectDir);
    if (!state) return null;
    const next = resumeBatchState(state);
    if (next !== state) await writeBatchState(projectDir, next);
    return next;
  });
}

/** 取消批量。 */
export async function cancelBatch(projectDir: string): Promise<BatchState | null> {
  return withBatchLock(projectDir, async () => {
    const state = await readBatchState(projectDir);
    if (!state) return null;
    const next = cancelBatchState(state);
    if (next !== state) await writeBatchState(projectDir, next);
    return next;
  });
}
