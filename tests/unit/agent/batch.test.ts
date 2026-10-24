import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  advanceBatch,
  batchFilePath,
  cancelBatch,
  pauseBatch,
  readBatchState,
  recordBatchRunStarted,
  resumeBatch,
  startBatch,
} from '../../../src/agent/batch';

describe('批量状态持久化（.novel/batch.json）', () => {
  let dirs: string[] = [];

  async function makeProjectDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-state-'));
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => { dirs = []; });
  afterEach(async () => {
    for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  });

  it('start 落盘，read 可恢复（等价于进程重启后读盘）', async () => {
    const dir = await makeProjectDir();
    const state = await startBatch(dir, 'p1', 3, 12);
    expect(state.status).toBe('running');
    expect(state.currentChapter).toBe(3);

    // 无内存缓存：再次读取即重启恢复路径
    const restored = await readBatchState(dir);
    expect(restored).toEqual(state);
    const raw = JSON.parse(await fs.readFile(batchFilePath(dir), 'utf-8'));
    expect(raw.batch.id).toBe(state.id);
  });

  it('run-started 记录 runId；过期的章号不覆盖', async () => {
    const dir = await makeProjectDir();
    const state = await startBatch(dir, 'p1', 3, 5);
    const withRun = await recordBatchRunStarted(dir, 3, 'run_1');
    expect(withRun?.lastRunId).toBe('run_1');
    expect(withRun?.lastRunChapter).toBe(3);
    const stale = await recordBatchRunStarted(dir, 4, 'run_2');
    expect(stale?.lastRunId).toBe('run_1');
    expect((await readBatchState(dir))?.lastRunId).toBe('run_1');
    expect(state.status).toBe('running');
  });

  it('失败 → resumeChapter，落盘后 resume 从失败章继续', async () => {
    const dir = await makeProjectDir();
    await startBatch(dir, 'p1', 3, 5);
    await advanceBatch(dir, 3, true);
    const failed = await advanceBatch(dir, 4, false, 'agent crash');
    expect(failed?.status).toBe('failed');
    expect(failed?.resumeChapter).toBe(4);

    // 模拟重启：直接读盘 + resume
    expect((await readBatchState(dir))?.status).toBe('failed');
    const resumed = await resumeBatch(dir);
    expect(resumed?.status).toBe('running');
    expect(resumed?.currentChapter).toBe(4);
  });

  it('暂停请求在当前章完成后落为 paused；重放同一章不跳章', async () => {
    const dir = await makeProjectDir();
    await startBatch(dir, 'p1', 3, 5);
    const pauseRequested = await pauseBatch(dir, true);
    expect(pauseRequested?.status).toBe('running');
    expect(pauseRequested?.pauseRequested).toBe(true);

    const advanced = await advanceBatch(dir, 3, true);
    expect(advanced?.status).toBe('paused');
    expect(advanced?.currentChapter).toBe(4);

    // 重复 advance（刷新重放）不继续推进
    const replay = await advanceBatch(dir, 3, true);
    expect(replay?.currentChapter).toBe(4);
    expect(replay?.status).toBe('paused');
  });

  it('无 run 在途时 pause 直接 paused；resume 回到同一章', async () => {
    const dir = await makeProjectDir();
    await startBatch(dir, 'p1', 3, 5);
    const paused = await pauseBatch(dir, false);
    expect(paused?.status).toBe('paused');
    expect(paused?.resumeChapter).toBe(3);
    const resumed = await resumeBatch(dir);
    expect(resumed?.status).toBe('running');
    expect(resumed?.currentChapter).toBe(3);
  });

  it('cancel 落盘为终态，resume 不再生效', async () => {
    const dir = await makeProjectDir();
    await startBatch(dir, 'p1', 3, 5);
    const canceled = await cancelBatch(dir);
    expect(canceled?.status).toBe('canceled');
    expect((await readBatchState(dir))?.status).toBe('canceled');
    const resumed = await resumeBatch(dir);
    expect(resumed?.status).toBe('canceled');
  });

  it('缺失/损坏文件返回 null，不抛错', async () => {
    const dir = await makeProjectDir();
    expect(await readBatchState(dir)).toBeNull();
    await fs.writeFile(batchFilePath(dir), '{not json', 'utf-8');
    expect(await readBatchState(dir)).toBeNull();
  });
});
