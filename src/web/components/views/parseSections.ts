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
 * 这里把它们解析成结构化数据，供各视图渲染为卡片。仅升级展示层，
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
}

/** 子分组：`### 标题` 块（场景文件中的单个场景）。 */
export interface MdSubsection extends ContentBlock {
  title: string;
}

/** 分组：`## 标题` 块，对应一张卡片。 */
export interface MdSection extends ContentBlock {
  title: string;
  subsections: MdSubsection[];
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

function newBlock<T extends ContentBlock>(base: T): T {
  return base;
}

/**
 * 把 Markdown 文本解析成分组结构。
 *
 * - `#` 作为文档标题（首个）。
 * - `##` 开启一个新分组；其下的列表/段落归入该分组。
 * - `###`（及更深）作为子分组归入当前分组；其下的内容归入子分组。
 * - 空行分隔段落；连续的纯文本行合并为同一段。
 */
export function parseSections(md: string): ParsedDoc {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const sections: MdSection[] = [];
  // 在出现任何 `##` 之前的内容会被丢弃，用一个空块兜底避免 null 检查。
  const sink: ContentBlock = newBlock({ body: [], fields: [], items: [], ordered: [] });

  let docTitle = '';
  let current: MdSection | null = null;
  let currentSub: MdSubsection | null = null;
  let para: string[] = [];

  /** 当前内容归入的目标：优先子分组，其次分组，否则丢弃。 */
  const target = (): ContentBlock => currentSub ?? current ?? sink;

  const flushPara = () => {
    if (para.length === 0) return;
    const text = para.join(' ').trim();
    para = [];
    if (text) target().body.push(text);
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (trimmed === '') {
      flushPara();
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
        currentSub = null;
        current = newBlock({
          title,
          body: [],
          fields: [],
          items: [],
          ordered: [],
          subsections: [],
        });
        sections.push(current);
      } else {
        // level >= 3：作为子分组。若尚无分组则隐式建一个。
        if (!current) {
          current = newBlock({
            title: '',
            body: [],
            fields: [],
            items: [],
            ordered: [],
            subsections: [],
          });
          sections.push(current);
        }
        currentSub = newBlock({ title, body: [], fields: [], items: [], ordered: [] });
        current.subsections.push(currentSub);
      }
      continue;
    }

    const bullet = line.match(BULLET_RE);
    if (bullet) {
      flushPara();
      const content = bullet[1].trim();
      const field = parseField(content);
      const t = target();
      if (field) t.fields.push(field);
      else t.items.push(content);
      continue;
    }

    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      flushPara();
      target().ordered.push(ordered[1].trim());
      continue;
    }

    // 普通段落文本行
    para.push(trimmed);
  }
  flushPara();

  return { title: docTitle, sections };
}
