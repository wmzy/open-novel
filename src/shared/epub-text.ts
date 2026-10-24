/**
 * EPUB → 纯文本（用于「导入手稿」）。
 *
 * EPUB 本质是 ZIP：
 * 1. META-INF/container.xml 指向 OPF（package document）
 * 2. OPF 的 manifest + spine 定义阅读顺序
 * 3. 按 spine 顺序把 XHTML 去标签拼接为纯文本
 *
 * 不引入 XML 解析器：EPUB 的 container/OPF 结构简单且稳定，正则足以覆盖
 * （属性顺序、单双引号、命名空间前缀均兼容）。解压使用 fflate（零依赖、同步）。
 * 有意不做图片/样式提取——章节切分只需要文字。
 */

import { unzipSync, type Unzipped } from 'fflate';

export interface EpubTextResult {
  text: string;
  title?: string;
  warnings: string[];
}

/** 单文件解压上限：防止异常 epub 内的超大 XHTML 占满内存。 */
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
/** 本次解压的累计上限（只统计文本类条目）。 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

function unzipTextEntries(
  bytes: Uint8Array,
  shouldInclude: (name: string) => boolean,
): Unzipped {
  let total = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      const name = normalizeEntryName(file.name);
      if (!shouldInclude(name)) return false;
      if (typeof file.originalSize === 'number' && file.originalSize > MAX_ENTRY_BYTES) return false;
      total += file.originalSize ?? 0;
      return total <= MAX_TOTAL_BYTES;
    },
  });
}

function decodeXmlBytes(bytes: Uint8Array): string {
  // 先处理 UTF-16 BOM（EPUB 规范允许）
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    }
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  // 极少数 GBK 编码的盗版/自制 epub：UTF-8 解码出现大量替换符时回退
  const replacementRatio = (text.match(/\uFFFD/g) || []).length / Math.max(1, text.length);
  if (replacementRatio > 0.01) {
    try {
      return new TextDecoder('gb18030').decode(bytes);
    } catch {
      return text;
    }
  }
  return text;
}

function getAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = tag.match(re);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  copy: '©',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = parseInt(hex, 16);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      } catch {
        return '';
      }
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = parseInt(dec, 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : '';
      } catch {
        return '';
      }
    })
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * XHTML/HTML → 纯文本（保留段落换行）。
 * markdownHeadings=true 时把 h1/h2 转成 Markdown 标题（# / ##），让切章器能识别
 * 没有「第N章」标记、仅靠标题层级分章的 EPUB。
 */
export function htmlToPlainText(
  html: string,
  opts: { markdownHeadings?: boolean } = {},
): string {
  let text = html
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<rt\b[\s\S]*?<\/rt>/gi, '')
    .replace(/<rp\b[\s\S]*?<\/rp>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  if (opts.markdownHeadings) {
    text = text
      .replace(/<h1\b[^>]*>/gi, '\n\n# ')
      .replace(/<h2\b[^>]*>/gi, '\n\n## ')
      .replace(/<h[3-6]\b[^>]*>/gi, '\n\n');
  }

  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre|table|figcaption)\s*>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '');

  text = decodeEntities(text);

  return text
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function resolveRelative(baseDir: string, href: string): string | null {
  const clean = href.split('#')[0].split('?')[0].trim();
  if (!clean) return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch { /* 保留原样 */ }
  const joined = decoded.startsWith('/')
    ? decoded.replace(/^\/+/, '')
    : baseDir
      ? `${baseDir}/${decoded}`
      : decoded;
  const normalized = joined.split('/').reduce<string[]>((parts, part) => {
    if (!part || part === '.') return parts;
    if (part === '..') {
      parts.pop();
      return parts;
    }
    parts.push(part);
    return parts;
  }, []);
  return normalized.length > 0 ? normalized.join('/') : null;
}

function dirname(name: string): string {
  const idx = name.lastIndexOf('/');
  return idx === -1 ? '' : name.slice(0, idx);
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

/**
 * 从 EPUB 字节中提取 spine 顺序的纯文本。
 * 找不到 container/OPF/spine 时尽量降级（按文件名排序的 XHTML），并给出 warning。
 */
export function extractEpubText(bytes: Uint8Array): EpubTextResult {
  if (bytes.length === 0) throw new Error('EPUB 文件为空');
  const warnings: string[] = [];

  let container: Unzipped;
  try {
    container = unzipTextEntries(bytes, (name) => name.toLowerCase() === 'meta-inf/container.xml');
  } catch {
    throw new Error('EPUB 解压失败：文件可能损坏或受 DRM 保护');
  }
  const containerKey = Object.keys(container).find((k) => k.toLowerCase() === 'meta-inf/container.xml');
  const containerXml = containerKey ? decodeXmlBytes(container[containerKey]) : '';
  const rootfileMatch = containerXml.match(/<rootfile\b[^>]*>/i);
  const opfPath = rootfileMatch ? getAttr(rootfileMatch[0], 'full-path') : null;

  let entries: Unzipped;
  try {
    entries = unzipTextEntries(
      bytes,
      (name) => /\.(x?html?|xml|opf)$/i.test(name),
    );
  } catch {
    throw new Error('EPUB 解压失败：文件可能损坏或受 DRM 保护');
  }

  if (!opfPath && !containerXml) {
    warnings.push('EPUB 缺少 META-INF/container.xml，已按文件名顺序读取 XHTML');
  }

  // 规范化 zip 条目查找（大小写、前导 ./）
  const entryMap = new Map<string, Uint8Array>();
  for (const [key, data] of Object.entries(entries)) {
    entryMap.set(normalizeEntryName(key).toLowerCase(), data);
  }
  const lookup = (p: string): Uint8Array | null =>
    entryMap.get(normalizeEntryName(p).toLowerCase()) ?? null;

  const resolvedOpf = opfPath ? resolveRelative('', opfPath) : null;
  const opfData = resolvedOpf ? lookup(resolvedOpf) : null;
  if (resolvedOpf && !opfData) {
    warnings.push(`EPUB 中找不到 OPF 文件 ${resolvedOpf}，已按文件名顺序读取 XHTML`);
  }

  let title: string | undefined;
  let spinePaths: string[] = [];
  if (opfData) {
    const opf = decodeXmlBytes(opfData);
    const titleMatch = opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)
      || opf.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      const clean = htmlToPlainText(titleMatch[1]).replace(/\s+/g, ' ').trim();
      if (clean) title = clean;
    }

    const manifest = new Map<string, ManifestItem>();
    for (const itemTag of opf.match(/<item\b[^>]*>/gi) ?? []) {
      const id = getAttr(itemTag, 'id');
      const href = getAttr(itemTag, 'href');
      if (!id || !href) continue;
      manifest.set(id, {
        id,
        href,
        mediaType: (getAttr(itemTag, 'media-type') ?? '').toLowerCase(),
        properties: (getAttr(itemTag, 'properties') ?? '').toLowerCase(),
      });
    }

    const opfDir = dirname(resolvedOpf!);
    const spineBlock = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)?.[1] ?? '';
    for (const refTag of spineBlock.match(/<itemref\b[^>]*>/gi) ?? []) {
      const idref = getAttr(refTag, 'idref');
      if (!idref) continue;
      const item = manifest.get(idref);
      if (!item) {
        warnings.push(`EPUB spine 引用了不存在的条目 ${idref}，已跳过`);
        continue;
      }
      // nav 文档是目录页，不参与正文
      if (item.properties.split(/\s+/).includes('nav')) continue;
      if (item.mediaType && !/xhtml|html/.test(item.mediaType)) continue;
      const path = resolveRelative(opfDir, item.href);
      if (path) spinePaths.push(path);
    }

    if (spinePaths.length === 0) {
      warnings.push('EPUB 缺少可读的 spine 顺序，已按文件名顺序读取 XHTML');
      spinePaths = [...manifest.values()]
        .filter((item) => !item.properties.split(/\s+/).includes('nav'))
        .filter((item) => !item.mediaType || /xhtml|html/.test(item.mediaType))
        .map((item) => resolveRelative(opfDir, item.href))
        .filter((p): p is string => Boolean(p))
        .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }));
    }
  } else {
    // 没有 OPF：所有 xhtml/html 按自然顺序
    spinePaths = Object.keys(entries)
      .filter((name) => /\.(x?html?)$/i.test(name))
      .sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }));
  }

  const texts: string[] = [];
  const missing: string[] = [];
  for (const p of spinePaths) {
    const data = lookup(p);
    if (!data) {
      missing.push(p);
      continue;
    }
    const plain = htmlToPlainText(decodeXmlBytes(data), { markdownHeadings: true });
    if (plain) texts.push(plain);
  }
  if (missing.length > 0) {
    warnings.push(`EPUB 中有 ${missing.length} 个 spine 文件缺失或无法读取，已跳过`);
  }
  if (texts.length === 0) {
    throw new Error('EPUB 中未提取到正文文本（可能只有图片或受 DRM 保护）');
  }

  return { text: texts.join('\n\n'), title, warnings };
}

/** 是否为 ZIP（EPUB）魔数。 */
export function isZipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}
