/**
 * 实体词典构建：从小说档案 markdown 解析出实体名 → EntityRef 映射。
 * 纯函数，无副作用，可独立单测。
 *
 * 实体来源（按文件类型）：
 *  - characters/*.md：角色姓名字段 + 外号字段 + 标题括号
 *  - world-building.md：地理节 ### 子标题（地名）；武功/兵器/门派节标题
 *  - wuxia/*.md：按文件名归类，## 标题为实体名；武功文件的「招式」子节列表项为招式实体
 */
import { parseSections, isPlaceholder } from '../web/components/views/parseSections';
import type { MdSection } from '../web/components/views/parseSections';

export type EntityType = 'character' | 'alias' | 'weapon' | 'martial' | 'sect' | 'move' | 'place';

export interface EntityRef {
  /** 实体显示名（词典 key）。 */
  name: string;
  /** 实体类型。 */
  type: EntityType;
  /** 档案文件相对路径。 */
  file: string;
  /** 该实体所属 heading 节的标题。 */
  sectionTitle: string;
  /** 该实体所属节的完整 markdown 原文（含标题行）。弹窗直接渲染。 */
  sectionRaw: string;
}

/** 泛指词不入词典（会过度链接）。 */
const STOPWORDS = new Set([
  '江湖', '天下', '武林', '中原', '江湖人', '武林中人',
  '主角', '反派', '配角', '师父', '师兄', '师弟', '师姐', '师妹',
]);

/** 文件类型推断：按路径关键词。 */
type FileType = 'profiles' | 'world' | 'weapon' | 'martial' | 'sect' | 'other';

function inferFileType(path: string): FileType {
  if (path.startsWith('characters/')) return 'profiles';
  if (path === 'world-building.md') return 'world';
  if (path.startsWith('wuxia/sects/') || path === 'wuxia/sects.md') return 'sect';
  if (/martial|功法|武功|武学/.test(path)) return 'martial';
  if (/weapon|兵器|神兵|兵刃/.test(path)) return 'weapon';
  if (/sect|门派|势力|江湖/.test(path)) return 'sect';
  return 'other';
}

/** 名字有效性：≥2 字符、非占位符、非停用词。 */
function isValidName(name: string): boolean {
  if (!name || name.length < 2) return false;
  if (isPlaceholder(name)) return false;
  if (STOPWORDS.has(name)) return false;
  return true;
}

/** 从分组标题提取名字：「一、林冲（主角）」→「林冲」。 */
function extractNameFromTitle(title: string): string {
  let s = title.replace(/^[\d一二三四五六七八九十百]+[、.．)\s]*/, '');
  s = s.split(/[（(]/)[0];
  return s.trim();
}

/** 从标题括号提取外号：「林冲（豹子头）」→「豹子头」。 */
function extractAliasFromTitle(title: string): string | null {
  const m = title.match(/[（(]([^）)]+)[）)]/);
  return m ? m[1].trim() : null;
}

/** 清理列表项文本：去掉 markdown 加粗/链接标记。 */
function cleanItem(item: string): string {
  return item.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
}

/** 招式子节关键词。 */
const MOVE_SUBKEYS = /招式|招|绝招|杀招|招数/;
/** 地理节关键词。 */
const PLACE_KEYS = /地理|地点|地形|山川|城池|关隘/;
/** 武功节关键词。 */
const MARTIAL_KEYS = /武功|武学|功法|内功|心法|绝学/;
/** 兵器节关键词。 */
const WEAPON_KEYS = /兵器|神兵|兵刃|武器|装备/;
/** 门派节关键词。 */
const SECT_KEYS = /门派|势力|江湖|帮会|宗派|教派/;

type AddFn = (n: string, t: EntityType, f: string, st: string, sr: string) => void;

/**
 * 从若干档案文本构建实体词典。
 * @returns Map<实体名, EntityRef>；同名实体保留第一个出现的
 *         （source 喂入顺序决定优先级：profiles > world > wuxia）
 */
export function buildEntityDict(
  sources: Array<{ path: string; content: string }>,
): Map<string, EntityRef> {
  const dict = new Map<string, EntityRef>();

  const add: AddFn = (name, type, file, sectionTitle, sectionRaw) => {
    if (!isValidName(name)) return;
    if (dict.has(name)) return;
    dict.set(name, { name, type, file, sectionTitle, sectionRaw });
  };

  for (const { path, content } of sources) {
    if (!content) continue;
    const fileType = inferFileType(path);
    if (fileType === 'other') continue;
    const doc = parseSections(content);

    for (const section of doc.sections) {
      const sectionRaw = `## ${section.title}\n\n${section.fullRawMd}`;

      if (fileType === 'profiles') {
        processProfilesSection(section, path, sectionRaw, add);
      } else if (fileType === 'world') {
        processWorldSection(section, path, add);
      } else {
        // weapon / martial / sect：## 标题即实体名
        const titleName = extractNameFromTitle(section.title);
        if (titleName) add(titleName, fileType, path, section.title, sectionRaw);
        // martial 文件额外解析招式
        if (fileType === 'martial') {
          processMoves(section, path, add);
        }
      }
    }
  }

  return dict;
}

function processProfilesSection(section: MdSection, file: string, sectionRaw: string, add: AddFn) {
  const nameField = section.fields.find((f) => f.key === '姓名');
  if (nameField) add(nameField.value, 'character', file, section.title, sectionRaw);
  // 标题里的名字（兼容无 姓名 字段的档案）
  const titleName = extractNameFromTitle(section.title);
  if (titleName) add(titleName, 'character', file, section.title, sectionRaw);

  const aliasField = section.fields.find((f) => f.key === '外号' || f.key === '绰号');
  if (aliasField) add(aliasField.value, 'alias', file, section.title, sectionRaw);
  const titleAlias = extractAliasFromTitle(section.title);
  if (titleAlias) add(titleAlias, 'alias', file, section.title, sectionRaw);
}

function processWorldSection(section: MdSection, file: string, add: AddFn) {
  const title = section.title;
  // 地理节：### 子标题为地名
  if (PLACE_KEYS.test(title)) {
    for (const sub of section.subsections) {
      if (isValidName(sub.title)) {
        add(sub.title, 'place', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
      }
    }
  }
  // 武功节：标题本身 + 招式
  if (MARTIAL_KEYS.test(title)) {
    add(extractNameFromTitle(title), 'martial', file, title, `## ${title}\n\n${section.fullRawMd}`);
    processMoves(section, file, add);
  }
  // 兵器节
  if (WEAPON_KEYS.test(title)) {
    add(extractNameFromTitle(title), 'weapon', file, title, `## ${title}\n\n${section.fullRawMd}`);
  }
  // 门派节
  if (SECT_KEYS.test(title)) {
    add(extractNameFromTitle(title), 'sect', file, title, `## ${title}\n\n${section.fullRawMd}`);
    for (const sub of section.subsections) {
      if (isValidName(sub.title)) {
        add(sub.title, 'sect', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
      }
    }
  }
}

function processMoves(section: MdSection, file: string, add: AddFn) {
  for (const sub of section.subsections) {
    if (!MOVE_SUBKEYS.test(sub.title)) continue;
    for (const item of sub.items) {
      const moveName = cleanItem(item);
      if (moveName) add(moveName, 'move', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
    }
    for (const field of sub.fields) {
      add(field.value, 'move', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
    }
  }
}
