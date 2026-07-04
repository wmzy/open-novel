import { describe, it, expect } from 'vitest';
import { detectChapters, chineseToNumber } from '../../../src/shared/text-chunker';

describe('chineseToNumber', () => {
  it('中文数字转阿拉伯数字', () => {
    expect(chineseToNumber('一')).toBe(1);
    expect(chineseToNumber('十')).toBe(10);
    expect(chineseToNumber('二十三')).toBe(23);
    expect(chineseToNumber('一百零五')).toBe(105);
  });
  it('非中文数字原样返回 null', () => {
    expect(chineseToNumber('abc')).toBeNull();
  });
});

describe('detectChapters — 单文件', () => {
  it('中文章节标记（第N章）切分', () => {
    const content = `第一章 出发\n内容A\n\n第二章 抵达\n内容B`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.txt' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
    expect(chapters[0].title).toBe('出发');
    expect(chapters[0].content).toContain('内容A');
    expect(chapters[1].number).toBe(2);
    expect(chapters[1].title).toBe('抵达');
  });

  it('中文数字章号归一化', () => {
    const content = `第二十三章 转折\n内容`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.txt' });
    expect(chapters[0].number).toBe(23);
  });

  it('英文章节标记（Chapter N）切分', () => {
    const content = `Chapter 1\nContent A\n\nChapter 2\nContent B`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.md' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
    expect(chapters[1].number).toBe(2);
  });

  it('数字编号标题（N. 标题）切分', () => {
    const content = `1. 开始\n内容A\n\n2. 结束\n内容B`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.txt' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
    expect(chapters[1].number).toBe(2);
  });

  it('切分失败（无标记）降级为单章', () => {
    const content = `这是一段没有章节标记的纯文本。`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.txt' });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].number).toBe(1);
    expect(chapters[0].title).toBe('第1章');
    expect(chapters[0].content).toBe(content);
  });

  it('Markdown 标题（# 标题）不误判为章节', () => {
    const content = `# 书名\n\n# 第一章 开端\n内容\n\n# 第二章 发展\n内容`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.md' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
  });
});

describe('detectChapters — 目录', () => {
  it('按文件名自然排序，文件名数字作章号', () => {
    const files = [
      { name: '3.md', content: '第三章内容' },
      { name: '1.md', content: '第一章内容' },
      { name: '2.md', content: '第二章内容' },
    ];
    const chapters = detectChapters({ kind: 'dir', files });
    expect(chapters).toHaveLength(3);
    expect(chapters[0].number).toBe(1);
    expect(chapters[0].content).toBe('第一章内容');
    expect(chapters[2].number).toBe(3);
  });

  it('文件名无数字时按排序顺序递增', () => {
    const files = [
      { name: 'alpha.md', content: '内容A' },
      { name: 'beta.md', content: '内容B' },
    ];
    const chapters = detectChapters({ kind: 'dir', files });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
    expect(chapters[1].number).toBe(2);
  });

  it('空目录返回空数组', () => {
    const chapters = detectChapters({ kind: 'dir', files: [] });
    expect(chapters).toEqual([]);
  });
});
