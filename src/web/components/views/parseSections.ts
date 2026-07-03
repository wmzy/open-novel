/**
 * 分段 Markdown 解析器
 *
 * open-novel 的各阶段文件（concept.md / world-building.md / characters/profiles.md /
 * outline-detailed.md / scenes.md）都遵循同一套规律结构：
 *
 *   # 文档标题
 *
 *   ## 分组标题          ← 一个"卡片"
 *   - 字段：值            ← 字段
 *   1. 编号项             ← 有序列表
 *   自由段落文本          ← 段落
 *
 *   ### 子分组标题        ← 场景文件用到的子卡片
 *   - 字段：值
 *
 * 这里把它们解析成结构化数据，供各视图渲染为卡片。同时保留每段的原始 Markdown
 * （`rawMd` / `fullRawMd`），供 Markdown 渲染模式使用。仅升级展示层，
 * 不改变磁盘上的 Markdown 存储格式。
 */

/** 字段：`- 标签：值` 形式的列表项。 */
export interface MdField {
  key: string;
  value: string;
}

/** 一段内容（分组或子分组共用的可渲染内容集合）。 */
interface ContentBlock {
  /** 直接属于本块的段落文本（每段一个元素）。 */
  body: string[];
  /** `- 标签：值` 形式的字段。 */
  fields: MdField[];
  /** 无冒号或冒号前过长的普通列表项。 */
  items: string[];
  /** 有序列表（`1.` / `1)` / `1、`）项。 */
  ordered: string[];
  /** 本块直接内容的原始 Markdown（不含标题行，不含子分组）。 */
  rawMd: string;
}

/** 子分组：`### 标题` 块（场景文件中的单个场景）。 */
export interface MdSubsection extends ContentBlock {
  title: string;
}

/** 分组：`## 标题` 块，对应一张卡片。 */
export interface MdSection extends ContentBlock {
  title: string;
  subsections: MdSubsection[];
  /** 完整 Markdown（含子分组标题与内容），供整段渲染使用。 */
  fullRawMd: string;
}

/** 解析后的文档：标题 + 一组分组。 */
export interface ParsedDoc {
  title: string;
  sections: MdSection[];
}

/** 字段标签的最大字符数：超过则视为普通文本而非 `标签：值`。 */
const MAX_FIELD_KEY_LEN = 8;

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+(?:[.)][ \t]+|、[ \t]*)(.*)$/;
// 字段：标签（不含全角/半角冒号）+ 冒号 + 值
const FIELD_RE = /^([^：:]+)[：:](.*)$/;

/** 尝试把一行列表内容解析为字段；不是字段则返回 null。 */
export function parseField(content: string): MdField | null {
  const m = content.match(FIELD_RE);
  if (!m) return null;
  const key = m[1].trim();
  const value = m[2].trim();
  if (key.length === 0 || key.length > MAX_FIELD_KEY_LEN) return null;
  return { key, value };
}

/** 模板占位符检测：`{...}`、`未填写`、`{世界的物理环境描述}` 这类初始模板内容应视为未填写。 */
const PLACEHOLDER_RE = /^\{[^}]*\}$/;
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (PLACEHOLDER_RE.test(v)) return true;
  if (v === '未填写') return true;
  return false;
}

/** 规整标题：去掉行尾的 ATX 闭合 `#`。 */
function cleanTitle(raw: string): string {
  return raw.replace(/\s*#+\s*$/, '').trim();
}

/**
 * 把 Markdown 文本解析成分组结构。
 *
 * - `#` 作为文档标题（首个）。
 * - `##` 开启一个新分组；其下的列表/段落归入该分组。
 * - `###`（及更深）作为子分组归入当前分组；其下的内容归入子分组。
 * - 空行分隔段落；连续的纯文本行合并为同一段。
 * - `rawMd` 保留每块直接内容的原始 Markdown；`fullRawMd` 含子分组完整内容。
 */
export function parseSections(md: string): ParsedDoc {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections: MdSection[] = [];

  let docTitle = '';
  let current: MdSection | null = null;
  let currentSub: MdSubsection | null = null;
  let para: string[] = [];

  // 原始 Markdown 行追踪
  let sectionRaw: string[] = [];
  let subRaw: string[] = [];

  /** 当前内容归入的目标：优先子分组，其次分组。 */
  const target = (): ContentBlock | null => currentSub ?? current;

  const flushPara = () => {
    if (para.length === 0) return;
    const text = para.join(' ').trim();
    para = [];
    if (text) target()?.body.push(text);
  };

  /** 把当前子分组的 subRaw 存入其 rawMd。 */
  const finalizeSub = () => {
    if (currentSub) {
      currentSub.rawMd = subRaw.join('\n').trim();
    }
    subRaw = [];
  };

  /** 把当前分组的 sectionRaw 存入其 rawMd 和 fullRawMd。 */
  const finalizeSection = () => {
    finalizeSub();
    if (current) {
      const direct = sectionRaw.join('\n').trim();
      current.rawMd = direct;
      const parts: string[] = [];
      if (direct) parts.push(direct);
      for (const sub of current.subsections) {
        const subContent = sub.rawMd.trim();
        if (subContent) parts.push(`### ${sub.title}\n${subContent}`);
        else parts.push(`### ${sub.title}`);
      }
      current.fullRawMd = parts.join('\n\n');
    }
    sectionRaw = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (trimmed === '') {
      flushPara();
      // 空行保留到原始 Markdown（段落分隔用）
      if (currentSub) subRaw.push('');
      else if (current) sectionRaw.push('');
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      const title = cleanTitle(heading[2]);
      if (level === 1) {
        if (!docTitle) docTitle = title;
      } else if (level === 2) {
        finalizeSection();
        currentSub = null;
        current = {
          title,
          body: [],
          fields: [],
          items: [],
          ordered: [],
          subsections: [],
          rawMd: '',
          fullRawMd: '',
        };
        sections.push(current);
      } else {
        // level >= 3：作为子分组。若尚无分组则隐式建一个。
        finalizeSub();
        if (!current) {
          current = {
            title: '',
            body: [],
            fields: [],
            items: [],
            ordered: [],
            subsections: [],
            rawMd: '',
            fullRawMd: '',
          };
          sections.push(current);
        }
        currentSub = {
          title,
          body: [],
          fields: [],
          items: [],
          ordered: [],
          rawMd: '',
        };
        current.subsections.push(currentSub);
      }
      continue;
    }

    // 非标题内容行：先记录到原始 Markdown 缓冲
    if (currentSub) subRaw.push(line);
    else if (current) sectionRaw.push(line);

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      flushPara();
      const content = bullet[1].trim();
      const field = parseField(content);
      const t = target();
      if (t) {
        if (field) t.fields.push(field);
        else t.items.push(content);
      }
      continue;
    }

    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      flushPara();
      target()?.ordered.push(ordered[1].trim());
      continue;
    }

    // 普通段落文本行
    para.push(trimmed);
  }
  flushPara();
  finalizeSection();

  return { title: docTitle, sections };
}
