/**
 * 电子书导出构建器（EPUB 3 / DOCX）。
 *
 * 纯函数、Buffer 级输出，不落临时文件：
 * - EPUB 3：mimetype 首条且不压缩；container.xml + content.opf + nav.xhtml + 每章一个 XHTML。
 * - DOCX：最小 OOXML 包，标题页 + 章节标题（Heading 1）+ 中文首行缩进正文。
 *
 * 章节正文按轻量 Markdown 块解析（标题/段落/引用/列表/分隔线），
 * 输出前统一做 XML 转义，避免正文中的 & < > " ' 破坏文档结构。
 */

import { strToU8, zipSync, unzipSync, strFromU8, type Unzipped, type Zippable } from 'fflate';

export interface EbookChapter {
  number: number;
  title: string;
  /** 章节正文（Markdown）。null 表示正文文件缺失，导出为占位页。 */
  content: string | null;
}

export interface EbookFrontMatter {
  concept?: string;
  world?: string;
  characters?: string;
}

export interface EbookInput {
  /** 稳定标识（project id），用于 dc:identifier。 */
  id: string;
  title: string;
  genre?: string | null;
  theme?: string | null;
  /** BCP 47 语言标签；默认 zh。 */
  language?: string;
  chapters: EbookChapter[];
  /** scope=full 时附带的设定资料。 */
  frontMatter?: EbookFrontMatter;
}

// ── XML 基础工具 ──────────────────────────────────────────────

/** XML 文本转义（同时剔除 XML 1.0 非法控制字符）。 */
export function escapeXml(value: string): string {
  return value
    // XML 1.0 禁止的控制字符：故意保留正则以剔除，非误写。
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attribute(value: string): string {
  return escapeXml(value);
}

// ── Markdown → 块级结构 ───────────────────────────────────────

export type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'hr' };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const FENCE_RE = /^\s*```/;

/** 轻量 Markdown 解析：只覆盖小说正文常见的块级语法，未知语法按段落处理。 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'paragraph', lines: paragraph });
      paragraph = [];
    }
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      blocks.push({ type: 'quote', lines: quote });
      quote = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (const line of lines) {
    // 围栏代码块：保留原样文本（去掉围栏行），避免把内部空行拆散。
    if (fence) {
      if (FENCE_RE.test(line)) {
        blocks.push({ type: 'paragraph', lines: fence });
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (FENCE_RE.test(line)) {
      flushAll();
      fence = [];
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushAll();
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (HR_RE.test(line)) {
      flushAll();
      blocks.push({ type: 'hr' });
      continue;
    }

    const quoted = line.match(QUOTE_RE);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    const item = line.match(LIST_RE);
    if (item) {
      flushParagraph();
      flushQuote();
      const ordered = /^\s*\d/.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[1]);
      continue;
    }

    flushQuote();
    flushList();
    paragraph.push(line);
  }

  // 未闭合的围栏代码块也按段落输出，避免内容丢失。
  if (fence && fence.length > 0) blocks.push({ type: 'paragraph', lines: fence });
  flushAll();
  return blocks;
}

const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;

/** Markdown 行内 → XHTML（先转义，再恢复少量安全标签）。 */
export function inlineToHtml(text: string): string {
  let out = escapeXml(text);
  out = out.replace(IMAGE_RE, '$1');
  out = out.replace(LINK_RE, '$1');
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

/** Markdown 行内 → 纯文本（DOCX 用）。 */
export function inlineToPlain(text: string): string {
  return text
    .replace(IMAGE_RE, '$1')
    .replace(LINK_RE, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1');
}

// ── 章节/结构 ────────────────────────────────────────────────

/** 章标题里已带编号的前缀：第12章 / 第十二回 / Chapter 3。 */
const EXISTING_CHAPTER_MARKER =
  /^(?:第\s*[0-9０-９零〇一二三四五六七八九十百千万两]+\s*[章回节篇卷]|chapter\s+\d+)\s*[:：.、,，\-—]?\s*/i;

/**
 * 导出用的章节标题。
 *
 * 正文文件的 DB 标题可能已经带「第N章」（例如导入手稿保留了原标题），
 * 若直接拼成「第 1 章 第1章 起风」会重复。这里先剥掉旧编号，再按真实章号生成，
 * 保证导出章号与正文顺序一致。
 */
export function exportChapterTitle(number: number, title?: string | null): string {
  const clean = (title ?? '').trim().replace(EXISTING_CHAPTER_MARKER, '').trim();
  return clean ? `第 ${number} 章 ${clean}` : `第 ${number} 章`;
}

/**
 * 去掉正文开头的章节标题行（`# 第N章 标题` / `# 标题`）。
 *
 * 正文文件以标题开头是项目约定；导出时标题由导出器统一生成，保留会导致
 * EPUB/DOCX 里出现「第 1 章 第1章 起风」的两级重复标题。只删第一个非空行，
 * 且必须是 Markdown 标题且看起来像章标题（或与 DB 标题一致），避免误删正文。
 */
export function stripLeadingChapterHeading(content: string, title?: string | null): string {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const index = lines.findIndex((line) => line.trim() !== '');
  if (index === -1) return content;
  const heading = lines[index].trim().match(/^#{1,6}\s+(.+)$/)?.[1]?.trim();
  if (!heading) return content;

  const cleanTitle = (title ?? '').trim();
  const looksLikeChapter = EXISTING_CHAPTER_MARKER.test(heading);
  const sameAsTitle = cleanTitle !== ''
    && (heading === cleanTitle
      || heading === cleanTitle.replace(EXISTING_CHAPTER_MARKER, '').trim()
      || cleanTitle.replace(EXISTING_CHAPTER_MARKER, '').trim() === heading);
  if (!looksLikeChapter && !sameAsTitle) return content;

  lines.splice(index, 1);
  return lines.join('\n').replace(/^\n+/, '');
}

interface EbookSection {
  id: string;
  href: string;
  title: string;
  blocks: MarkdownBlock[];
  /** 正文文件缺失（区别于空章节）。 */
  missing?: boolean;
}

function buildSections(input: EbookInput): EbookSection[] {
  const sections: EbookSection[] = [];
  const front = input.frontMatter;
  if (front) {
    const fronts: Array<[string, string, string | undefined]> = [
      ['front-concept', '故事概念', front.concept],
      ['front-world', '世界观', front.world],
      ['front-characters', '角色', front.characters],
    ];
    for (const [id, title, content] of fronts) {
      if (!content?.trim()) continue;
      sections.push({
        id,
        href: `text/${id}.xhtml`,
        title,
        blocks: parseMarkdownBlocks(content),
      });
    }
  }

  for (const chapter of input.chapters) {
    const title = exportChapterTitle(chapter.number, chapter.title);
    const blocks: MarkdownBlock[] = chapter.content === null
      ? []
      : parseMarkdownBlocks(stripLeadingChapterHeading(chapter.content, chapter.title));
    sections.push({
      id: `chapter-${chapter.number}`,
      href: `text/chapter-${chapter.number}.xhtml`,
      title: chapter.content === null ? `${title} 【章节缺失】` : title,
      blocks,
      missing: chapter.content === null,
    });
  }
  return sections;
}

function blocksToBody(blocks: MarkdownBlock[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(2, block.level + 1));
        return `<h${level}>${inlineToHtml(block.text)}</h${level}>`;
      }
      case 'paragraph':
        return `<p>${block.lines.map(inlineToHtml).join('<br/>')}</p>`;
      case 'quote':
        return `<blockquote><p>${block.lines.map(inlineToHtml).join('<br/>')}</p></blockquote>`;
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul';
        return `<${tag}>${block.items.map((item) => `<li>${inlineToHtml(item)}</li>`).join('')}</${tag}>`;
      }
      case 'hr':
        return '<hr/>';
      default:
        return '';
    }
  }).join('\n');
}

// ── EPUB 3 ──────────────────────────────────────────────────

const EPUB_CSS = `body {
  font-family: serif;
  line-height: 1.8;
  margin: 0 1em;
}
h1 {
  text-align: center;
  font-size: 1.4em;
  margin: 1.5em 0 1em;
  text-indent: 0;
}
h2, h3, h4, h5, h6 {
  text-indent: 0;
  margin: 1em 0 0.5em;
}
p {
  text-indent: 2em;
  margin: 0.35em 0;
  text-align: justify;
}
li p, blockquote p, .missing {
  text-indent: 0;
}
blockquote {
  margin: 0.8em 1.5em;
  color: #444;
}
hr {
  border: 0;
  border-top: 1px solid #999;
  margin: 1em 0;
}
.missing {
  color: #666;
}
`;

function xhtmlDocument(opts: {
  title: string;
  language: string;
  cssHref: string;
  body: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${attribute(opts.language)}" lang="${attribute(opts.language)}">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(opts.title)}</title>
<link rel="stylesheet" type="text/css" href="${attribute(opts.cssHref)}"/>
</head>
<body>
${opts.body}
</body>
</html>
`;
}

function sectionXhtml(section: EbookSection, language: string): string {
  const body = `<h1>${escapeXml(section.title)}</h1>\n${
    section.missing
      ? '<p class="missing">本章正文文件缺失，导出时未包含。</p>'
      : blocksToBody(section.blocks)
  }`;
  return xhtmlDocument({
    title: section.title,
    language,
    cssHref: '../style.css',
    body,
  });
}

function buildNav(sections: EbookSection[], language: string): string {
  const entries = sections
    .map((section) => `<li><a href="${attribute(section.href)}">${escapeXml(section.title)}</a></li>`)
    .join('\n');
  const landmarks = sections.length > 0
    ? `<nav epub:type="landmarks" id="landmarks" hidden="hidden">
<h2>导航</h2>
<ol><li><a epub:type="bodymatter" href="${attribute(sections[0].href)}">正文</a></li></ol>
</nav>`
    : '';
  const body = `<nav epub:type="toc" id="toc">
<h1>目录</h1>
<ol>
${entries}
</ol>
</nav>
${landmarks}`;
  return xhtmlDocument({ title: '目录', language, cssHref: 'style.css', body });
}

function buildContainer(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function buildOpf(input: EbookInput, sections: EbookSection[], language: string): string {
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...sections.map((section) => (
      `<item id="${attribute(section.id)}" href="${attribute(section.href)}" media-type="application/xhtml+xml"/>`
    )),
  ].join('\n    ');
  const spine = sections
    .map((section) => `<itemref idref="${attribute(section.id)}"/>`)
    .join('\n    ');

  const subjects = input.genre ? `\n    <dc:subject>${escapeXml(input.genre)}</dc:subject>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${attribute(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:open-novel:${escapeXml(input.id)}</dc:identifier>
    <dc:title>${escapeXml(input.title)}</dc:title>
    <dc:language>${escapeXml(language)}</dc:language>${subjects}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>
`;
}

/** 生成 EPUB 3 字节。mimetype 为首条且 stored（level 0）。 */
export function buildEpub(input: EbookInput): Uint8Array<ArrayBuffer> {
  const language = input.language || 'zh';
  let sections = buildSections(input);
  // EPUB 3 要求 spine 至少有一个 itemref；空项目也输出合法电子书。
  if (sections.length === 0) {
    sections = [{
      id: 'content',
      href: 'text/content.xhtml',
      title: input.title,
      blocks: [],
    }];
  }

  const files: Zippable = {
    // EPUB 规范：mimetype 必须是 ZIP 第一条且不压缩。
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(buildContainer()),
    'OEBPS/content.opf': strToU8(buildOpf(input, sections, language)),
    'OEBPS/nav.xhtml': strToU8(buildNav(sections, language)),
    'OEBPS/style.css': strToU8(EPUB_CSS),
  };
  for (const section of sections) {
    files[`OEBPS/${section.href}`] = strToU8(sectionXhtml(section, language));
  }
  // fflate 内部新建 ArrayBuffer 支持的 Uint8Array；收窄类型以便 Hono 直接输出字节。
  return zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>;
}

// ── EPUB 结构校验 ────────────────────────────────────────────

export interface EpubValidation {
  ok: boolean;
  errors: string[];
}

/** 读取 ZIP 首条本地文件头的名称与压缩方式（EPUB 规范要求 mimetype stored 居首）。 */
function firstZipEntry(bytes: Uint8Array): { name: string; method: number } | null {
  if (bytes.length < 30) return null;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) return null;
  const method = bytes[8] | (bytes[9] << 8);
  const nameLength = bytes[26] | (bytes[27] << 8);
  if (30 + nameLength > bytes.length) return null;
  return { name: strFromU8(bytes.slice(30, 30 + nameLength)), method };
}

/** 从标签文本取属性值（兼容单/双引号）。校验器不依赖 DOM，纯正则即可覆盖我们生成的简单 XML。 */
function xmlAttr(tag: string, name: string): string | null {
  return tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`))?.[1] ?? null;
}

/** manifest 的 href 是相对 OPF 所在目录的路径，解析 ./ 与 ../ 后映射到 zip 条目名。 */
function resolveZipPath(opfPath: string, href: string): string {
  const parts = opfPath.split('/').slice(0, -1);
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * EPUB 3 包结构校验（通用函数，不依赖 buildEpub 的产物形态）：
 * - ZIP 可解；首条目为 mimetype 且 stored（压缩方式 0），内容为 application/epub+zip；
 * - META-INF/container.xml 存在并声明 OPF full-path，OPF 在包内；
 * - manifest 非空且含 properties="nav" 的导航文档；
 * - spine 的每个 itemref 都能映射到 manifest item，manifest 声明的资源都在包内。
 */
export function validateEpub(buffer: Uint8Array): EpubValidation {
  const errors: string[] = [];

  let zip: Unzipped;
  try {
    zip = unzipSync(buffer);
  } catch (err) {
    return { ok: false, errors: [`ZIP 解析失败: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const first = firstZipEntry(buffer);
  if (!first) {
    errors.push('不是合法 ZIP（缺少本地文件头）');
  } else {
    if (first.name !== 'mimetype') errors.push(`首条 ZIP 条目应为 mimetype，实际为 ${first.name}`);
    if (first.method !== 0) errors.push('mimetype 条目必须 stored（压缩方式 0）');
  }
  const mimetype = zip['mimetype'];
  if (!mimetype) {
    errors.push('缺少 mimetype 条目');
  } else if (strFromU8(mimetype) !== 'application/epub+zip') {
    errors.push('mimetype 内容不是 application/epub+zip');
  }

  const container = zip['META-INF/container.xml'];
  if (!container) {
    errors.push('缺少 META-INF/container.xml');
    return { ok: false, errors };
  }
  const opfPath = strFromU8(container).match(/full-path\s*=\s*["']([^"']+)["']/)?.[1];
  if (!opfPath) {
    errors.push('container.xml 未声明 rootfile full-path（OPF 路径）');
    return { ok: false, errors };
  }
  const opf = zip[opfPath];
  if (!opf) {
    errors.push(`OPF 文件不在包内: ${opfPath}`);
    return { ok: false, errors };
  }

  const opfText = strFromU8(opf);
  const manifest = new Map<string, { href: string; properties: string }>();
  let hasNav = false;
  for (const tag of opfText.match(/<item\b[^>]*>/g) ?? []) {
    const id = xmlAttr(tag, 'id');
    const href = xmlAttr(tag, 'href');
    if (!id || !href) continue;
    const properties = xmlAttr(tag, 'properties') ?? '';
    manifest.set(id, { href, properties });
    if (properties.includes('nav')) hasNav = true;
  }
  if (manifest.size === 0) errors.push('manifest 为空');
  if (!hasNav) errors.push('manifest 缺少 properties="nav" 的导航文档');

  const itemrefs = opfText.match(/<itemref\b[^>]*>/g) ?? [];
  if (itemrefs.length === 0) errors.push('spine 为空（EPUB 3 要求至少一个 itemref）');
  for (const tag of itemrefs) {
    const idref = xmlAttr(tag, 'idref');
    if (idref && !manifest.has(idref)) errors.push(`spine 引用了 manifest 之外的 id: ${idref}`);
  }

  for (const [id, item] of manifest) {
    const entryPath = resolveZipPath(opfPath, item.href);
    if (!zip[entryPath]) errors.push(`manifest 资源不在包内: ${entryPath}（id=${id}）`);
  }

  return { ok: errors.length === 0, errors };
}

// ── DOCX (WordprocessingML) ─────────────────────────────────

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W_NS}">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun" w:cs="SimSun"/>
        <w:sz w:val="24"/>
        <w:szCs w:val="24"/>
        <w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:line="360" w:lineRule="auto"/>
        <w:jc w:val="both"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:ind w:firstLine="480" w:firstLineChars="200"/>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:pageBreakBefore/>
      <w:spacing w:before="240" w:after="240"/>
      <w:ind w:firstLine="0" w:firstLineChars="0"/>
      <w:jc w:val="center"/>
      <w:outlineLvl w:val="0"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:sz w:val="32"/>
      <w:szCs w:val="32"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="200" w:after="120"/>
      <w:ind w:firstLine="0" w:firstLineChars="0"/>
      <w:outlineLvl w:val="1"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:sz w:val="28"/>
      <w:szCs w:val="28"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:spacing w:before="160" w:after="100"/>
      <w:ind w:firstLine="0" w:firstLineChars="0"/>
      <w:outlineLvl w:val="2"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:sz w:val="26"/>
      <w:szCs w:val="26"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Subtitle"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="2400" w:after="240"/>
      <w:ind w:firstLine="0" w:firstLineChars="0"/>
      <w:jc w:val="center"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:sz w:val="52"/>
      <w:szCs w:val="52"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle">
    <w:name w:val="Subtitle"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:before="120" w:after="120"/>
      <w:ind w:firstLine="0" w:firstLineChars="0"/>
      <w:jc w:val="center"/>
    </w:pPr>
    <w:rPr>
      <w:sz w:val="28"/>
      <w:szCs w:val="28"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Quote">
    <w:name w:val="Quote"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:ind w:left="840" w:right="420" w:firstLine="0" w:firstLineChars="0"/>
    </w:pPr>
    <w:rPr>
      <w:i/>
      <w:color w:val="444444"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:ind w:left="420" w:firstLine="0" w:firstLineChars="0"/>
    </w:pPr>
  </w:style>
</w:styles>
`;

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
`;

const DOCX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
`;

const DOCX_DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
`;

function run(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function paragraph(opts: { style?: string; lines?: string[]; extraPPr?: string }): string {
  // 正文段落同时写直接缩进，确保 Word/WPS 与任何只读 document.xml 的工具都能看到首行缩进。
  const extraPPr = opts.extraPPr ?? (opts.style ? '' : '<w:ind w:firstLine="480" w:firstLineChars="200"/>');
  const pPr = opts.style || extraPPr
    ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}${extraPPr}</w:pPr>`
    : '';
  const lines = opts.lines ?? [];
  const runs = lines.map(run).join('<w:r><w:br/></w:r>');
  return `<w:p>${pPr}${runs}</w:p>`;
}

function blocksToDocx(blocks: MarkdownBlock[]): string {
  const paragraphs: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const style = block.level <= 2 ? 'Heading2' : 'Heading3';
        paragraphs.push(paragraph({ style, lines: [inlineToPlain(block.text)] }));
        break;
      }
      case 'paragraph':
        paragraphs.push(paragraph({
          lines: block.lines.map(inlineToPlain).filter((line) => line.length > 0),
        }));
        break;
      case 'quote':
        paragraphs.push(paragraph({
          style: 'Quote',
          lines: block.lines.map(inlineToPlain),
        }));
        break;
      case 'list': {
        const items = block.items.map((item, index) => (
          `${block.ordered ? `${index + 1}.` : '•'} ${inlineToPlain(item)}`
        ));
        for (const item of items) {
          paragraphs.push(paragraph({ style: 'ListParagraph', lines: [item] }));
        }
        break;
      }
      case 'hr':
        paragraphs.push(paragraph({
          extraPPr: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr><w:ind w:firstLine="0" w:firstLineChars="0"/>',
        }));
        break;
      default:
        break;
    }
  }
  return paragraphs.join('\n');
}

function buildDocumentXml(input: EbookInput): string {
  const sections = buildSections(input);
  const parts: string[] = [];

  // 标题页
  parts.push(paragraph({ style: 'Title', lines: [input.title] }));
  if (input.genre) parts.push(paragraph({ style: 'Subtitle', lines: [`类型：${input.genre}`] }));
  if (input.theme) parts.push(paragraph({ style: 'Subtitle', lines: [`主题：${input.theme}`] }));
  parts.push(paragraph({}));

  for (const section of sections) {
    parts.push(paragraph({ style: 'Heading1', lines: [section.title] }));
    if (section.missing) {
      parts.push(paragraph({ style: 'Quote', lines: ['本章正文文件缺失，导出时未包含。'] }));
    } else if (section.blocks.length > 0) {
      parts.push(blocksToDocx(section.blocks));
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}">
  <w:body>
${parts.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>
`;
}

function buildCoreXml(input: EbookInput): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(input.title)}</dc:title>
  <dc:creator>open-novel</dc:creator>
  <cp:lastModifiedBy>open-novel</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>
`;
}

/** 生成 DOCX 字节（最小 OOXML 包）。 */
export function buildDocx(input: EbookInput): Uint8Array<ArrayBuffer> {
  const files: Zippable = {
    '[Content_Types].xml': strToU8(DOCX_CONTENT_TYPES),
    '_rels/.rels': strToU8(DOCX_ROOT_RELS),
    'word/document.xml': strToU8(buildDocumentXml(input)),
    'word/styles.xml': strToU8(DOCX_STYLES),
    'word/_rels/document.xml.rels': strToU8(DOCX_DOCUMENT_RELS),
    'docProps/core.xml': strToU8(buildCoreXml(input)),
    'docProps/app.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>open-novel</Application>
</Properties>
`),
  };
  // fflate 内部新建 ArrayBuffer 支持的 Uint8Array；收窄类型以便 Hono 直接输出字节。
  return zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>;
}
