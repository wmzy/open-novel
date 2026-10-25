import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  assembleWithBudget,
  type ContextSection,
} from '../../../src/agent/context-budget';

describe('estimateTokens', () => {
  it('CJK 每字 1 token', () => {
    expect(estimateTokens('林青客栈')).toBe(4);
  });

  it('拉丁词 ×1.3 向上取整', () => {
    expect(estimateTokens('hello')).toBe(2); // ceil(1×1.3)
    expect(estimateTokens('hello world')).toBe(3); // ceil(2×1.3)
    expect(estimateTokens('abc def ghi')).toBe(4); // ceil(3×1.3)=ceil(3.9)
  });

  it('混合文本：CJK 字数 + 拉丁词折算', () => {
    expect(estimateTokens('林青说 ok')).toBe(5); // 3 CJK + ceil(1×1.3)=2
  });

  it('空串与纯标点空白为 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('，。！； \n\t')).toBe(0);
  });
});

/** 构造一层的便捷函数。 */
function sec(name: string, priority: number, text: string): ContextSection {
  return { name, priority, text };
}

/** 生成 n 个 CJK 字。 */
function cjk(n: number): string {
  return '设'.repeat(n);
}

describe('assembleWithBudget', () => {
  it('未超预算：全部保留，按原顺序以空行拼接，报告逐层对应', () => {
    const sections = [
      sec('合同', 0, `### 合同\n${cjk(10)}`),
      sec('大纲', 2, `### 大纲\n${cjk(20)}`),
      sec('文风', 5, `### 文风\n${cjk(5)}`),
    ];
    const { text, report, totalTokens, budgetTokens } = assembleWithBudget(sections, 1000);
    expect(text).toBe(sections.map((s) => s.text).join('\n\n'));
    expect(report.map((r) => r.name)).toEqual(['合同', '大纲', '文风']);
    expect(report.every((r) => r.kept)).toBe(true);
    expect(report.some((r) => r.truncatedTo !== undefined)).toBe(false);
    expect(report[1].tokens).toBe(estimateTokens(sections[1].text));
    expect(totalTokens).toBe(estimateTokens(text));
    expect(totalTokens).toBeLessThanOrEqual(budgetTokens);
  });

  it('空输入：text 为空串、报告为空数组', () => {
    const { text, report, totalTokens } = assembleWithBudget([], 100);
    expect(text).toBe('');
    expect(report).toEqual([]);
    expect(totalTokens).toBe(0);
  });

  it('超预算：从最大 priority 层开始整层丢弃', () => {
    const sections = [
      sec('合同', 0, cjk(10)),
      sec('状态', 3, cjk(10)),
      sec('滚动摘要', 4, cjk(10)),
      sec('语义回忆', 6, cjk(50)), // 最大 priority 且最大——应被丢
    ];
    const { text, report, totalTokens } = assembleWithBudget(sections, 35);
    const dropped = report.find((r) => r.name === '语义回忆')!;
    expect(dropped.kept).toBe(false);
    expect(dropped.tokens).toBe(50); // 报告保留原始构建成本，便于诊断
    expect(report.filter((r) => r.kept).map((r) => r.name)).toEqual(['合同', '状态', '滚动摘要']);
    // 丢弃后回到预算内：其余层原样保留
    expect(text).toContain(sections[1].text);
    expect(totalTokens).toBeLessThanOrEqual(35);
  });

  it('同 priority：更靠后的层先被丢弃', () => {
    const sections = [
      sec('核心设定', 5, cjk(20)),
      sec('文风', 5, cjk(20)),
      sec('活跃伏笔', 5, cjk(20)),
    ];
    const { report } = assembleWithBudget(sections, 45);
    const kept = report.filter((r) => r.kept).map((r) => r.name);
    expect(kept).toEqual(['核心设定', '文风']);
    expect(report.find((r) => r.name === '活跃伏笔')!.kept).toBe(false);
  });

  it('硬约束层（priority 0）永不整层丢弃，只截断', () => {
    const sections = [
      sec('章节合同', 0, cjk(100)),
      sec('状态表', 3, cjk(10)),
      sec('滚动摘要', 4, cjk(10)),
    ];
    // 丢完状态表/滚动摘要后合同 100 > 20 仍超 → 合同只截断不丢弃
    const { text, report, totalTokens } = assembleWithBudget(sections, 20);
    expect(report.find((r) => r.name === '状态表')!.kept).toBe(false);
    expect(report.find((r) => r.name === '滚动摘要')!.kept).toBe(false);
    const contract = report.find((r) => r.name === '章节合同')!;
    expect(contract.kept).toBe(true);
    expect(contract.truncatedTo).toBeDefined();
    expect(text).toContain('…（已截断）');
    expect(text.startsWith('设')).toBe(true); // 保留层首
    expect(totalTokens).toBeLessThanOrEqual(20);
  });

  it('丢完仍超的场景下低优先层先丢光，再截断硬约束层', () => {
    const sections = [
      sec('章节合同', 0, cjk(50)),
      sec('本章大纲', 2, cjk(50)),
      sec('状态表', 3, cjk(50)),
    ];
    const { text, report, totalTokens } = assembleWithBudget(sections, 60);
    // 阶段一：丢状态表(3) → 100 > 60；丢大纲(2) → 50 ≤ 60 停止
    expect(report.find((r) => r.name === '状态表')!.kept).toBe(false);
    expect(report.find((r) => r.name === '本章大纲')!.kept).toBe(false);
    expect(report.find((r) => r.name === '章节合同')!.kept).toBe(true);
    expect(text).toBe(cjk(50));
    expect(totalTokens).toBe(50);
  });

  it('截断按 priority 从大到小：先截低优先层，硬约束层最后截', () => {
    const sections = [
      sec('章节合同', 0, cjk(100)),
      sec('Canon', 1, cjk(5)),
    ];
    // 总 105 > 60：丢 Canon(1) → 100 > 60 仍超 → 截断合同到 60 tokens
    const { text, report, totalTokens } = assembleWithBudget(sections, 60);
    expect(report.find((r) => r.name === 'Canon')!.kept).toBe(false);
    const contract = report.find((r) => r.name === '章节合同')!;
    expect(contract.kept).toBe(true);
    expect(contract.truncatedTo).toBeDefined();
    expect(text.endsWith('…（已截断）')).toBe(true);
    expect(totalTokens).toBeLessThanOrEqual(60);
  });

  it('两个 priority 0 层共存且都不可丢：按 priority 从大到小（同优先丢后置先）逐层截断', () => {
    const sections = [
      sec('章节合同', 0, cjk(100)),
      sec('合同附录', 0, cjk(100)),
    ];
    // 200 > 110 且无可丢层 → 先截更靠后的「合同附录」，合同保持原样
    const { text, report, totalTokens } = assembleWithBudget(sections, 110);
    expect(report.find((r) => r.name === '章节合同')!.truncatedTo).toBeUndefined();
    expect(report.find((r) => r.name === '合同附录')!.truncatedTo).toBeDefined();
    expect(text).toContain('…（已截断）');
    expect(totalTokens).toBeLessThanOrEqual(110);
  });

  it('预算极小：前缀退化为空，仅剩截断标记', () => {
    const sections = [sec('章节合同', 0, cjk(1000))];
    const { text, report } = assembleWithBudget(sections, 0);
    expect(report[0].kept).toBe(true);
    expect(report[0].truncatedTo).toBe(0);
    expect(text).toBe('…（已截断）');
  });

  it('零 token 层（空文本）不会被无意义丢弃', () => {
    const sections = [
      sec('空层', 5, ''),
      sec('状态表', 3, cjk(10)),
      sec('语义回忆', 6, cjk(100)),
    ];
    const { report } = assembleWithBudget(sections, 20);
    expect(report.find((r) => r.name === '空层')!.kept).toBe(true);
    expect(report.find((r) => r.name === '语义回忆')!.kept).toBe(false);
  });
});
