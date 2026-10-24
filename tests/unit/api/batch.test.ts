import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { createRun, finishRun, type RunSession } from '../../../src/agent/run';
import { readBatchState } from '../../../src/agent/batch';

describe('批量写作 API', () => {
  const projectId = 'test_proj_batch_api';
  let tempDir: string;
  const runsToFinish: RunSession[] = [];

  function makeRun(conversationId: string): RunSession {
    const run = createRun({
      projectId,
      agentId: 'claude',
      skillId: 'wuxia',
      stage: 'writing',
      conversationId,
    });
    runsToFinish.push(run);
    return run;
  }

  async function post(sub: string, body: Record<string, unknown> = {}) {
    // 子路径统一补斜杠：调用方传 'run-started' / 'pause'，避免拼成 /batchrun-started。
    const suffix = sub ? (sub.startsWith('/') ? sub : `/${sub}`) : '';
    return apiApp.request(`/api/projects/${projectId}/batch${suffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    await ensureDbReady();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-api-'));
    await fs.mkdir(path.join(tempDir, '.novel'), { recursive: true });
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await db.insert(projects).values({
      id: projectId,
      title: '批量测试',
      path: tempDir,
      genre: 'wuxia',
    });
  });

  afterEach(async () => {
    for (const run of runsToFinish.splice(0)) finishRun(run, 'succeeded');
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('项目有活跃 run 时创建批量返回 409 run-in-progress', async () => {
    makeRun('conv_batch_lock');
    const res = await post('', { from: 1, to: 5 });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('run-in-progress');
    expect(typeof data.runId).toBe('string');
    // 未落盘
    expect(await readBatchState(tempDir)).toBeNull();
  });

  it('创建批量校验范围与单批上限，成功后 GET 可恢复', async () => {
    expect((await post('', { from: 1, to: 12 })).status).toBe(400);
    expect((await post('', { from: 5, to: 4 })).status).toBe(400);
    expect((await post('', { from: 0, to: 2 })).status).toBe(400);
    expect((await post('', { from: 1.5, to: 2 })).status).toBe(400);

    const res = await post('', { from: 10, to: 12 });
    expect(res.status).toBe(201);
    const { batch } = await res.json();
    expect(batch.status).toBe('running');
    expect(batch.currentChapter).toBe(10);

    const getRes = await apiApp.request(`/api/projects/${projectId}/batch`);
    expect(getRes.status).toBe(200);
    const getData = await getRes.json();
    expect(getData.batch.id).toBe(batch.id);
    expect((await readBatchState(tempDir))?.id).toBe(batch.id);
  });

  it('run-started 回填当前章 runId（服务端收尾自动推进依赖它）', async () => {
    await post('', { from: 10, to: 12 });
    const run = makeRun('conv_batch_run_started');
    run.status = 'running';

    const res = await post('run-started', { chapter: 10, runId: run.id });
    expect(res.status).toBe(200);
    const { batch } = await res.json();
    expect(batch.lastRunId).toBe(run.id);
    expect(batch.lastRunChapter).toBe(10);

    // 不存在的 runId 被拒绝
    const invalid = await post('run-started', { chapter: 10, runId: 'run_missing' });
    expect(invalid.status).toBe(400);
  });

  it('支持 range 字符串创建批量', async () => {
    const res = await post('', { range: '写第3到5章' });
    expect(res.status).toBe(201);
    const { batch } = await res.json();
    expect(batch.from).toBe(3);
    expect(batch.to).toBe(5);
  });

  it('暂停不打断当前章：advance 后落 paused；resume 在活跃 run 时 409', async () => {
    await post('', { from: 10, to: 12 });
    const run = makeRun('conv_batch_pause');
    run.status = 'running';

    const pauseRes = await post('pause');
    expect(pauseRes.status).toBe(200);
    const pausedState = (await pauseRes.json()).batch;
    expect(pausedState.status).toBe('running');
    expect(pausedState.pauseRequested).toBe(true);

    const advanceRes = await post('advance', { chapter: 10, succeeded: true });
    expect(advanceRes.status).toBe(200);
    const advanced = (await advanceRes.json()).batch;
    expect(advanced.status).toBe('paused');
    expect(advanced.currentChapter).toBe(11);

    // 当前 run 仍活跃时不能 resume
    const lockedResume = await post('resume');
    expect(lockedResume.status).toBe(409);

    finishRun(run, 'succeeded');
    runsToFinish.splice(runsToFinish.indexOf(run), 1);
    const resumeRes = await post('resume');
    expect(resumeRes.status).toBe(200);
    const resumed = (await resumeRes.json()).batch;
    expect(resumed.status).toBe('running');
    expect(resumed.currentChapter).toBe(11);
  });

  it('失败章保留可恢复记录；过期 advance 不跳章', async () => {
    await post('', { from: 10, to: 12 });
    await post('advance', { chapter: 10, succeeded: true });
    await post('advance', { chapter: 9, succeeded: true }); // 过期/重复
    const res = await post('advance', { chapter: 11, succeeded: false, reason: 'agent crashed' });
    const { batch } = await res.json();
    expect(batch.status).toBe('failed');
    expect(batch.resumeChapter).toBe(11);
    expect(batch.currentChapter).toBe(11);
    expect(batch.reason).toBe('agent crashed');

    const stored = await readBatchState(tempDir);
    expect(stored?.resumeChapter).toBe(11);
  });

  it('取消后不再可恢复', async () => {
    await post('', { from: 10, to: 12 });
    const cancelRes = await post('cancel');
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()).batch.status).toBe('canceled');
    const resumeRes = await post('resume');
    expect(resumeRes.status).toBe(400);
    expect((await resumeRes.json()).error).toBe('batch-not-resumable');
  });

  it('项目设置 milestoneEvery：PATCH 落盘 config.json，GET 返回最新值', async () => {
    const patch = await apiApp.request(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestoneEvery: 0 }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()).project.milestoneEvery).toBe(0);

    const cfg = JSON.parse(
      await fs.readFile(path.join(tempDir, '.novel', 'config.json'), 'utf-8'),
    );
    expect(cfg.milestoneEvery).toBe(0);

    const getRes = await apiApp.request(`/api/projects/${projectId}`);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).project.milestoneEvery).toBe(0);

    const invalid = await apiApp.request(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestoneEvery: -1 }),
    });
    expect(invalid.status).toBe(400);
  });
});
