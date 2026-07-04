/**
 * 章节切分纯函数：检测原文章节边界，标准化为 { number, title, content }。
 * 单文件按章节标记正则切分；目录按文件名排序。
 * 切分失败降级为单章，不报错。
 */

export interface ChunkedChapter {
  number: number; // 1-based
  title: string;
  content: string;
}

export type ChunkSource =
  | { kind: 'file'; content: string; filename: string }
  | { kind: 'dir'; files: { name: string; content: string }[] };

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字字符串转 number，非中文数字返回 null。支持「二十三」「一百零五」。 */
export function chineseToNumber(s: string): number | null {
  if (!s || !/[零一二三四五六七八九十百千万两]/.test(s)) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
    } else if (ch === '十') {
      section += (number || 1) * 10;
      number = 0;
    } else if (ch === '百') {
      section += (number || 1) * 100;
      number = 0;
    } else if (ch === '千') {
      section += (number || 1) * 1000;
      number = 0;
    } else if (ch === '万') {
      section += number * 10000;
      total += section;
      section = 0;
      number = 0;
    }
  }
  const result = total + section + number;
  return result > 0 ? result : null;
}

/** 归一化章号字符串：优先 parseInt，失败尝试中文数字。 */
function normalizeChapterNum(s: string): number | null {
  const n = parseInt(s, 10);
  if (!Number.isNaN(n)) return n;
  return chineseToNumber(s);
}

/** 单文件章节标记（按优先级）。每个捕获组 1 = 章号，组 2 = 可选标题。minMatch 是该模式的最低命中数门槛——强标记（第N章 / Chapter N）单次命中即可信，弱标记（N. 标题）需 ≥2 次以免正文里的有序列表误判。 */
interface ChapterPattern { re: RegExp; minMatch: number }
const CHAPTER_PATTERNS: ChapterPattern[] = [
  { re: /^#{0,3}\s*第\s*([\d一二三四五六七八九十百千两]+)\s*章[\s：:．.]*(.*)$/m, minMatch: 1 },
  { re: /^#{0,3}\s*[Cc]hapter\s+(\d+)[\s：:．.]*(.*)$/m, minMatch: 1 },
  { re: /^#{0,3}\s*(\d+)\s*[.、]\s*(.*)$/m, minMatch: 2 },
];

/** 从单文件内容切分章节。返回 null 表示无匹配标记。 */
function splitFile(content: string): ChunkedChapter[] | null {
  for (const { re, minMatch } of CHAPTER_PATTERNS) {
    const global = new RegExp(re.source, 'gm');
    const matches = [...content.matchAll(global)];
    if (matches.length >= minMatch) {
      const chapters: ChunkedChapter[] = [];
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const num = normalizeChapterNum(m[1]);
        if (num === null) continue;
        const title = (m[2] || '').trim();
        const startIdx = m.index! + m[0].length;
        const endIdx = i + 1 < matches.length ? matches[i + 1].index! : content.length;
        const body = content.slice(startIdx, endIdx).trim();
        chapters.push({ number: num, title: title || `第${num}章`, content: body });
      }
      if (chapters.length >= 1) return chapters;
    }
  }
  return null;
}

/** 文件名自然排序比较器。 */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh', { numeric: true });
}

/** 从文件名提取章号，无数字返回 null。 */
function numFromFilename(name: string): number | null {
  const m = name.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** 从内容首行提取标题（去掉 markdown # 前缀）。 */
function titleFromContent(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim());
  if (!firstLine) return '';
  const m = firstLine.match(/^#{0,3}\s*第[\d一二三四五六七八九十百千两]+章[\s：:．.]*(.*)/);
  return m ? m[1].trim() : firstLine.replace(/^#+\s*/, '').trim();
}

/** 主入口：检测章节边界并标准化。 */
export function detectChapters(source: ChunkSource): ChunkedChapter[] {
  if (source.kind === 'file') {
    const split = splitFile(source.content);
    if (split) return split;
    // 降级为单章
    return [{ number: 1, title: '第1章', content: source.content.trim() }];
  }

  // 目录模式
  const sorted = [...source.files].sort((a, b) => naturalCompare(a.name, b.name));
  const chapters: ChunkedChapter[] = [];
  let fallbackNum = 1;
  for (const f of sorted) {
    // 文件内部可能还有多章标记
    const inner = splitFile(f.content);
    if (inner && inner.length >= 2) {
      chapters.push(...inner);
      continue;
    }
    const num = numFromFilename(f.name) ?? fallbackNum;
    fallbackNum = num + 1;
    chapters.push({
      number: num,
      title: titleFromContent(f.content) || `第${num}章`,
      content: f.content.trim(),
    });
  }
  return chapters;
}
