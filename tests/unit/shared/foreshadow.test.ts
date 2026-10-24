/**
 * src/shared/foreshadow.ts 伏笔债务系统纯函数测试。
 * 来源：伏笔债务系统改造包（第 1 包）。归并建议：与 diagram-builders 的伏笔图表测试
 * 各自独立维护——本文件只测 schema 解析/迁移与债务统计，不涉及图表渲染。
 */
import { describe, it, expect } from 'vitest';
import {
  parseForeshadowFile,
  serializeForeshadows,
  computeForeshadowStats,
  computeDensityBudget,
  resolveCurrentChapter,
  canTransitionForeshadow,
  transitionForeshadow,
  isForeshadowOverdue,
  isForeshadowDueSoon,
  type Foreshadow,
} from '../../../src/shared/foreshadow';

/** 便捷构造：只覆盖测试关心的字段，其余给默认值。 */
function make(overrides: Partial<Foreshadow> & { id: number }): Foreshadow {
  return {
    content: `伏笔${overrides.id}`,
    type: 'chekhov',
    status: 'pending',
    plantedIn: null,
    resolveDeadline: null,
    resolvedIn: null,
    progressedIn: [],
    dependsOn: [],
    weight: 'light',
    ...overrides,
  };
}

describe('parseForeshadowFile：旧格式迁移与宽容解析', () => {
  it('新 schema 原样解析，migrated=false', () => {
    const text = JSON.stringify({
      foreshadows: [{
        id: 1, content: '开篇的旧伤疤', type: 'identity', status: 'planted',
        plantedIn: 2, resolveDeadline: 9, resolvedIn: null, dependsOn: [3], weight: 'major',
      }],
    });
    const { foreshadows, migrated, warnings } = parseForeshadowFile(text);
    expect(migrated).toBe(false);
    expect(warnings).toHaveLength(0);
    expect(foreshadows).toHaveLength(1);
    expect(foreshadows[0]).toMatchObject({
      id: 1, content: '开篇的旧伤疤', type: 'identity', status: 'planted',
      plantedIn: 2, resolveDeadline: 9, resolvedIn: null, dependsOn: [3], weight: 'major',
    });
  });

  it('plantedIn 为自由文本时提取首个数字："第64-66章"→64，且标记迁移', () => {
    const { foreshadows, migrated } = parseForeshadowFile(JSON.stringify({
      foreshadows: [{ id: 1, content: '旧格式条目', status: 'planted', plantedIn: '第64-66章', resolvedIn: null }],
    }));
    expect(migrated).toBe(true);
    expect(foreshadows[0].plantedIn).toBe(64);
    expect(foreshadows[0].rawPlantedIn).toBeUndefined();
  });

  it('plantedIn 自由文本无法提取数字时降级为 null 并保留原文', () => {
    const { foreshadows, migrated } = parseForeshadowFile(JSON.stringify({
      foreshadows: [{ id: 1, content: '无章号条目', status: 'pending', plantedIn: '序章之前' }],
    }));
    expect(migrated).toBe(true);
    expect(foreshadows[0].plantedIn).toBeNull();
    expect(foreshadows[0].rawPlantedIn).toBe('序章之前');
  });

  it('plantedIn 为数字型字符串同样提取（"12"→12）', () => {
    const { foreshadows } = parseForeshadowFile(JSON.stringify({
      foreshadows: [{ id: 1, content: '数字字符串', status: 'planted', plantedIn: '12' }],
    }));
    expect(foreshadows[0].plantedIn).toBe(12);
  });

  it('未知 status 丢弃并记 warning，不丢其余条目', () => {
    const { foreshadows, warnings } = parseForeshadowFile(JSON.stringify({
      foreshadows: [
        { id: 1, content: '非法状态', status: 'unknown' },
        { id: 2, content: '合法条目', status: 'pending' },
      ],
    }));
    expect(foreshadows).toHaveLength(1);
    expect(foreshadows[0].id).toBe(2);
    expect(warnings.some((w) => w.includes('status 非法'))).toBe(true);
  });

  it('字段缺失给默认值：type=chekhov / weight=light / dependsOn=[]', () => {
    const { foreshadows, migrated } = parseForeshadowFile(JSON.stringify({
      foreshadows: [{ id: 7, content: '最小条目', status: 'planted', plantedIn: 1, resolvedIn: null }],
    }));
    expect(migrated).toBe(true); // 缺新字段视为旧格式
    expect(foreshadows[0].type).toBe('chekhov');
    expect(foreshadows[0].weight).toBe('light');
    expect(foreshadows[0].dependsOn).toEqual([]);
    expect(foreshadows[0].resolveDeadline).toBeNull();
  });

  it('content 缺失的条目跳过并记 warning', () => {
    const { foreshadows, warnings } = parseForeshadowFile(JSON.stringify({
      foreshadows: [{ id: 1, status: 'pending' }],
    }));
    expect(foreshadows).toHaveLength(0);
    expect(warnings.some((w) => w.includes('content'))).toBe(true);
  });

  it('非法 JSON / 空文本 / 缺 foreshadows 数组：不抛错返回空清单', () => {
    expect(parseForeshadowFile('{oops')).toEqual({
      foreshadows: [], migrated: false, warnings: [expect.any(String)],
    });
    expect(parseForeshadowFile('').foreshadows).toEqual([]);
    expect(parseForeshadowFile('{"items": []}').foreshadows).toEqual([]);
    expect(parseForeshadowFile('{"items": []}').warnings.length).toBeGreaterThan(0);
  });

  it('id 缺失时回退为序号；dependsOn 混合数字与数字字符串', () => {
    const { foreshadows } = parseForeshadowFile(JSON.stringify({
      foreshadows: [
        { content: '无 id 条目', status: 'planted', plantedIn: 1, type: 'world', weight: 'major', resolveDeadline: 5, dependsOn: ['2', 3] },
      ],
    }));
    expect(foreshadows[0].id).toBe(1);
    expect(foreshadows[0].dependsOn).toEqual([2, 3]);
  });
});

describe('serializeForeshadows', () => {
  it('round-trip：序列化后再解析不丢字段（含 rawPlantedIn）', () => {
    const list = [make({ id: 1, plantedIn: null, rawPlantedIn: '楔子末尾', status: 'planted' })];
    const parsed = parseForeshadowFile(serializeForeshadows(list));
    expect(parsed.foreshadows[0].rawPlantedIn).toBe('楔子末尾');
    expect(parsed.foreshadows[0].plantedIn).toBeNull();
    expect(parsed.migrated).toBe(false); // 新 schema 字段齐全，不再是旧格式
  });
});

describe('computeForeshadowStats：债务统计', () => {
  it('overdue 边界：期限 == 当前章不算逾期，期限 < 当前章才算；resolved/dropped 豁免', () => {
    const list = [
      make({ id: 1, status: 'planted', plantedIn: 2, resolveDeadline: 10 }), // 期限=当前章：不逾期
      make({ id: 2, status: 'planted', plantedIn: 2, resolveDeadline: 9 }),  // 期限 9 < 10：逾期
      make({ id: 3, status: 'resolved', plantedIn: 1, resolveDeadline: 5, resolvedIn: 4 }), // 已收：豁免
      make({ id: 4, status: 'dropped', plantedIn: 2, resolveDeadline: 5 }),  // 放弃：豁免
    ];
    const stats = computeForeshadowStats(list, 10, 20);
    expect(stats.overdue.map((f) => f.id)).toEqual([2]);
  });

  it('dueSoon 边界：(当前章, 当前章+10] 闭区间，两侧都不含', () => {
    const list = [
      make({ id: 1, status: 'planted', plantedIn: 1, resolveDeadline: 10 }), // == 当前章：不进 dueSoon
      make({ id: 2, status: 'planted', plantedIn: 1, resolveDeadline: 11 }), // 当前+1：进
      make({ id: 3, status: 'planted', plantedIn: 1, resolveDeadline: 20 }), // 当前+10：进
      make({ id: 4, status: 'planted', plantedIn: 1, resolveDeadline: 21 }), // 当前+11：不进
    ];
    const stats = computeForeshadowStats(list, 10, 30);
    expect(stats.dueSoon.map((f) => f.id)).toEqual([2, 3]);
  });

  it('orphaned：plantedIn 超出全书章数；chapterCount 未知（0）时跳过判定', () => {
    const list = [
      make({ id: 1, status: 'planted', plantedIn: 21 }),
      make({ id: 2, status: 'planted', plantedIn: 20 }),
    ];
    expect(computeForeshadowStats(list, 5, 20).orphaned.map((f) => f.id)).toEqual([1]);
    expect(computeForeshadowStats(list, 5, 0).orphaned).toEqual([]);
  });

  it('debtScore：未结清条目 major=2 / light=1，resolved/dropped 不计', () => {
    const list = [
      make({ id: 1, status: 'planted', weight: 'major' }),
      make({ id: 2, status: 'pending', weight: 'light' }),
      make({ id: 3, status: 'pending', weight: 'major' }),
      make({ id: 4, status: 'resolved', weight: 'major' }),
      make({ id: 5, status: 'dropped', weight: 'light' }),
      make({ id: 6, status: 'progressing', weight: 'light' }),
    ];
    expect(computeForeshadowStats(list, 1, 10).debtScore).toBe(6);
  });

  it('byStatus 与 total 统计五种状态', () => {
    const list = [
      make({ id: 1, status: 'pending' }),
      make({ id: 2, status: 'planted' }),
      make({ id: 3, status: 'progressing' }),
      make({ id: 4, status: 'resolved' }),
      make({ id: 5, status: 'dropped' }),
    ];
    const stats = computeForeshadowStats(list, 1, 10);
    expect(stats.total).toBe(5);
    expect(stats.byStatus).toEqual({ pending: 1, planted: 1, progressing: 1, resolved: 1, dropped: 1 });
  });

  it('density：pending 规划章不计入新埋；planted/progressing/resolved 按 plantedIn 逐章计数', () => {
    const list = [
      make({ id: 1, status: 'planted', plantedIn: 2 }),
      make({ id: 2, status: 'resolved', plantedIn: 2, resolvedIn: 4 }),
      make({ id: 3, status: 'pending', plantedIn: 2 }), // 仍是规划，不算已埋
      make({ id: 4, status: 'progressing', plantedIn: 2 }), // 推进中同样是实际新埋
    ];
    const stats = computeForeshadowStats(list, 3, 4);
    expect(stats.density).toEqual([
      { chapter: 1, planted: 0, resolved: 0 },
      { chapter: 2, planted: 3, resolved: 0 },
      { chapter: 3, planted: 0, resolved: 0 },
      { chapter: 4, planted: 0, resolved: 1 },
    ]);
  });

  it('chapterCount 未知时密度横轴退化为数据中的最大章号', () => {
    const stats = computeForeshadowStats([make({ id: 1, status: 'planted', plantedIn: 3 })], 1, 0);
    expect(stats.density.map((d) => d.chapter)).toEqual([1, 2, 3]);
  });
});

describe('computeDensityBudget：每 3 章新埋不超过 2 条', () => {
  it('窗口内新埋未超限：可新埋 = 剩余额度', () => {
    const list = [
      make({ id: 1, status: 'planted', plantedIn: 9 }),
      make({ id: 2, status: 'resolved', plantedIn: 8, resolvedIn: 9 }),
    ];
    const b = computeDensityBudget(list, 10);
    expect(b.windowStart).toBe(8);
    expect(b.plantedInWindow).toBe(2);
    expect(b.canPlantNow).toBe(0);
    expect(b.overBudget).toBe(false);
  });

  it('窗口内新埋超限：overBudget=true 且可新埋归零', () => {
    const list = [
      make({ id: 1, status: 'planted', plantedIn: 8 }),
      make({ id: 2, status: 'planted', plantedIn: 9 }),
      make({ id: 3, status: 'planted', plantedIn: 10 }),
    ];
    const b = computeDensityBudget(list, 10);
    expect(b.plantedInWindow).toBe(3);
    expect(b.overBudget).toBe(true);
    expect(b.canPlantNow).toBe(0);
  });

  it('窗口外（更早）的新埋不计入预算', () => {
    const list = [
      make({ id: 1, status: 'planted', plantedIn: 5 }),
      make({ id: 2, status: 'planted', plantedIn: 7 }),
    ];
    const b = computeDensityBudget(list, 10); // 窗口 [8,10]
    expect(b.plantedInWindow).toBe(0);
    expect(b.canPlantNow).toBe(2);
  });

  it('dueForResolve：期限 ≤ 当前章且未结清的条目（含已逾期）', () => {
    const list = [
      make({ id: 1, status: 'planted', resolveDeadline: 9 }),   // 已逾期
      make({ id: 2, status: 'planted', resolveDeadline: 10 }),  // 本章到期
      make({ id: 3, status: 'planted', resolveDeadline: 11 }),  // 未来
      make({ id: 4, status: 'resolved', resolveDeadline: 9, resolvedIn: 9 }),
    ];
    expect(computeDensityBudget(list, 10).dueForResolve).toBe(2);
  });

  it('可自定义窗口与上限', () => {
    const list = [make({ id: 1, status: 'planted', plantedIn: 2 })];
    const b = computeDensityBudget(list, 2, { windowSize: 5, limit: 3 });
    expect(b.windowStart).toBe(1);
    expect(b.limit).toBe(3);
    expect(b.canPlantNow).toBe(2);
  });
});

describe('resolveCurrentChapter', () => {
  it('写作已开始时以实际进度为准（忽略未来埋设章）', () => {
    const list = [make({ id: 1, plantedIn: 7 }), make({ id: 2, plantedIn: 3 })];
    expect(resolveCurrentChapter(list, 5)).toBe(5);
    expect(resolveCurrentChapter(list, 9)).toBe(9);
  });

  it('未开写（进度 0）时回退到最大规划埋设章', () => {
    const list = [make({ id: 1, plantedIn: 7 }), make({ id: 2, plantedIn: 3 })];
    expect(resolveCurrentChapter(list, 0)).toBe(7);
  });

  it('未开写时推进记录章号也作为已写进度证据', () => {
    const list = [
      make({ id: 1, plantedIn: 2, progressedIn: [6] }),
      make({ id: 2, plantedIn: 9, progressedIn: [] }),
    ];
    expect(resolveCurrentChapter(list, 0)).toBe(9);
    expect(resolveCurrentChapter([make({ id: 3, plantedIn: 2, progressedIn: [6] })], 0)).toBe(6);
  });

  it('空清单与非法进度回退为 0', () => {
    expect(resolveCurrentChapter([], 0)).toBe(0);
    expect(resolveCurrentChapter([], NaN)).toBe(0);
  });
});

describe('progressedIn：向后兼容与解析', () => {
  it('旧数据缺失 progressedIn 时默认 []，且不被标记为旧格式', () => {
    const { foreshadows, migrated } = parseForeshadowFile(JSON.stringify({
      foreshadows: [{
        id: 1, content: '新 schema 但无推进记录', type: 'chekhov', status: 'planted',
        plantedIn: 2, resolveDeadline: 9, resolvedIn: null, dependsOn: [], weight: 'light',
      }],
    }));
    expect(migrated).toBe(false);
    expect(foreshadows[0].progressedIn).toEqual([]);
  });

  it('接受 progressing 状态，progressedIn 支持数字/数字字符串、去重并升序', () => {
    const { foreshadows } = parseForeshadowFile(JSON.stringify({
      foreshadows: [{
        id: 1, content: '推进中', type: 'identity', status: 'progressing',
        plantedIn: 2, resolveDeadline: 12, resolvedIn: null, dependsOn: [], weight: 'major',
        progressedIn: ['第7章', 5, 7, '第3章'],
      }],
    }));
    expect(foreshadows[0].status).toBe('progressing');
    expect(foreshadows[0].progressedIn).toEqual([3, 5, 7]);
  });

  it('非法 progressedIn 值被宽容丢弃', () => {
    const { foreshadows } = parseForeshadowFile(JSON.stringify({
      foreshadows: [{
        id: 1, content: '推进中', type: 'world', status: 'planted',
        plantedIn: 1, resolveDeadline: null, resolvedIn: null, dependsOn: [], weight: 'light',
        progressedIn: ['序章', null, 4],
      }],
    }));
    expect(foreshadows[0].progressedIn).toEqual([4]);
  });

  it('序列化 round-trip 保留 progressedIn', () => {
    const list = [make({ id: 1, status: 'progressing', plantedIn: 1, progressedIn: [3, 6] })];
    const parsed = parseForeshadowFile(serializeForeshadows(list));
    expect(parsed.foreshadows[0].progressedIn).toEqual([3, 6]);
  });
});

describe('伏笔状态机迁移表', () => {
  it('允许前向迁移：pending→planted、planted→progressing、progressing→resolved', () => {
    expect(canTransitionForeshadow('pending', 'planted')).toBe(true);
    expect(canTransitionForeshadow('planted', 'progressing')).toBe(true);
    expect(canTransitionForeshadow('progressing', 'resolved')).toBe(true);
  });

  it('允许 planted 直接 resolved，以及任意未结清状态 → dropped', () => {
    expect(canTransitionForeshadow('planted', 'resolved')).toBe(true);
    expect(canTransitionForeshadow('pending', 'dropped')).toBe(true);
    expect(canTransitionForeshadow('planted', 'dropped')).toBe(true);
    expect(canTransitionForeshadow('progressing', 'dropped')).toBe(true);
  });

  it('拒绝回退与跨级迁移：progressing→planted、planted→pending、pending→progressing/resolved', () => {
    expect(canTransitionForeshadow('progressing', 'planted')).toBe(false);
    expect(canTransitionForeshadow('planted', 'pending')).toBe(false);
    expect(canTransitionForeshadow('pending', 'progressing')).toBe(false);
    expect(canTransitionForeshadow('pending', 'resolved')).toBe(false);
  });

  it('同状态为 no-op；reopen=true 可显式回退/重新打开到非终态', () => {
    expect(canTransitionForeshadow('resolved', 'resolved')).toBe(true);
    expect(canTransitionForeshadow('resolved', 'planted')).toBe(false);
    expect(canTransitionForeshadow('resolved', 'planted', { reopen: true })).toBe(true);
    expect(canTransitionForeshadow('dropped', 'progressing', { reopen: true })).toBe(true);
    // reopen 允许纠正任意回退，但不能把已收/已放弃改成终态
    expect(canTransitionForeshadow('progressing', 'planted', { reopen: true })).toBe(true);
    expect(canTransitionForeshadow('planted', 'pending', { reopen: true })).toBe(true);
    // reopen 不覆盖正常前向迁移
    expect(canTransitionForeshadow('planted', 'resolved', { reopen: true })).toBe(true);
    expect(canTransitionForeshadow('pending', 'dropped', { reopen: true })).toBe(true);
    expect(canTransitionForeshadow('resolved', 'dropped', { reopen: true })).toBe(false);
  });

  it('transitionForeshadow：进入 progressing 记录章号并去重升序', () => {
    const item = make({ id: 1, status: 'planted', plantedIn: 2, progressedIn: [3] });
    const first = transitionForeshadow(item, 'progressing', { chapter: 5 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.foreshadow.status).toBe('progressing');
    expect(first.foreshadow.progressedIn).toEqual([3, 5]);

    // 已在 progressing 时再次推进（同状态 no-op）也可追加新章号
    const second = transitionForeshadow(first.foreshadow, 'progressing', { chapter: 8 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.foreshadow.progressedIn).toEqual([3, 5, 8]);

    // 重复章号不重复记录
    const duplicate = transitionForeshadow(second.foreshadow, 'progressing', { chapter: 8 });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.foreshadow.progressedIn).toEqual([3, 5, 8]);
  });

  it('transitionForeshadow：非法迁移返回 ok=false；reopen 清空 resolvedIn', () => {
    const progressing = make({ id: 1, status: 'progressing' });
    const invalid = transitionForeshadow(progressing, 'planted');
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error).toContain('非法状态迁移');

    const resolved = make({ id: 2, status: 'resolved', resolvedIn: 9 });
    const reopened = transitionForeshadow(resolved, 'planted', { reopen: true });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.foreshadow.status).toBe('planted');
    expect(reopened.foreshadow.resolvedIn).toBeNull();
  });
});

describe('isForeshadowOverdue / isForeshadowDueSoon 边界', () => {
  it('逾期边界：deadline == currentChapter 不算逾期，< currentChapter 才算', () => {
    const boundary = make({ id: 1, status: 'planted', resolveDeadline: 10 });
    const late = make({ id: 2, status: 'planted', resolveDeadline: 9 });
    expect(isForeshadowOverdue(boundary, 10)).toBe(false);
    expect(isForeshadowOverdue(late, 10)).toBe(true);
  });

  it('progressing 计入逾期；resolved/dropped/无期限豁免', () => {
    expect(isForeshadowOverdue(make({ id: 1, status: 'progressing', resolveDeadline: 3 }), 10)).toBe(true);
    expect(isForeshadowOverdue(make({ id: 2, status: 'resolved', resolveDeadline: 3 }), 10)).toBe(false);
    expect(isForeshadowOverdue(make({ id: 3, status: 'dropped', resolveDeadline: 3 }), 10)).toBe(false);
    expect(isForeshadowOverdue(make({ id: 4, status: 'planted', resolveDeadline: null }), 10)).toBe(false);
  });

  it('临期窗口为 (currentChapter, currentChapter+10]，两侧边界都不含/含', () => {
    expect(isForeshadowDueSoon(make({ id: 1, status: 'planted', resolveDeadline: 10 }), 10)).toBe(false);
    expect(isForeshadowDueSoon(make({ id: 2, status: 'planted', resolveDeadline: 11 }), 10)).toBe(true);
    expect(isForeshadowDueSoon(make({ id: 3, status: 'progressing', resolveDeadline: 20 }), 10)).toBe(true);
    expect(isForeshadowDueSoon(make({ id: 4, status: 'planted', resolveDeadline: 21 }), 10)).toBe(false);
  });
});
