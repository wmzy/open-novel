import { describe, it, expect } from 'vitest';
import {
  generateOutlineDetailedSplit,
  type TemplateGenOptions,
  type SplitTemplateResult,
} from '../../../src/shared/template-generator';

const baseOpts: TemplateGenOptions = {
  chapterCount: 5,
  targetWords: 25000,
  title: '测试小说',
  genre: 'wuxia',
  perspective: 'third-person',
};

describe('generateOutlineDetailedSplit', () => {
  it('返回 indexContent + cards，卡片数 = 章节数', () => {
    const result = generateOutlineDetailedSplit(baseOpts);
    expect(result.indexContent).toContain('详细大纲索引');
    expect(result.cards).toHaveLength(5);
  });

  it('每张卡片含 ## 标题 + 结构定位 + 字段占位', () => {
    const result = generateOutlineDetailedSplit(baseOpts);
    const card1 = result.cards[0];
    expect(card1.relativePath).toBe('chapters/第1章.md');
    expect(card1.content).toContain('## 第 1 章');
    expect(card1.content).toContain('**结构定位**');
    expect(card1.content).toContain('**主要场景**');
  });

  it('索引含三幕结构表和章节表', () => {
    const result = generateOutlineDetailedSplit(baseOpts);
    expect(result.indexContent).toContain('第一幕');
    expect(result.indexContent).toContain('chapters/第1章.md');
    expect(result.indexContent).toContain('chapters/第5章.md');
  });

  it('章节数为 1 时不报错', () => {
    const result = generateOutlineDetailedSplit({ ...baseOpts, chapterCount: 1 });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].relativePath).toBe('chapters/第1章.md');
  });

  it('粒度梯度：首 10 章 committed + beat 级字段，二幕 open + openQuestions 占位', () => {
    // 30 章：act1End=8、act3Start=23 → 第 1-10 章 committed，第 11 章起 open
    const result = generateOutlineDetailedSplit({ ...baseOpts, chapterCount: 30 });

    const first = result.cards[0].content;
    expect(first).toContain('> commitment: committed');
    expect(first).toContain('**主要场景**');
    expect(first).toContain('**冲突**');
    expect(first).not.toContain('open-questions');

    const act2 = result.cards[14].content; // 第 15 章（第二幕）
    expect(act2).toContain('> commitment: open');
    expect(act2).toContain('> open-questions:');
    expect(act2).toContain('{待决策：');
    expect(act2).toContain('幕级骨架');
    expect(act2).not.toContain('**主要场景**');
  });

  it('粒度梯度：第一幕中段（第 11-15 章）为 tentative + arc 级字段', () => {
    // 60 章：act1End=15、act3Start=46 → 第 1-10 章 committed，第 11-15 章 tentative，第 16 章起 open
    const result = generateOutlineDetailedSplit({ ...baseOpts, chapterCount: 60 });

    const tentative = result.cards[11].content; // 第 12 章（第一幕其余）
    expect(tentative).toContain('> commitment: tentative');
    expect(tentative).toContain('走向（arc）');
    expect(tentative).not.toContain('open-questions');

    expect(result.cards[9].content).toContain('> commitment: committed'); // 第 10 章
    expect(result.cards[15].content).toContain('> commitment: open'); // 第 16 章（第二幕）
  });

  it('索引含承诺等级列与远粗设计说明', () => {
    const result = generateOutlineDetailedSplit({ ...baseOpts, chapterCount: 30 });
    expect(result.indexContent).toContain('| 章 | 标题 | 承诺等级 | 文件 |');
    expect(result.indexContent).toContain('| 1 | {章节标题} | 已定 | chapters/第1章.md |');
    expect(result.indexContent).toContain('| 11 | {章节标题} | 待决 | chapters/第11章.md |');
    expect(result.indexContent).toContain('并非未完成');
  });
});
