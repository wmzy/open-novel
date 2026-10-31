import { describe, expect, it } from 'vitest';
import { createBudgetTracker, roundUsd } from '../../../src/shared/cost-budget';

describe('createBudgetTracker', () => {
  it('未设置预算：只累计 run 成本，永不提醒', () => {
    const tracker = createBudgetTracker({ spentUsd: 10, budgetUsd: null });
    expect(tracker.record(1)).toBeNull();
    expect(tracker.record(100)).toBeNull();
    expect(tracker.runCostUsd).toBe(101);
  });

  it('预算内不提醒，首次越过预算提醒一次并带累计值', () => {
    const tracker = createBudgetTracker({ spentUsd: 0.5, budgetUsd: 1 });
    expect(tracker.record(0.25)).toBeNull();
    const alert = tracker.record(0.3);
    expect(alert).toEqual({
      spentUsd: 1.05,
      budgetUsd: 1,
      percent: 105,
      runCostUsd: 0.55,
    });
    // 只提醒一次
    expect(tracker.record(5)).toBeNull();
    expect(tracker.runCostUsd).toBe(5.55);
  });

  it('启动时已超支：record(null) 立即提醒（本次 run 成本 0）', () => {
    const tracker = createBudgetTracker({ spentUsd: 2, budgetUsd: 1.5 });
    expect(tracker.record(null)).toEqual({
      spentUsd: 2,
      budgetUsd: 1.5,
      percent: 133,
      runCostUsd: 0,
    });
  });

  it('非法/负数/NaN 成本忽略；浮点尾差按 4 位归一', () => {
    const tracker = createBudgetTracker({ spentUsd: 0, budgetUsd: 0.2 });
    expect(tracker.record(Number.NaN)).toBeNull();
    expect(tracker.record(-3)).toBeNull();
    expect(tracker.record('0.4')).toBeNull();
    expect(tracker.record(0.1)).toBeNull();
    const alert = tracker.record(0.2);
    expect(alert?.runCostUsd).toBe(0.3);
    expect(alert?.spentUsd).toBe(0.3);
  });

  it('预算为 0 视为未设置（与成本面板一致）', () => {
    const tracker = createBudgetTracker({ spentUsd: 5, budgetUsd: 0 });
    expect(tracker.record(10)).toBeNull();
  });

  it('roundUsd 四舍五入到 4 位', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(roundUsd(1.23456)).toBe(1.2346);
  });
});
