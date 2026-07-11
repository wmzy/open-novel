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
});
