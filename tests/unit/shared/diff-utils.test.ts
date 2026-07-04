import { describe, it, expect } from 'vitest';
import { createUnifiedDiff, summarizeDiff } from '../../../src/shared/diff-utils';

describe('createUnifiedDiff', () => {
  it('相同内容返回空 diff', () => {
    const diff = createUnifiedDiff('same', 'same', 'file.md');
    expect(diff).toBe('');
  });

  it('不同内容生成 unified diff', () => {
    const diff = createUnifiedDiff('line1\nline2\n', 'line1\nchanged\n', 'file.md');
    expect(diff).toContain('-line2');
    expect(diff).toContain('+changed');
    expect(diff).toContain('line1'); // 上下文行
  });

  it('文件名出现在 diff header', () => {
    const diff = createUnifiedDiff('a', 'b', 'chapters/第3章.md');
    expect(diff).toContain('第3章.md');
  });
});

describe('summarizeDiff', () => {
  it('统计添加和删除行数', () => {
    const diff = `--- a/file.md\n+++ b/file.md\n@@ -1,3 +1,3 @@\n context\n-deleted\n+added\n unchanged`;
    const summary = summarizeDiff(diff);
    expect(summary.addedLines).toBe(1);
    expect(summary.removedLines).toBe(1);
  });

  it('空 diff 返回 0', () => {
    const summary = summarizeDiff('');
    expect(summary.addedLines).toBe(0);
    expect(summary.removedLines).toBe(0);
  });

  it('多行增删正确累计', () => {
    const diff = `+++ b/f\n@@ -1,2 +1,4 @@\n ctx\n-old1\n-old2\n+new1\n+new2\n+new3\n+new4`;
    const summary = summarizeDiff(diff);
    expect(summary.addedLines).toBe(4);
    expect(summary.removedLines).toBe(2);
  });
});
