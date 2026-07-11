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
  // 分类标题词（真实档案的 section 常见名）
  '基本信息', '时间线', '性格', '性格特征', '外貌', '外貌特征', '背景', '背景故事',
  '动机', '目标', '冲突', '功能', '定位', '作用', '关系', '关键关系',
  '家族', '驱动力', '驱动力三角', '成长弧线', '思想演变', '社会身份',
  '装备', '语言习惯', '行为习惯', '核心性格', '武学状态', '三不朽',
  '基本信息', '核心设定', '组织形态', '传承内容', '代表人物', '智囊人物',
  '历史与政治', '社会结构', '文化特征', '经济基础', '世界规则', '世界冲突',
  '时代背景', '地理环境', '地理运用原则', '物理规则', '真实制度',
]);

/** 标题含这些模式则为描述性分类，不入词典：「故事舞台：真实的明初天下」「侠道——不是组织」。 */
function isDescriptiveTitle(title: string): boolean {
  // 含全角冒号、破折号、逗号、书名号等的描述性标题
  if (/[：:——，,。]|——|《|》/.test(title)) return true;
  // 以常见分类尾词结尾：「主要地点及其故事功能」「在故事中的作用」
  if (/(作用|功能|定位|原则|特征|演变|状态|结构|关系|背景|阶段|习惯|含义|生态|守则)$/.test(title)) return true;
  return false;
}

/** 文件类型推断：按路径关键词。 */
type FileType = 'profiles' | 'world' | 'weapon' | 'martial' | 'sect' | 'other';

function inferFileType(path: string): FileType {
  if (path.startsWith('characters/')) return 'profiles';
  if (path.startsWith('world/') || path === 'world-building.md') return 'world';
  if (path.startsWith('concept/')) return 'world'; // concept 要素也按 world 处理实体提取
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

/** 清理 markdown 强调标记：**姓名** → 姓名。 */
function cleanMdEmphasis(s: string): string {
  return s.replace(/\*\*/g, '').trim();
}

/** 清理列表项文本：去掉 markdown 加粗/链接标记。 */
function cleanItem(item: string): string {
  return item.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
}

/** 从值中取逗号前的主名：「剑平，字试锋」→「剑平」。 */
function primaryName(value: string): string {
  return value.split(/[，,、][^，,、]*$/)[0].split(/，|,|、/)[0].trim();
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
    // 文档标题（# 级）含冒号时取冒号后作为名字候选（如「# 主角：剑平」→「剑平」）
    const titleColonIdx = doc.title.search(/[：:]/);
    const docTitleName =
      titleColonIdx >= 0
        ? extractNameFromTitle(doc.title.slice(titleColonIdx + 1))
        : '';
    // 注意：不从文档标题括号提取 alias——「# 重要背景角色：剑城（父亲）」的括号是定位说明不是外号
    const fullRaw = content;

    for (const section of doc.sections) {
      const sectionRaw = `## ${section.title}\n\n${section.fullRawMd}`;

      if (fileType === 'profiles') {
        processProfilesSection(section, path, sectionRaw, add, docTitleName, fullRaw);
      } else if (fileType === 'world') {
        processWorldSection(section, path, add);
      } else {
        // weapon / martial / sect：## 标题为实体名（过滤描述性标题）
        const titleName = extractNameFromTitle(section.title);
        if (titleName && !isDescriptiveTitle(section.title)) {
          add(titleName, fileType, path, section.title, sectionRaw);
        }
        // martial 文件额外解析招式
        if (fileType === 'martial') {
          processMoves(section, path, add);
        }
      }
    }
  }

  return dict;
}

function processProfilesSection(
  section: MdSection,
  file: string,
  sectionRaw: string,
  add: AddFn,
  docTitleName: string,
  fullRaw: string,
) {
  // 字段名去 markdown 强调标记后比较：**姓名** → 姓名
  const nameField = section.fields.find((f) => cleanMdEmphasis(f.key) === '姓名');
  const sectionName = nameField ? primaryName(nameField.value) : '';

  // 角色：姓名字段值（最可靠来源）
  if (sectionName) {
    add(sectionName, 'character', file, section.title, fullRaw);
  }
  // 文档标题里的名字（如「# 主角：剑平」→「剑平」），兼容无 姓名 字段的档案
  if (docTitleName) add(docTitleName, 'character', file, section.title, fullRaw);
  // 标题里的名字：仅当标题与姓名字段值一致时（如「## 林冲」+「- 姓名：林冲」）。
  // 分类标题（「基本信息」「时间线」）与姓名值不一致，不入词典。
  const titleName = extractNameFromTitle(section.title);
  if (titleName && titleName === sectionName) {
    add(titleName, 'character', file, section.title, sectionRaw);
  }

  // 外号/绰号字段值
  const aliasField = section.fields.find(
    (f) => cleanMdEmphasis(f.key) === '外号' || cleanMdEmphasis(f.key) === '绰号',
  );
  if (aliasField) {
    const alias = primaryName(aliasField.value);
    add(alias, 'alias', file, section.title, fullRaw);
  }
  // 标题括号里的外号：仅当标题是角色名时才取（防「基本信息（必读）」这类深分类词）
  if (titleName && titleName === sectionName) {
    const titleAlias = extractAliasFromTitle(section.title);
    if (titleAlias) add(titleAlias, 'alias', file, section.title, sectionRaw);
  }
}

function processWorldSection(section: MdSection, file: string, add: AddFn) {
  const title = section.title;
  // 地理节：### 子标题为地名（过滤描述性标题）
  if (PLACE_KEYS.test(title)) {
    for (const sub of section.subsections) {
      if (isValidName(sub.title) && !isDescriptiveTitle(sub.title)) {
        add(sub.title, 'place', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
      }
    }
  }
  // 武功节：标题本身 + 招式
  if (MARTIAL_KEYS.test(title)) {
    const name = extractNameFromTitle(title);
    if (name && !isDescriptiveTitle(title)) add(name, 'martial', file, title, `## ${title}\n\n${section.fullRawMd}`);
    processMoves(section, file, add);
  }
  // 兵器节
  if (WEAPON_KEYS.test(title)) {
    const name = extractNameFromTitle(title);
    if (name && !isDescriptiveTitle(title)) add(name, 'weapon', file, title, `## ${title}\n\n${section.fullRawMd}`);
  }
  // 门派节
  if (SECT_KEYS.test(title)) {
    const name = extractNameFromTitle(title);
    if (name && !isDescriptiveTitle(title)) add(name, 'sect', file, title, `## ${title}\n\n${section.fullRawMd}`);
    for (const sub of section.subsections) {
      if (isValidName(sub.title) && !isDescriptiveTitle(sub.title)) {
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
