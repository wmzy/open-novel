import { createPatch } from 'diff';

/**
 * 生成两段文本之间的 unified diff。
 * @param oldContent 修改前内容
 * @param newContent 修改后内容
 * @param filePath 文件路径（用于 diff header）
 * @returns unified diff 字符串，内容相同时返回空串
 */
export function createUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  if (oldContent === newContent) return '';
  const fileName = filePath.split('/').pop() || filePath;
  return createPatch(fileName, oldContent, newContent, '', '', { context: 3 });
}

export interface DiffSummary {
  addedLines: number;
  removedLines: number;
}

/**
 * 从 unified diff 字符串统计添加/删除行数。
 * 跳过 +++/--- header 行，只统计 hunk 内的 +/- 内容行。
 */
export function summarizeDiff(diff: string): DiffSummary {
  if (!diff) return { addedLines: 0, removedLines: 0 };
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) addedLines++;
    else if (line.startsWith('-')) removedLines++;
  }
  return { addedLines, removedLines };
}
