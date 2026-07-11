import { describe, it, expect } from 'vitest';
import {
  splitMarkdownToCards,
  buildIndexMarkdown,
  sanitizeFileName,
  DOC_DIR,
  type DocType,
} from '../../../src/shared/split-document';

describe('splitMarkdownToCards', () => {
  it('按 ## 标题切分为独立卡片', () => {
    const md = `# 文档标题

> 元数据行

## 第一节

内容 A

## 第二节

内容 B
`;
    const result = splitMarkdownToCards(md, 'concept');
    expect(result.docTitle).toBe('文档标题');
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].title).toBe('第一节');
    expect(result.cards[0].content).toBe('## 第一节\n\n内容 A');
    expect(result.cards[1].title).toBe('第二节');
    expect(result.cards[1].content).toBe('## 第二节\n\n内容 B');
  });

  it('空文档返回空卡片数组', () => {
    const result = splitMarkdownToCards('', 'concept');
    expect(result.cards).toHaveLength(0);
    expect(result.docTitle).toBe('');
  });

  it('只有标题没有 section 时返回空卡片数组', () => {
    const md = '# 标题\n\n一些引言行';
    const result = splitMarkdownToCards(md, 'concept');
    expect(result.cards).toHaveLength(0);
  });

  it('outline 类型：章节标题提取章号', () => {
    const md = `# 大纲

## 第 3 章：测试 ｜ 第一幕·设置 ｜ 目标约 5000 字

- **结构定位**：开篇

## 第 4 章：测试2 ｜ 第一幕·设置 ｜ 目标约 5000 字

- **结构定位**：铺垫
`;
    const result = splitMarkdownToCards(md, 'outline');
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].fileName).toBe('chapters/第3章.md');
    expect(result.cards[1].fileName).toBe('chapters/第4章.md');
  });

  it('concept/world 类型：文件名 = section 标题', () => {
    const md = `# 概念

## 核心主题

内容
`;
    const result = splitMarkdownToCards(md, 'concept');
    expect(result.cards[0].fileName).toBe('核心主题.md');
  });

  it('卡片内容含字段和列表', () => {
    const md = `# 概念

## 核心主题

- **要素**：价值
- 普通列表项

自由段落。
`;
    const result = splitMarkdownToCards(md, 'concept');
    expect(result.cards[0].content).toContain('## 核心主题');
    expect(result.cards[0].content).toContain('**要素**：价值');
    expect(result.cards[0].content).toContain('自由段落');
  });
});

describe('sanitizeFileName', () => {
  it('去掉路径分隔符和特殊字符', () => {
    expect(sanitizeFileName('核心主题：探索/发现？')).toBe('核心主题：探索发现');
  });

  it('保留中文和冒号', () => {
    expect(sanitizeFileName('基本设定：角色')).toBe('基本设定：角色');
  });

  it('限制长度', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeFileName(long)).toHaveLength(80);
  });
});

describe('buildIndexMarkdown', () => {
  it('concept 索引包含标题表', () => {
    const cards = [
      { title: '基本信息', content: '## 基本信息\n\n一些内容', fileName: '基本信息.md' },
      { title: '核心主题', content: '## 核心主题\n\n一些内容', fileName: '核心主题.md' },
    ];
    const index = buildIndexMarkdown('concept', '《测试》', cards);
    expect(index).toContain('概念索引');
    expect(index).toContain('基本信息');
    expect(index).toContain('基本信息.md');
    expect(index).toContain('核心主题');
  });

  it('world 索引包含标题表', () => {
    const cards = [
      { title: '时代背景', content: '## 时代背景\n\n内容', fileName: '时代背景.md' },
    ];
    const index = buildIndexMarkdown('world', '《测试》', cards);
    expect(index).toContain('世界观索引');
    expect(index).toContain('时代背景');
    expect(index).toContain('时代背景.md');
  });

  it('outline 索引包含三幕结构 + 章节表', () => {
    const cards = [
      { title: '第 1 章：开头 ｜ 第一幕·设置', content: '## 第 1 章', fileName: 'chapters/第1章.md' },
      { title: '第 2 章：发展 ｜ 第二幕·对抗', content: '## 第 2 章', fileName: 'chapters/第2章.md' },
    ];
    const index = buildIndexMarkdown('outline', '《测试》', cards, [1, 1]);
    expect(index).toContain('详细大纲索引');
    expect(index).toContain('第一幕');
    expect(index).toContain('chapters/第1章.md');
    expect(index).toContain('chapters/第2章.md');
  });

  it('outline 索引无 actBreaks 时不报错', () => {
    const cards = [
      { title: '第 1 章：开头', content: '## 第 1 章', fileName: 'chapters/第1章.md' },
    ];
    const index = buildIndexMarkdown('outline', '《测试》', cards);
    expect(index).toContain('chapters/第1章.md');
  });
});

describe('DOC_DIR', () => {
  it('每种 DocType 映射到正确目录名', () => {
    expect(DOC_DIR.concept).toBe('concept');
    expect(DOC_DIR.world).toBe('world');
    expect(DOC_DIR.outline).toBe('outline');
  });
});
