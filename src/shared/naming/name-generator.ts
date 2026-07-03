/**
 * 人名生成器核心：姓氏 + 意象字 → 组合候选 → 检查器过滤。
 *
 * 生成策略：
 * 1. 从姓氏地理库或约束中取姓氏候选
 * 2. 从意象字库按关键词匹配取名候选
 * 3. 笛卡尔积组合（姓 × 单字名 / 姓 × 双字名）
 * 4. 检查器过滤（剔除谐音/撞名，标记音韵/相似/生僻警告）
 * 5. 随机采样输出指定数量
 *
 * 不调用 LLM —— LLM 意象推导由上层（API 路由）完成后再传入关键词。
 */
import {
  getSurnamesByRegion,
  matchImagery,
  getNamingCustoms,
  type ImageryEntry,
  type SurnameEntry,
} from './imagery-store';
import { checkName } from './name-checker';
import { nameToPinyinString } from './pinyin';

// ===== 类型 =====

export interface NameCandidate {
  name: string;
  surname: string;
  givenName: string;
  source: { text: string; quote: string } | null;
  imageryTags: string[];
  pinyin: string;
  checks: {
    homophone: boolean;
    collision: boolean;
    phonetics: boolean;
    similarity: boolean;
    rarity: boolean;
  };
  warnings: string[];
  /** true = 建议剔除（谐音或撞名） */
  reject: boolean;
}

export interface GenerateOptions {
  /** 意象关键词（LLM 推导或用户直接输入） */
  imageryKeywords: string[];
  /** 出身地（区域名），默认"模糊古代" */
  region?: string;
  /** 性别过滤 */
  gender?: 'male' | 'female' | 'neutral';
  /** 家族姓氏约束（如"萧"），设则只生成此姓 */
  surnameConstraint?: string;
  /** 命名习俗时代，默认"模糊古代" */
  era?: string;
  /** 已有角色名列表（撞名/相似检查用） */
  existingNames?: string[];
  /** 候选数量上限，默认 15 */
  count?: number;
}

// ===== 常量 =====

// (ratio/length constants intentionally omitted — combination logic handles it)

// ===== 核心生成 =====

/**
 * 生成人名候选列表。
 *
 * @returns 候选数组，已过滤 reject 项，按无警告优先排序
 */
export function generatePersonNames(options: GenerateOptions): NameCandidate[] {
  const {
    imageryKeywords,
    region = '模糊古代',
    gender,
    surnameConstraint,
    era = '模糊古代',
    existingNames = [],
    count = 15,
  } = options;

  // 1. 取姓氏候选
  const surnames = pickSurnames(region, surnameConstraint);
  if (surnames.length === 0) return [];

  // 2. 取意象字候选
  const imageryEntries = matchImagery(imageryKeywords, { gender });
  if (imageryEntries.length === 0) return [];

  // 3. 确定名字长度规则
  const customs = getNamingCustoms(era);
  const allowDouble = customs.nameLength !== 'single';

  // 4. 组合
  const candidates = combineSurnamesAndImagery(
    surnames,
    imageryEntries,
    allowDouble,
    existingNames,
  );

  // 5. 过滤 reject + 去重 + 截取
  const valid = candidates.filter((c) => !c.reject);
  const unique = deduplicateByName(valid);

  // 6. 排序：无警告优先，然后随机
  const sorted = unique.sort((a, b) => {
    const aWarn = a.warnings.length;
    const bWarn = b.warnings.length;
    if (aWarn !== bWarn) return aWarn - bWarn;
    return Math.random() - 0.5;
  });

  return sorted.slice(0, count);
}

// ===== 内部函数 =====

/**
 * 从姓氏库或约束中取候选姓氏。
 * surnameConstraint 设则只返回该姓。
 */
function pickSurnames(region: string, constraint?: string): SurnameEntry[] {
  if (constraint) {
    return [{ surname: constraint, tier: 1 }];
  }
  const regionSurnames = getSurnamesByRegion(region);
  if (regionSurnames.length === 0) return [];
  // 优先取 tier 1-2 的姓氏
  return regionSurnames.filter((s) => s.tier <= 2);
}

/**
 * 笛卡尔积组合姓氏 × 意象字，生成候选。
 * 单字名（姓+1字）和双字名（姓+2字）混合。
 */
function combineSurnamesAndImagery(
  surnames: SurnameEntry[],
  imagery: ImageryEntry[],
  allowDouble: boolean,
  existingNames: string[],
): NameCandidate[] {
  const candidates: NameCandidate[] = [];
  const seen = new Set<string>();

  for (const surname of surnames) {
    for (const entry of imagery) {
      // 单字名
      const singleName = surname.surname + entry.char;
      if (!seen.has(singleName)) {
        seen.add(singleName);
        candidates.push(buildCandidate(surname.surname, [entry], singleName, existingNames));
      }

      // 双字名（两个不同意象字组合）
      if (allowDouble) {
        for (const entry2 of imagery) {
          if (entry2.char === entry.char) continue;
          const doubleName = surname.surname + entry.char + entry2.char;
          if (!seen.has(doubleName)) {
            seen.add(doubleName);
            candidates.push(
              buildCandidate(surname.surname, [entry, entry2], doubleName, existingNames),
            );
          }
        }
      }
    }
  }

  return candidates;
}

/** 构建单个候选对象（含检查器过滤）。 */
function buildCandidate(
  surname: string,
  entries: ImageryEntry[],
  name: string,
  existingNames: string[],
): NameCandidate {
  const givenName = entries.map((e) => e.char).join('');
  const source = entries.length === 1
    ? entries[0]!.source
    : {
        text: entries.map((e) => e.source.text).join('；'),
        quote: entries.map((e) => `${e.char}：${e.source.quote}`).join('；'),
      };
  const imageryTags = [...new Set(entries.flatMap((e) => e.imagery))].slice(0, 4);
  const pinyin = nameToPinyinString(name);

  const checkResult = checkName(name, existingNames);

  return {
    name,
    surname,
    givenName,
    source,
    imageryTags,
    pinyin,
    checks: {
      homophone: checkResult.checks.homophone.hit,
      collision: checkResult.checks.collision.hit,
      phonetics: checkResult.checks.phonetics.hit,
      similarity: checkResult.checks.similarity.hit,
      rarity: checkResult.checks.rarity.hit,
    },
    warnings: checkResult.warnings,
    reject: checkResult.reject,
  };
}

/** 按完整名字去重。 */
function deduplicateByName(candidates: NameCandidate[]): NameCandidate[] {
  const seen = new Set<string>();
  const result: NameCandidate[] = [];
  for (const c of candidates) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      result.push(c);
    }
  }
  return result;
}
