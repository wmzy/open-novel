import { describe, it, expect } from 'vitest';
import { summarizeDiff } from '../../../src/shared/diff-utils';

// 组件渲染需要 jsdom + Linaria 环境，核心 diff 解析逻辑由 diff-utils.test.ts 覆盖。
// 这里验证 RevisionDiffPanel 依赖的数据契约。
describe('RevisionDiffPanel 数据逻辑', () => {
  it('summarizeDiff 正确统计', () => {
    const diff = `--- a/第3章.md\n+++ b/第3章.md\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx`;
    const s = summarizeDiff(diff);
    expect(s.addedLines).toBe(1);
    expect(s.removedLines).toBe(1);
  });
});
