import { describe, it, expect } from 'vitest';
import { parseChapterNumber, isSummaryFileName, chapterFileName } from '../../../src/shared/chapter-names';

describe('parseChapterNumber', () => {
  it('识别规范中文命名', () => {
    expect(parseChapterNumber('第3章.md')).toBe(3);
    expect(parseChapterNumber('第12章.md')).toBe(12);
  });

  it('识别英文命名（大小写不敏感）', () => {
    expect(parseChapterNumber('chapter-3.md')).toBe(3);
    expect(parseChapterNumber('Chapter-3.MD')).toBe(3);
  });

  it('识别带空格/标题后缀的近似命名（#14 放宽识别）', () => {
    expect(parseChapterNumber('第3章 风雪夜.md')).toBe(3);
    expect(parseChapterNumber('第 3 章.md')).toBe(3);
    expect(parseChapterNumber('第3章_副本.md')).toBe(3);
  });

  it('识别全角数字', () => {
    expect(parseChapterNumber('第３章.md')).toBe(3);
  });

  it('排除摘要与退化文件', () => {
    expect(parseChapterNumber('第3章.summary.md')).toBeNull();
    expect(parseChapterNumber('第3章.degraded.md')).toBeNull();
    expect(parseChapterNumber('chapter-3.degraded.md')).toBeNull();
  });

  it('排除非章节文件', () => {
    expect(parseChapterNumber('README.md')).toBeNull();
    expect(parseChapterNumber('characters.md')).toBeNull();
    expect(parseChapterNumber('第X章.md')).toBeNull();
  });
});

describe('isSummaryFileName / chapterFileName', () => {
  it('识别摘要文件名', () => {
    expect(isSummaryFileName('第3章.summary.md')).toBe(true);
    expect(isSummaryFileName('第3章.md')).toBe(false);
  });

  it('生成规范正文章节名', () => {
    expect(chapterFileName(7)).toBe('第7章.md');
  });
});
