import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  evaluateMilestones,
  readMilestoneLedger,
  readVolumes,
} from '../../../src/agent/milestones';
import { startBatch } from '../../../src/agent/batch';
import { createRun, finishRun, type RunSession } from '../../../src/agent/run';

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir });
  return stdout.trim();
}

async function listTags(dir: string): Promise<string[]> {
  try {
    return (await git(dir, ['tag', '--list', 'milestone-*'])).split('\n').filter(Boolean).sort();
  } catch {
    return [];
  }
}

async function seedChapters(dir: string, from: number, to: number): Promise<void> {
  const chaptersDir = path.join(dir, '.novel', 'chapters');
  await fs.mkdir(chaptersDir, { recursive: true });
  for (let n = from; n <= to; n++) {
    await fs.writeFile(
      path.join(chaptersDir, `第${n}章.md`),
      `# 第${n}章\n\n${'这是用于里程碑测试的有效正文。'.repeat(20)}`,
      'utf-8',
    );
  }
}

describe('自动里程碑', () => {
  let dir: string;
  let projectId: string;
  const runsToFinish: RunSession[] = [];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'milestones-'));
    projectId = `test_proj_milestones_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
  });

  afterEach(async () => {
    for (const run of runsToFinish.splice(0)) finishRun(run, 'succeeded');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('每 K 章创建一次带标签快照，重复评估不会重复创建', async () => {
    await seedChapters(dir, 1, 50);
    const first = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 50,
      triggerRetro: false,
    });
    expect(first.created).toHaveLength(1);
    expect(first.created[0].key).toBe('chapter:50');
    expect(first.created[0].hash).toBeTruthy();
    expect(await listTags(dir)).toContain('milestone-chapter-50');
    // 双分支不变量：快照在 draft 上打标签，main 仍是 draft 的祖先
    expect(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('draft');
    await expect(git(dir, ['merge-base', '--is-ancestor', 'main', 'draft'])).resolves.toBe('');

    // 再次评估（等价于服务重启后重跑）：账本已记录，不重复创建
    const second = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 50,
      triggerRetro: false,
    });
    expect(second.created).toHaveLength(0);
    expect(await listTags(dir)).toEqual(['milestone-chapter-50']);

    // 账本落盘可读（restart-safe）
    const ledger = await readMilestoneLedger(dir);
    expect(ledger.boundaries['chapter:50'].hash).toBe(first.created[0].hash);
  });

  it('跨过多个边界：每个 K 边界一次，已记录的边界不重建', async () => {
    await seedChapters(dir, 1, 50);
    await evaluateMilestones(dir, projectId, { milestoneEvery: 50, triggerRetro: false });
    await seedChapters(dir, 51, 100);

    const result = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 50,
      triggerRetro: false,
    });
    expect(result.created.map((c) => c.key)).toEqual(['chapter:100']);
    expect(await listTags(dir)).toEqual([
      'milestone-chapter-100',
      'milestone-chapter-50',
    ]);

    // 再次调用仍幂等
    const again = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 50,
      triggerRetro: false,
    });
    expect(again.created).toHaveLength(0);
  });

  it('milestoneEvery=0 关闭按章里程碑，卷末里程碑仍生效', async () => {
    await seedChapters(dir, 1, 50);

    const disabled = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 0,
      triggerRetro: false,
    });
    expect(disabled.created).toHaveLength(0);
    expect(await listTags(dir)).toEqual([]);

    await fs.writeFile(
      path.join(dir, '.novel', 'volumes.json'),
      JSON.stringify({ volumes: [{ name: '第一卷', startChapter: 1, endChapter: 50 }] }),
      'utf-8',
    );

    const result = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 0,
      triggerRetro: false,
    });
    expect(result.created.map((c) => c.key)).toEqual(['volume:50']);
    expect(result.created[0].kind).toBe('volume');
    expect(await listTags(dir)).toEqual(['milestone-volume-50']);
  });

  it('卷未写完不创建；写完卷末后创建一次', async () => {
    await seedChapters(dir, 1, 59);
    await fs.writeFile(
      path.join(dir, '.novel', 'volumes.json'),
      JSON.stringify([
        { name: '第一卷', startChapter: 1, endChapter: 60 },
        { name: '第二卷', startChapter: 61, endChapter: 120 },
      ]),
      'utf-8',
    );

    const before = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 1000,
      triggerRetro: false,
    });
    expect(before.created).toHaveLength(0);

    await seedChapters(dir, 60, 60);
    const after = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 1000,
      triggerRetro: false,
    });
    expect(after.created.map((c) => c.key)).toEqual(['volume:60']);

    const again = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 1000,
      triggerRetro: false,
    });
    expect(again.created).toHaveLength(0);
    expect(await listTags(dir)).toEqual(['milestone-volume-60']);
  });

  it('支持 outline-meta.json 的 volumes 字段', async () => {
    await seedChapters(dir, 1, 30);
    await fs.writeFile(
      path.join(dir, '.novel', 'outline-meta.json'),
      JSON.stringify({
        actBreaks: [10, 20],
        chapters: [],
        volumes: [{ name: '上卷', from: 1, to: 30 }],
      }),
      'utf-8',
    );
    const volumes = await readVolumes(dir);
    expect(volumes).toEqual([{ name: '上卷', startChapter: 1, endChapter: 30 }]);

    const result = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 1000,
      triggerRetro: false,
    });
    expect(result.created.map((c) => c.key)).toEqual(['volume:30']);
  });

  it('项目有活跃 run 时整体推迟（不写快照），run 结束后补建', async () => {
    await seedChapters(dir, 1, 50);
    const run = createRun({
      projectId,
      agentId: 'claude',
      skillId: 'wuxia',
      stage: 'writing',
      conversationId: 'conv_milestone_lock',
    });
    runsToFinish.push(run);
    run.status = 'running';

    const deferred = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 50,
      triggerRetro: false,
    });
    expect(deferred.deferred).toBe(true);
    expect(deferred.created).toHaveLength(0);
    expect(await listTags(dir)).toEqual([]);

    finishRun(run, 'succeeded');
    runsToFinish.splice(runsToFinish.indexOf(run), 1);

    const after = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 50,
      triggerRetro: false,
    });
    expect(after.deferred).toBe(false);
    expect(after.created.map((c) => c.key)).toEqual(['chapter:50']);
  });

  it('回顾触发时有活跃 run：跳过并把 note 落盘，不发起隐藏任务', async () => {
    await seedChapters(dir, 1, 50);
    const first = await evaluateMilestones(dir, projectId, {
      milestoneEvery: 50,
      triggerRetro: false,
    });
    expect(first.created).toHaveLength(1);

    const run = createRun({
      projectId,
      agentId: 'claude',
      skillId: 'wuxia',
      stage: 'writing',
      conversationId: 'conv_milestone_retro_lock',
    });
    runsToFinish.push(run);
    run.status = 'running';

    const blocked = await evaluateMilestones(dir, projectId, { milestoneEvery: 50 });
    expect(blocked.deferred).toBe(true);
    expect(blocked.retro).toEqual({ started: false, note: 'skipped:run-active' });

    const ledger = await readMilestoneLedger(dir);
    expect(ledger.boundaries['chapter:50'].retroRunId).toBeNull();
    expect(ledger.boundaries['chapter:50'].retroNote).toBe('skipped:run-active');
  });

  it('批量写作进行中：回顾延后（记录 skipped:batch-active），不抢串行锁', async () => {
    await seedChapters(dir, 1, 50);
    await evaluateMilestones(dir, projectId, { milestoneEvery: 50, triggerRetro: false });
    await startBatch(dir, projectId, 51, 55, { agentId: 'claude', skillId: 'wuxia' });

    const result = await evaluateMilestones(dir, projectId, { milestoneEvery: 50 });
    expect(result.retro).toEqual({ started: false, note: 'skipped:batch-active' });
    const ledger = await readMilestoneLedger(dir);
    expect(ledger.boundaries['chapter:50'].retroNote).toBe('skipped:batch-active');
  });
});
