/**
 * 平台发布文本格式化（起点/番茄/七猫/晋江）。
 *
 * 目标是「复制进平台发布框直接可用」的纯文本：无 markdown 标记、无段首缩进
 * （各平台编辑器自带缩进）、章名独立成行。平台间只有空行策略差异，全部走
 * 规则表（PUBLISH_RULES），新增平台只需加一行配置。
 */

export type PublishTarget = 'qidian' | 'fanqie' | 'qimao' | 'jinjiang';

export interface PublishChapter {
  number: number;
  title: string;
  /** null 表示正文文件缺失（导出占位提示，见 formatChapterForPublish）。 */
  content: string | null;
}

/** 平台格式规则。空行数差异即全部平台差异，其余规则共用。 */
interface PublishFormatRules {
  label: string;
  /** 标题行与正文之间的空行数（fanqie 比其他平台多一个）。 */
  blankAfterTitle: number;
  /** 段落之间的空行数（qimao 为 0：每段紧挨一行）。 */
  blankBetweenParagraphs: number;
}

/** 规则表：依据各平台作者后台/写作助手的通行排版约定整理（无官方规范文档，[假设] 标注处为业界通行做法）。 */
export const PUBLISH_RULES: Record<PublishTarget, PublishFormatRules> = {
  // 起点：章名独立行 + 正文，段落间单空行 [假设：通行约定]
  qidian: { label: '起点', blankAfterTitle: 1, blankBetweenParagraphs: 1 },
  // 番茄：与起点一致但标题行后多一空行 [假设：通行约定]
  fanqie: { label: '番茄', blankAfterTitle: 2, blankBetweenParagraphs: 1 },
  // 七猫：段落间不空行（每段一行） [假设：通行约定]
  qimao: { label: '七猫', blankAfterTitle: 1, blankBetweenParagraphs: 0 },
  // 晋江：与起点一致 [假设：通行约定]
  jinjiang: { label: '晋江', blankAfterTitle: 1, blankBetweenParagraphs: 1 },
};

export const PUBLISH_TARGETS = Object.keys(PUBLISH_RULES) as PublishTarget[];

/** 与 ebook-export 的章名前缀判定保持同一形态（第12章 / 第十二回 / Chapter 3）。 */
const EXISTING_CHAPTER_MARKER =
  /^(?:第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章回节篇卷]|chapter\s+\d+)\s*[:：.、,，\-—]?\s*/i;

/** 发布用章名：无空格的「第N章 标题」（平台目录惯例），标题自带旧编号时先剥掉避免重复。 */
export function publishChapterTitle(number: number, title?: string | null): string {
  const clean = (title ?? '').trim().replace(EXISTING_CHAPTER_MARKER, '').trim();
  return clean ? `第${number}章 ${clean}` : `第${number}章`;
}

const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;

/** 行级 markdown 剥离：标题符/引用符/列表符/围栏标记去掉但保留内容。 */
function stripMarkdownLine(line: string): string {
  let out = line;
  // 围栏代码块边界行（``` / ~~~）整体去掉，内部内容按普通段落保留
  out = out.replace(/^\s*(?:```|~~~).*$/, '');
  // 标题 #、引用 >、有序/无序列表标记
  out = out.replace(/^\s{0,3}#{1,6}\s+/, '');
  out = out.replace(/^\s*>\s?/, '');
  out = out.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '');
  // 行内标记：图片/链接保留文字，粗斜体/删除线/行内码去标记
  out = out.replace(IMAGE_RE, '$1');
  out = out.replace(LINK_RE, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
  out = out.replace(/~~([^~]+)~~/g, '$1');
  out = out.replace(/`([^`]+)`/g, '$1');
  return out;
}

/** markdown 正文 → 段落数组：一行一段（网文写作惯例），去缩进空白与分隔线。 */
function toParagraphs(content: string): string[] {
  return content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => stripMarkdownLine(line))
    .map((line) => line.trim()) // trim 同时去掉段首全角/半角缩进（平台自带缩进）
    .filter((line) => line !== '' && !/^([-*_])(?:\s*\1){2,}$/.test(line)); // 分隔线（含 * * * 空格形态）无平台意义，丢弃
}

/** 按平台空行策略把段落数组拼成文本。 */
function joinParagraphs(paragraphs: string[], blankBetween: number): string {
  const sep = '\n'.repeat(blankBetween + 1);
  return paragraphs.join(sep);
}

/** 单章发布文本：章名行 + 按平台空行策略排版的正文。 */
export function formatChapterForPublish(target: PublishTarget, chapter: PublishChapter): string {
  const rules = PUBLISH_RULES[target];
  const title = publishChapterTitle(chapter.number, chapter.title);
  const paragraphs = chapter.content === null
    ? ['（本章正文文件缺失，导出时未包含）']
    : toParagraphs(chapter.content);
  // 防御：正文自带「第N章 …」标题行时去掉，避免与生成的章名行重复
  // （导出路由通常已剥过；直接调用本模块时仍可能带着）。
  const bareTitle = title.replace(/^第\d+章\s*/, '');
  if (paragraphs[0] === title || (bareTitle !== '' && paragraphs[0] === bareTitle)) {
    paragraphs.shift();
  }
  const body = joinParagraphs(paragraphs, rules.blankBetweenParagraphs);
  // 标题行与正文之间 blankAfterTitle 个空行 = 1 + blankAfterTitle 个换行
  return `${title}\n${'\n'.repeat(rules.blankAfterTitle)}${body}`;
}

/** 全本/多章发布文本：各章按平台空行策略衔接（章节间隔 = 段落间隔策略，保持全文一致）。 */
export function formatForPublish(target: PublishTarget, chapters: PublishChapter[]): string {
  const rules = PUBLISH_RULES[target];
  const chapterSep = '\n'.repeat(rules.blankBetweenParagraphs + 2);
  return chapters.map((ch) => formatChapterForPublish(target, ch)).join(chapterSep);
}
