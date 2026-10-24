import { describe, it, expect } from 'vitest';
import {
  advanceBatchState,
  batchChapterMessage,
  batchProgress,
  cancelBatchState,
  isBatchActive,
  parseBatchCommand,
  pauseBatchState,
  resumeBatchState,
  startBatchState,
} from '../../../src/shared/batch';

function makeState(from = 10, to = 12) {
  return startBatchState({
    id: 'batch_test',
    projectId: 'p1',
    from,
    to,
    now: '2026-01-01T00:00:00.000Z',
  });
}

describe('parseBatchCommand', () => {
  const cases: Array<[string, { from: number; to: number }]> = [
    ['写第3到12章', { from: 3, to: 12 }],
    ['请批量写第 3 至 12 章。', { from: 3, to: 12 }],
    ['写第3章到第12章', { from: 3, to: 12 }],
    ['/batch 10-20', { from: 10, to: 20 }],
    ['/batch 写第3到12章', { from: 3, to: 12 }],
    ['/batch 第3到12章', { from: 3, to: 12 }],
    ['write chapters 5..8', { from: 5, to: 8 }],
  ];
  it.each(cases)('解析 %s', (input, expected) => {
    expect(parseBatchCommand(input)).toEqual(expected);
  });

  it('不把正文/非整句误判为批量命令', () => {
    expect(parseBatchCommand('我想写第3到12章的故事，请继续')).toBeNull();
    expect(parseBatchCommand('写第12章')).toBeNull();
    expect(parseBatchCommand('写第12到3章')).toBeNull();
    expect(parseBatchCommand('')).toBeNull();
  });
});

describe('batch state machine', () => {
  it('顺序推进到 completed', () => {
    let s = makeState(10, 12);
    expect(batchProgress(s)).toEqual({ total: 3, done: 0, remaining: 3 });
    s = advanceBatchState(s, { chapter: 10, succeeded: true });
    expect(s.status).toBe('running');
    expect(s.currentChapter).toBe(11);
    expect(batchProgress(s).remaining).toBe(2);
    s = advanceBatchState(s, { chapter: 11, succeeded: true });
    expect(s.currentChapter).toBe(12);
    s = advanceBatchState(s, { chapter: 12, succeeded: true });
    expect(s.status).toBe('completed');
    expect(batchProgress(s)).toEqual({ total: 3, done: 3, remaining: 0 });
    expect(isBatchActive(s)).toBe(false);
  });

  it('暂停：当前章结束后停在下一章，resume 从该章继续', () => {
    let s = makeState(10, 12);
    s = pauseBatchState(s, { runActive: true });
    expect(s.status).toBe('running');
    expect(s.pauseRequested).toBe(true);
    // 当前章 10 成功 → paused at 11
    s = advanceBatchState(s, { chapter: 10, succeeded: true });
    expect(s.status).toBe('paused');
    expect(s.currentChapter).toBe(11);
    expect(s.resumeChapter).toBe(11);
    s = resumeBatchState(s);
    expect(s.status).toBe('running');
    expect(s.currentChapter).toBe(11);
    expect(s.pauseRequested).toBe(false);
    expect(s.resumeChapter).toBeNull();
  });

  it('两章之间暂停直接进入 paused', () => {
    let s = makeState(10, 12);
    s = advanceBatchState(s, { chapter: 10, succeeded: true });
    s = pauseBatchState(s, { runActive: false });
    expect(s.status).toBe('paused');
    expect(s.currentChapter).toBe(11);
    expect(s.resumeChapter).toBe(11);
  });

  it('失败不跳章：failed + resumeChapter，resume 后重试同一章', () => {
    let s = makeState(10, 12);
    s = advanceBatchState(s, { chapter: 10, succeeded: false, reason: 'exit 1' });
    expect(s.status).toBe('failed');
    expect(s.resumeChapter).toBe(10);
    expect(s.reason).toBe('exit 1');
    s = resumeBatchState(s);
    expect(s.status).toBe('running');
    expect(s.currentChapter).toBe(10);
    expect(s.reason).toBeNull();
  });

  it('过期/重复的 advance 幂等（刷新重放不会跳章）', () => {
    let s = makeState(10, 12);
    s = advanceBatchState(s, { chapter: 10, succeeded: true });
    const repeated = advanceBatchState(s, { chapter: 10, succeeded: true });
    expect(repeated).toBe(s);
    const staleFailure = advanceBatchState(s, { chapter: 9, succeeded: false });
    expect(staleFailure).toBe(s);
  });

  it('成功后重复 advance 不覆盖 completed', () => {
    let s = makeState(10, 11);
    s = advanceBatchState(s, { chapter: 10, succeeded: true });
    s = advanceBatchState(s, { chapter: 11, succeeded: true });
    expect(s.status).toBe('completed');
    const again = advanceBatchState(s, { chapter: 11, succeeded: false });
    expect(again).toBe(s);
  });

  it('cancel 是终态', () => {
    let s = makeState(10, 12);
    s = pauseBatchState(s, { runActive: true });
    s = cancelBatchState(s);
    expect(s.status).toBe('canceled');
    expect(s.pauseRequested).toBe(false);
    expect(isBatchActive(s)).toBe(false);
    expect(resumeBatchState(s)).toBe(s);
  });

  it('章节 message 明确指定章号', () => {
    expect(batchChapterMessage(7)).toContain('第7章');
  });
});
