/**
 * 素材库加载与查询：姓氏地理分布、意象字库、命名习俗、尴尬谐音表。
 *
 * 数据文件位于 src/shared/naming/data/，初始化时同步加载。
 * 支持运行时扩充临时意象字（联网兜底），扩充项不持久化到内置库。
 */
import surnamesData from './data/surnames-by-region.json';
import imageryData from './data/imagery-core.json';
import customsData from './data/naming-customs.json';
import awkwardData from './data/awkward-pinyin.json';

// ===== 类型 =====

export interface SurnameEntry {
  surname: string;
  /** 1=高频, 2=常见, 3=少见 */
  tier: number;
}

export interface ImageryEntry {
  char: string;
  pinyin: string;
  imagery: string[];
  source: { text: string; quote: string };
  gender: 'male' | 'female' | 'neutral';
  connotation: 'positive' | 'melancholy' | 'dark' | 'neutral';
}

export interface NamingCustoms {
  nameLength: 'single' | 'any';
  style: string;
}

export type AwkwardPinyinTable = Record<string, string[]>;

// ===== 内部状态 =====

/** 临时扩充意象字（联网兜底），运行时追加。 */
const extraImagery: ImageryEntry[] = [];

// ===== 姓氏库 =====

/** 获取指定区域的姓氏列表，按 tier 排序（高频在前）。
 *  未知区域（含“模糊古代”）回退到“江淮”（最通用的中原姓氏分布）。 */
export function getSurnamesByRegion(region: string): SurnameEntry[] {
  const data = surnamesData as Record<string, SurnameEntry[]>;
  const list = data[region] ?? data['江淮'] ?? [];
  return [...list].sort((a, b) => a.tier - b.tier);
}

/** 获取所有可用区域名。 */
export function getRegions(): string[] {
  return Object.keys(surnamesData);
}

// ===== 意象字库 =====

/** 获取所有意象字（内置 + 临时扩充）。 */
export function getAllImagery(): ImageryEntry[] {
  return [...(imageryData as ImageryEntry[]), ...extraImagery];
}

/**
 * 按意象关键词匹配意象字。
 * 返回 imagery 标签与关键词有交集的条目。
 *
 * @param keywords 意象关键词数组（如 ["深沉", "衰败"]）
 * @param options 可选过滤：性别、内涵
 */
export function matchImagery(
  keywords: string[],
  options?: { gender?: 'male' | 'female' | 'neutral'; connotation?: string },
): ImageryEntry[] {
  const all = getAllImagery();
  return all.filter((entry) => {
    if (options?.gender && entry.gender !== 'neutral' && entry.gender !== options.gender) {
      return false;
    }
    if (options?.connotation && entry.connotation !== options.connotation) {
      return false;
    }
    return entry.imagery.some((tag) =>
      keywords.some((kw) => tag.includes(kw) || kw.includes(tag)),
    );
  });
}

/** 向临时扩充库添加意象字（联网兜底用）。 */
export function addExtraImagery(entries: ImageryEntry[]): void {
  const existingChars = new Set(getAllImagery().map((e) => e.char));
  for (const entry of entries) {
    if (!existingChars.has(entry.char)) {
      extraImagery.push(entry);
      existingChars.add(entry.char);
    }
  }
}

// ===== 命名习俗 =====

/** 获取指定时代的命名习俗。默认返回"模糊古代"。 */
export function getNamingCustoms(era: string): NamingCustoms {
  const data = customsData as Record<string, NamingCustoms>;
  return data[era] ?? data['模糊古代']!;
}

// ===== 谐音表 =====

/** 获取尴尬谐音表。key = 带调拼音，value = 尴尬同音字。 */
export function getAwkwardPinyin(): AwkwardPinyinTable {
  return awkwardData as AwkwardPinyinTable;
}
