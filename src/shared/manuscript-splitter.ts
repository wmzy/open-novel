/**
 * 书稿导入切章（纯函数，无文件系统副作用）。
 *
 * 支持：
 * - 中文章节标题：第N章/回/节/篇/卷（N 支持阿拉伯数字、全角数字、中文数字「一百零五」）
 * - 英文章节标题：Chapter N
 * - Markdown 标题：# / ##（仅在没有更强的章节标记时启用）
 * - 数字标题：1. 标题 / 1、标题（需 ≥2 次命中，避免正文有序列表误判）
 * - 无任何标题时按段落贪心切分为固定大小（带 warning）
 *
 * 编码：UTF-8（含 BOM）优先，失败回退 GB18030（兼容 GBK 书稿）。
 *
 * 输出章节号始终从 1 连续编号（文件命名用），`title` 为去掉章节编号后的
 * 可编辑标题；`heading` 保留原始标题行供预览核对。
 */


export type ManuscriptEncoding = 'utf-8' | 'gb18030';
export type SplitMode = 'headings' | 'markdown' | 'numeric' | 'fixed';

export interface ManuscriptChapter {
  /** 1-based 连续章号（与导入后的文件名一致）。 */
  number: number;
  /** 去掉「第N章 / Chapter N / 1.」前缀后的标题，可由用户改写。 */
  title: string;
  /** 原始标题行（无标题的固定切分为空串）。 */
  heading: string;
  /** 正文（不含标题行）。 */
  content: string;
}

export interface ManuscriptChapterPreview {
  number: number;
  title: string;
  heading: string;
  /** 与写作视图一致的「字数」：有 CJK 时按 CJK 字符数，否则按空白分词数。 */
  charCount: number;
  /** 正文前 80 个非空白字符（换行折叠为空格）。 */
  preview: string;
}

export interface SplitManuscriptOptions {
  /** 无标题降级切分的单章目标长度（字符数），默认 6000。 */
  fallbackChunkChars?: number;
  /** 最大章节数上限，防止异常文本产生海量文件，默认 2000。 */
  maxChapters?: number;
}

export interface SplitManuscriptResult {
  chapters: ManuscriptChapter[];
  preview: ManuscriptChapterPreview[];
  mode: SplitMode;
  warnings: string[];
  sourceChars: number;
}

export const DEFAULT_FALLBACK_CHUNK_CHARS = 6000;
export const DEFAULT_MAX_CHAPTERS = 2000;
export const PREVIEW_TEXT_LENGTH = 80;

/** 中文数字 / 阿拉伯数字 / 全角数字字符集。 */
const CN_NUM = '0-9０-９零〇一二三四五六七八九十百千万两';
/** 章节量词。 */
const CN_UNIT = '章回节篇卷';

/** 去掉 BOM（字符串输入也可能带）。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解码书稿字节。UTF-8 严格解码失败时回退 GB18030（GBK 超集）。
 * 返回的 text 已去除 BOM、统一换行符。
 */
export function decodeManuscriptBytes(bytes: Uint8Array): {
  text: string;
  encoding: ManuscriptEncoding;
  warning?: string;
} {
  let text: string;
  let encoding: ManuscriptEncoding = 'utf-8';
  let warning: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      text = new TextDecoder('gb18030').decode(bytes);
      encoding = 'gb18030';
      warning = '检测到非 UTF-8 编码的书稿，已按 GB18030（兼容 GBK）读取，请核对乱码章节';
    } catch {
      throw new Error('无法识别书稿编码：既不是 UTF-8 也不是 GB18030/GBK');
    }
    if (text.includes('\uFFFD')) {
      throw new Error('无法识别书稿编码：请转换为 UTF-8 后重试');
    }
  }
  return { text: normalizeNewlines(stripBom(text)), encoding, warning };
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** 与章节词数统计保持一致：CJK 优先，否则按空白分词。 */
export function countManuscriptChars(content: string): number {
  const stripped = content.replace(/^[#*>\-[\]()!|]+\s*/gm, '').trim();
  if (!stripped) return 0;
  const cjk = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (cjk > 0) return cjk;
  return stripped.split(/\s+/).filter(Boolean).length;
}

/** 前 N 个非空白字符，换行/连续空白折叠为单个空格。 */
export function makePreviewText(content: string, length = PREVIEW_TEXT_LENGTH): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, length);
}

/** 规范化标题行：去掉 markdown 前缀、折叠空白。 */
function normalizeHeading(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, '')
    .replace(/\s+#{1,6}\s*$/, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim();
}

interface DetectedHeading {
  kind: 'headings' | 'markdown' | 'numeric';
  /** 去掉编号后的标题；可能为空串。 */
  title: string;
  /** 原始标题行（已去掉 markdown 前缀）。 */
  heading: string;
}

/**
 * 强章节标记：行首（可带 markdown #）的「第N章/回/节/篇/卷」或「Chapter N」。
 * 标题行长度限制 120 字，避免把正文里以「第一章」开头的长句误判为标题。
 */
function matchStrongHeading(line: string): DetectedHeading | null {
  const raw = line.trim();
  if (!raw || raw.length > 120) return null;
  const heading = normalizeHeading(raw);

  const cn = heading.match(
    new RegExp(`^第\\s*([${CN_NUM}]+)\\s*[${CN_UNIT}](?:[\\s、,，.．:：\\-—_]*)(.*)$`),
  );
  if (cn) {
    return { kind: 'headings', title: (cn[2] || '').trim(), heading };
  }

  const en = heading.match(/^chapter\s+(\d+)(?:[\s、,，.．:：\-—_]*)(.*)$/i);
  if (en) {
    return { kind: 'headings', title: (en[2] || '').trim(), heading };
  }

  return null;
}

/** Markdown 标题（仅 # 与 ##），返回层级与标题文本。 */
function matchMarkdownHeading(line: string): { level: 1 | 2; title: string } | null {
  const m = line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
  if (!m) return null;
  const title = m[2].trim();
  if (!title) return null;
  return { level: m[1].length as 1 | 2, title };
}

/** 数字标题：1. 标题 / 1、标题（要求行较短，避免正文列表误判）。 */
function matchNumericHeading(line: string): DetectedHeading | null {
  const raw = line.trim();
  if (!raw || raw.length > 100) return null;
  const m = raw.match(/^(\d{1,4})\s*[.、,，．]\s*(.+)$/);
  if (!m) return null;
  return { kind: 'numeric', title: m[2].trim(), heading: raw };
}

/** 按行扫描，收集指定检测方式命中的标题行下标。 */
function collectHeadings(
  lines: string[],
  matcher: (line: string) => DetectedHeading | { level: 1 | 2; title: string } | null,
): Array<{ index: number; heading: DetectedHeading }> {
  const result: Array<{ index: number; heading: DetectedHeading }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = matcher(line);
    if (!match) continue;
    if ('level' in match) {
      result.push({
        index: i,
        heading: { kind: 'markdown', title: match.title, heading: match.title },
      });
    } else {
      result.push({ index: i, heading: match });
    }
  }
  return result;
}

/** 把相邻标题行切成分段；首个标题之前的内容并入第 1 章正文。 */
function buildChaptersFromHeadings(
  lines: string[],
  headings: Array<{ index: number; heading: DetectedHeading }>,
  warnings: string[],
): ManuscriptChapter[] {
  const chapters: ManuscriptChapter[] = [];
  for (let i = 0; i < headings.length; i++) {
    const { index, heading } = headings[i];
    const end = i + 1 < headings.length ? headings[i + 1].index : lines.length;
    let content = lines.slice(index + 1, end).join('\n').trim();
    if (i === 0 && index > 0) {
      const preface = lines.slice(0, index).join('\n').trim();
      if (preface) {
        content = `${preface}\n\n${content}`.trim();
        warnings.push(`章节标题前有 ${preface.length} 字前言，已并入第 1 章`);
      }
    }
    chapters.push({
      number: chapters.length + 1,
      title: heading.title,
      heading: heading.heading,
      content,
    });
  }
  return chapters;
}

/** 按段落贪心切分固定大小的章节。 */
function splitFixed(text: string, targetChars: number): string[] {
  const normalized = normalizeNewlines(text).trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const paragraph of paragraphs) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length > targetChars) {
      flush();
      for (let offset = 0; offset < p.length; offset += targetChars) {
        chunks.push(p.slice(offset, offset + targetChars));
      }
      continue;
    }
    if (current && current.length + p.length + 2 > targetChars) flush();
    current = current ? `${current}\n\n${p}` : p;
  }
  flush();

  // 尾章过短（<25%）并入上一章，避免出现几百字的碎片章
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    if (last.length < targetChars * 0.25) {
      chunks[chunks.length - 2] = `${chunks[chunks.length - 2]}\n\n${last}`;
      chunks.pop();
    }
  }
  return chunks;
}

/**
 * 切分书稿纯文本。
 * @throws 当文本为空、或超出章节数上限且无法降级时抛出。
 */
export function splitManuscript(
  rawText: string,
  opts: SplitManuscriptOptions = {},
): SplitManuscriptResult {
  const text = normalizeNewlines(stripBom(rawText)).trim();
  if (!text) throw new Error('书稿内容为空');
  const maxChapters = Math.max(1, opts.maxChapters ?? DEFAULT_MAX_CHAPTERS);
  const fallbackTarget = Math.max(500, opts.fallbackChunkChars ?? DEFAULT_FALLBACK_CHUNK_CHARS);
  const warnings: string[] = [];

  const lines = text.split('\n');

  // 1) 强章节标记（中文章回节 / Chapter N）
  let headings: Array<{ index: number; heading: DetectedHeading }> = [];
  // 每一行最多命中一个 matcher；strong 优先
  const strong = collectHeadings(lines, (line) => {
    const strongMatch = matchStrongHeading(line);
    if (strongMatch) return strongMatch;
    return matchMarkdownHeading(line);
  });
  // collectHeadings 把 markdown 命中标为 markdown，这里按 kind 拆分
  const strongOnly = strong.filter((h) => h.heading.kind === 'headings');
  if (strongOnly.length > 0) {
    headings = strongOnly;
  }

  let mode: SplitMode = 'headings';

  // 2) 没有强标记时，按 markdown 标题层级选择
  if (headings.length === 0) {
    const mdHeadings = strong.filter((h) => h.heading.kind === 'markdown');
    const h1 = mdHeadings.filter((h) => lines[h.index].match(/^#{1}\s/));
    const h2 = mdHeadings.filter((h) => lines[h.index].match(/^#{2}\s/));
    if (h1.length >= 2) {
      headings = h1;
      mode = 'markdown';
    } else if (h1.length === 1 && h2.length === 0) {
      headings = h1;
      mode = 'markdown';
    } else if (h2.length >= 2) {
      headings = h2;
      mode = 'markdown';
    }
  }

  // 3) 数字标题（≥2 次命中才可信）
  if (headings.length === 0) {
    const numeric = collectHeadings(lines, matchNumericHeading);
    if (numeric.length >= 2) {
      headings = numeric;
      mode = 'numeric';
    }
  }

  if (headings.length > 0) {
    if (headings.length > maxChapters) {
      warnings.push(`检测到 ${headings.length} 个章节标题，超过上限 ${maxChapters}，已改为按字数切分`);
      return fixedResult(text, fallbackTarget, maxChapters, warnings, text.length);
    }
    let chapters = buildChaptersFromHeadings(lines, headings, warnings);

    // 空正文章节（只有标题）没有导入价值，丢弃并提示，避免写出空文件。
    const emptyCount = chapters.filter((c) => !c.content).length;
    if (emptyCount > 0) {
      warnings.push(`有 ${emptyCount} 个章节只有标题没有正文，已跳过`);
      chapters = chapters.filter((c) => c.content);
    }
    if (chapters.length === 0) {
      // 全是空标题：退化为整篇固定切分
      return fixedResult(text, fallbackTarget, maxChapters, warnings, text.length);
    }
    chapters = chapters.map((c, i) => ({ ...c, number: i + 1 }));
    return {
      chapters,
      preview: buildPreview(chapters),
      mode,
      warnings,
      sourceChars: text.length,
    };
  }

  // 4) 无标题降级
  return fixedResult(text, fallbackTarget, maxChapters, warnings, text.length, true);
}

function fixedResult(
  text: string,
  target: number,
  maxChapters: number,
  warnings: string[],
  sourceChars: number,
  noHeading = false,
): SplitManuscriptResult {
  // 按最大章数反推目标长度，保证大文件不会生成海量章节
  const effectiveTarget = Math.max(target, Math.ceil(text.length / maxChapters));
  const chunks = splitFixed(text, effectiveTarget);
  if (chunks.length === 0) throw new Error('书稿内容为空');
  const chapters: ManuscriptChapter[] = chunks.map((content, i) => ({
    number: i + 1,
    title: '',
    heading: '',
    content,
  }));
  if (noHeading) {
    warnings.push(
      chapters.length === 1
        ? '未识别到章节标题，已作为单章导入，请在预览中手动拆分'
        : `未识别到章节标题，已按每节约 ${effectiveTarget} 字自动切分为 ${chapters.length} 章，请检查边界`,
    );
  }
  return {
    chapters,
    preview: buildPreview(chapters),
    mode: 'fixed',
    warnings,
    sourceChars,
  };
}

function buildPreview(chapters: ManuscriptChapter[]): ManuscriptChapterPreview[] {
  return chapters.map((c) => ({
    number: c.number,
    title: c.title,
    heading: c.heading,
    charCount: countManuscriptChars(c.content),
    preview: makePreviewText(c.content),
  }));
}
