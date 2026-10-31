/**
 * Markdown ⇄ contentEditable HTML 转换（富文本编辑器用）。
 *
 * 约束：
 *  - 正文的权威格式始终是 Markdown；HTML 只是 contentEditable 的临时载体。
 *  - 绝不渲染 Markdown 里的原始 HTML：marked 的 html token 直接丢弃，
 *    生成的 DOM 再经过白名单清洗（标签/属性均为白名单）。
 *  - 输出稳定（同一 Markdown 总是生成同一 HTML），保证外部同步时不误判改动。
 */
import { marked, Renderer } from 'marked';
import TurndownService from 'turndown';

/** 允许出现在编辑器 DOM 中的标签。 */
const ALLOWED_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'hr',
  'br',
  'a',
]);

/** 这些标签连内容一起丢弃（避免脚本/样式内容泄漏）。 */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript',
  'title',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'textarea',
  'select',
  'button',
  'audio',
  'video',
  'canvas',
]);

/** 浏览器 execCommand / 旧 HTML 产生的等价标签。 */
const TAG_ALIASES: Record<string, string> = {
  b: 'strong',
  i: 'em',
  s: 'del',
  strike: 'del',
};

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'pre', 'hr']);

/** 统一换行符。 */
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 只允许 http(s)/mailto/tel/相对地址；拒绝 javascript:/data: 等危险协议。 */
function sanitizeHref(raw: string | null): string | null {
  if (!raw) return null;
  const href = raw.trim();
  if (!href) return null;
  // 去掉控制字符与空白后再判断协议，防止 "java\nscript:" 之类的绕过。
  // eslint-disable-next-line no-control-regex -- 必须匹配控制字符才能防协议绕过
  const probe = href.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (/^(javascript|data|vbscript|file|blob):/.test(probe)) return null;
  return href;
}

function hasBlockChild(element: Element): boolean {
  for (const child of Array.from(element.children)) {
    const tag = child.tagName.toLowerCase();
    if (BLOCK_TAGS.has(TAG_ALIASES[tag] ?? tag) || tag === 'div') return true;
  }
  return false;
}

function appendCleanedChildren(source: Node, target: Node, doc: Document): void {
  for (const child of Array.from(source.childNodes)) {
    const cleaned = cleanNode(child, doc);
    if (cleaned) target.appendChild(cleaned);
  }
}

function wrap(doc: Document, tag: string, content: Node): Element {
  const element = doc.createElement(tag);
  element.appendChild(content);
  return element;
}

function cleanNode(node: Node, doc: Document): Node | null {
  // 文本节点：createTextNode 自动转义，不会产生注入。
  if (node.nodeType === 3) return doc.createTextNode(node.nodeValue ?? '');
  if (node.nodeType !== 1) return null;

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROP_WITH_CONTENT.has(tag)) return null;

  // span/font 常见于 execCommand 与粘贴；按内联样式还原语义后丢弃包装。
  if (tag === 'span' || tag === 'font') {
    let content: Node = doc.createDocumentFragment();
    appendCleanedChildren(element, content, doc);
    const style = (element.getAttribute('style') ?? '').toLowerCase();
    const bold = /font-weight\s*:\s*(bold|[6-9]00)/.test(style);
    const italic = /font-style\s*:\s*italic/.test(style);
    if (italic) content = wrap(doc, 'em', content);
    if (bold) content = wrap(doc, 'strong', content);
    return content;
  }

  // div 是 contentEditable 回车产生的默认块：有块级子节点时拆包，否则视为段落。
  if (tag === 'div') {
    if (hasBlockChild(element)) {
      const fragment = doc.createDocumentFragment();
      appendCleanedChildren(element, fragment, doc);
      return fragment;
    }
    const paragraph = doc.createElement('p');
    appendCleanedChildren(element, paragraph, doc);
    return paragraph;
  }

  const mapped = TAG_ALIASES[tag] ?? tag;
  if (!ALLOWED_TAGS.has(mapped)) {
    // 未知的行内/块级标签：保留文字内容，丢掉标签本身。
    const fragment = doc.createDocumentFragment();
    appendCleanedChildren(element, fragment, doc);
    return fragment;
  }

  if (mapped === 'pre') {
    const pre = doc.createElement('pre');
    // 保证 Turndown 能识别为围栏代码块：pre > code。
    const codeChild = Array.from(element.children).find((c) => c.tagName.toLowerCase() === 'code');
    if (codeChild) {
      const code = doc.createElement('code');
      code.appendChild(doc.createTextNode(codeChild.textContent ?? ''));
      pre.appendChild(code);
    } else {
      const code = doc.createElement('code');
      code.appendChild(doc.createTextNode(element.textContent ?? ''));
      pre.appendChild(code);
    }
    return pre;
  }

  if (mapped === 'a') {
    const href = sanitizeHref(element.getAttribute('href'));
    // 无安全 href 的链接退化为纯文本，避免留下无目标的空 <a>。
    if (!href) {
      const fragment = doc.createDocumentFragment();
      appendCleanedChildren(element, fragment, doc);
      return fragment;
    }
    const anchor = doc.createElement('a');
    anchor.setAttribute('href', href);
    appendCleanedChildren(element, anchor, doc);
    return anchor;
  }

  const clean = doc.createElement(mapped);
  if (mapped === 'ol') {
    const start = Number.parseInt(element.getAttribute('start') ?? '', 10);
    if (Number.isFinite(start) && start > 1) clean.setAttribute('start', String(start));
  }
  appendCleanedChildren(element, clean, doc);
  return clean;
}

/** 去掉仅承载空行的段落与根级 <br>（contentEditable 回车会制造它们）。 */
function pruneEmptyBlocks(root: Element): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 1 && (child as Element).tagName === 'BR') {
      root.removeChild(child);
    }
  }
  for (const paragraph of Array.from(root.querySelectorAll('p'))) {
    if (paragraph.textContent?.trim() === '' && !paragraph.querySelector('hr, pre, ul, ol, blockquote')) {
      paragraph.remove();
    }
  }
}

/**
 * 清洗任意 HTML，仅保留富文本白名单标签与安全属性。
 * 返回稳定的 HTML 字符串（可直接写入 contentEditable）。
 */
export function sanitizeEditorHtml(html: string): string {
  if (!html) return '';
  if (typeof DOMParser === 'undefined') {
    throw new Error('sanitizeEditorHtml 需要 DOM 环境（DOMParser）');
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.createElement('div');
  appendCleanedChildren(doc.body, root, doc);
  pruneEmptyBlocks(root);
  return root.innerHTML;
}

function createRenderer(): Renderer {
  const renderer = new Renderer();
  // 原始 HTML 一律丢弃（绝不把 Markdown 里的 HTML 渲进编辑器）。
  renderer.html = () => '';
  // 图片不是富文本模式支持的标签：退化为 alt 文本，避免信息彻底消失。
  renderer.image = ({ text }) => escapeHtml(text ?? '');
  return renderer;
}

/** Markdown → 清洗后的 contentEditable HTML。空输入返回空串。 */
export function markdownToEditorHtml(markdown: string): string {
  const source = normalizeNewlines(markdown);
  if (!source.trim()) return '';
  const html = marked.parse(source, {
    gfm: true,
    async: false,
    renderer: createRenderer(),
  });
  return sanitizeEditorHtml(html);
}

/** 合并多余空行、去掉行尾空白与首尾空行，得到稳定 Markdown。 */
function normalizeMarkdown(markdown: string): string {
  return normalizeNewlines(markdown)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let turndownService: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndownService) return turndownService;

  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '***',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    // 行内硬换行用反斜杠，避免与「去行尾空格」规范化冲突。
    br: '\\',
  });

  // Turndown 默认没有删除线规则。清洗阶段已把 <strike>/<s> 归一为 <del>，
  // 这里只需匹配 del/s（turndown 的 filter 只接受 HTMLElementTagNameMap 的键）。
  service.addRule('strikethrough', {
    filter: ['del', 's'],
    replacement: (content) => (content.trim() ? `~~${content}~~` : ''),
  });

  // 默认列表缩进是 3 个空格（`-   item`）；改为单空格，输出更干净且往返稳定。
  service.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement | null;
      const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
      let prefix = '- ';
      if (parent && parent.nodeName === 'OL') {
        const start = Number.parseInt(parent.getAttribute('start') ?? '', 10);
        prefix = `${Number.isFinite(start) ? start + index : index + 1}. `;
      }
      const text = content.replace(/^\n+/, '').replace(/\n+$/, '');
      const indented = text.replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
      return prefix + indented + (node.nextSibling ? '\n' : '');
    },
  });

  turndownService = service;
  return service;
}

/** 清洗后的 contentEditable HTML → 稳定 Markdown。 */
export function editorHtmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return '';
  const clean = sanitizeEditorHtml(html);
  if (!clean.trim()) return '';
  return normalizeMarkdown(getTurndown().turndown(clean));
}
