/**
 * 章节正文文件名解析（共享工具）。
 *
 * 主命名约定：第{N}章.md（SKILL 指导 agent 写的中文命名）。
 * 兼容：chapter-{N}.md（早期英文约定）、「第 N 章.md」（空格）、
 * 「第3章 标题.md」（带标题后缀）、全角数字（第３章.md）。
 * 排除：.summary.md / .degraded.md（摘要与质检归档，非正文）。
 */

/** 全角数字 → 半角。 */
function normalizeDigits(name: string): string {
  return name.replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));
}

/**
 * 从文件 basename 解析章节号。非正文命名返回 null。
 */
export function parseChapterNumber(basename: string): number | null {
  if (basename.includes('.summary.') || basename.includes('.degraded.')) return null;
  const norm = normalizeDigits(basename);
  const cn = norm.match(/^第\s*(\d+)\s*章(?:[\s._-].*)?\.md$/);
  if (cn) return parseInt(cn[1], 10);
  const en = norm.match(/^chapter-(\d+)\.md$/i);
  if (en) return parseInt(en[1], 10);
  return null;
}

/** 是否为章节摘要文件名（第N章.summary.md）。 */
export function isSummaryFileName(basename: string): boolean {
  return /^第\s*\d+\s*章\.summary\.md$/.test(normalizeDigits(basename));
}

/** 章节正文的规范文件名。 */
export function chapterFileName(num: number): string {
  return `第${num}章.md`;
}
