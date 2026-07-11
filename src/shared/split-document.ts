/**
 * 拆分文档核心模块：将整份 markdown 按 `##` 标题切分为独立卡片文件。
 *
 * 三种文档类型（concept / world / outline）共用此模块。
 * 拆分后每张卡是一个独立 .md 文件，加上 index.md 索引。
 */

import { parseSections } from '../web/components/views/parseSections';

/** 文档类型：决定目录名和文件名生成规则。 */
export type DocType = 'concept' | 'world' | 'outline';

/** 一张卡片的拆分结果。 */
export interface SplitCard {
  /** section 标题（不含 ## 前缀）。 */
  title: string;
  /** 卡片正文（含 `## 标题` 行 + 原始 markdown 正文）。 */
  content: string;
  /** 相对于文档目录的文件名，如 `chapters/第3章.md` 或 `核心主题.md`。 */
  fileName: string;
}

/** 拆分结果。 */
export interface SplitResult {
  /** 文档标题（`#` 行内容），用于索引。 */
  docTitle: string;
  /** 全部卡片。 */
  cards: SplitCard[];
}

/** DocType → `.novel/` 下的目录名。 */
export const DOC_DIR: Record<DocType, string> = {
  concept: 'concept',
  world: 'world',
  outline: 'outline',
};

/** DocType → 中文名（用于索引标题）。 */
const DOC_LABEL: Record<DocType, string> = {
  concept: '概念',
  world: '世界观',
  outline: '详细大纲',
};

/**
 * 将一整份 markdown 文档拆分为卡片数组。
 * 按 `##` 标题切片，每个 section 成一张卡。
 * 卡片正文 = `## 标题` + fullRawMd（fullRawMd 本身不含标题行）。
 */
export function splitMarkdownToCards(md: string, docType: DocType): SplitResult {
  if (!md || !md.trim()) return { docTitle: '', cards: [] };

  const parsed = parseSections(md);
  const docTitle = parsed.title || '';

  const cards: SplitCard[] = parsed.sections.map((s) => ({
    title: s.title,
    content: s.fullRawMd ? `## ${s.title}\n\n${s.fullRawMd}` : `## ${s.title}`,
    fileName: cardFileName(s.title, docType),
  }));

  return { docTitle, cards };
}

/**
 * 从 section 标题生成卡片文件名。
 * - outline：提取章号 → `chapters/第N章.md`
 * - concept/world：标题清理 → `标题.md`
 */
function cardFileName(title: string, docType: DocType): string {
  if (docType === 'outline') {
    const m = title.match(/第\s*(\d+)\s*章/);
    if (m) return `chapters/第${m[1]}章.md`;
    return `chapters/${sanitizeFileName(title)}.md`;
  }
  return `${sanitizeFileName(title)}.md`;
}

/**
 * 清理文件名：去掉路径分隔符和文件系统特殊字符。
 * 保留中文、字母、数字、冒号（中文标题常用）。
 */
export function sanitizeFileName(title: string): string {
  return title
    .replace(/[\\/]/g, '')
    .replace(/[?？*<>|"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * 构建索引文件内容。
 * @param docType 文档类型
 * @param docTitle 文档标题（含书名号）
 * @param cards 全部卡片
 * @param actBreaks 仅 outline：`[第一幕末章号, 第二幕末章号]`
 */
export function buildIndexMarkdown(
  docType: DocType,
  docTitle: string,
  cards: SplitCard[],
  actBreaks?: [number, number],
): string {
  if (docType === 'outline') {
    return buildOutlineIndex(docTitle, cards, actBreaks);
  }
  return buildSimpleIndex(docType, docTitle, cards);
}

/** concept/world 索引：标题 + 摘要 + 文件路径表。 */
function buildSimpleIndex(docType: DocType, docTitle: string, cards: SplitCard[]): string {
  const label = DOC_LABEL[docType];
  const lines: string[] = [
    `# ${label}索引：${docTitle}`,
    '',
    `> 每个${docType === 'concept' ? '要素' : '节'}独立存放在目录下，用 Read 工具按需读取单张卡。`,
    '',
    '| 标题 | 摘要 | 文件 |',
    '|---|---|---|',
  ];

  for (const card of cards) {
    const summary = extractSummary(card.content, 60);
    lines.push(`| ${card.title} | ${summary} | ${card.fileName} |`);
  }

  return `${lines.join('\n')}\n`;
}

/** outline 索引：三幕结构表 + 章节表。 */
function buildOutlineIndex(
  docTitle: string,
  cards: SplitCard[],
  actBreaks?: [number, number],
): string {
  const lines: string[] = [
    `# 详细大纲索引：${docTitle}`,
    '',
    '> 每章独立文件位于 chapters/第N章.md，用 Read 工具按需读取单章大纲。',
    '',
  ];

  // 三幕结构
  if (actBreaks && cards.length > 0) {
    const [act1End, act2End] = actBreaks;
    const total = cards.length;
    lines.push('## 三幕结构', '', '| 幕 | 章节范围 |', '|---|---|');
    lines.push(`| 第一幕·设置 | 第1–${act1End}章 |`);
    if (act2End > act1End) {
      lines.push(`| 第二幕·对抗 | 第${act1End + 1}–${act2End}章 |`);
    }
    lines.push(`| 第三幕·解决 | 第${act2End + 1}–${total}章 |`);
    lines.push('');
  }

  // 章节索引
  lines.push('## 章节索引', '', '| 章 | 标题 | 文件 |', '|---|---|---|');

  for (const card of cards) {
    const chapterNum = card.fileName.match(/第(\d+)章/)?.[1] ?? '?';
    const shortTitle = card.title
      .replace(/第\s*\d+\s*章[：:]?\s*/, '')
      .split('｜')[0]
      .trim();
    lines.push(`| ${chapterNum} | ${shortTitle} | ${card.fileName} |`);
  }

  return `${lines.join('\n')}\n`;
}

/** 从卡片内容提取摘要：跳过标题行，取首段文本截断。 */
function extractSummary(content: string, maxChars: number): string {
  const lines = content.split('\n').filter((l) => !l.startsWith('#') && l.trim());
  const text = lines.join(' ').trim();
  if (!text) return '—';
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}
