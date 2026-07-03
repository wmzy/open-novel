/**
 * 名字检查器：谐音、撞名、音韵、组内相似、生僻字。
 *
 * 纯函数设计，所有检查可独立调用，也可通过 checkName 一次性运行全部。
 * 谐音/撞名命中 → 建议剔除；音韵/组内相似/生僻字 → 仅警告。
 */
import { nameToPinyin, isAllSameTone } from './pinyin';
import { getAwkwardPinyin } from './imagery-store';

// ===== 类型 =====

export interface NameChecks {
  /** 谐音检查：命中尴尬同音字 */
  homophone: { hit: boolean; chars?: string[] };
  /** 撞名检查：与已有角色名碰撞 */
  collision: { hit: boolean; target?: string };
  /** 音韵检查：全组声调雷同 */
  phonetics: { hit: boolean; detail?: string };
  /** 组内相似：与已有名字编辑距离 ≤ 1 */
  similarity: { hit: boolean; target?: string };
  /** 生僻字检查 */
  rarity: { hit: boolean; chars?: string[] };
}

export interface CheckResult {
  checks: NameChecks;
  /** 组合的警告文案列表 */
  warnings: string[];
  /** 是否建议直接剔除（谐音或撞名命中） */
  reject: boolean;
}

// ===== 常量 =====

/** 生僻字判定：CJK 基本区 (U+4E00–U+9FFF) 内为常用，
 *  扩展 A/B/C 区 (U+3400+, U+20000+) 视为生僻。 */
const RARE_CHAR_MIN = '\u9fff';

/** 单字编辑距离 ≤ 1 判定为相似 */
const SIMILARITY_DISTANCE = 1;

// ===== 单项检查 =====

/**
 * 谐音检查：名字各字的带调拼音是否命中尴尬谐音表。
 */
export function checkHomophone(name: string): { hit: boolean; chars?: string[] } {
  const table = getAwkwardPinyin();
  const infos = nameToPinyin(name);
  const hits: string[] = [];
  for (const info of infos) {
    if (table[info.pinyin]) {
      hits.push(...table[info.pinyin]!);
    }
  }
  if (hits.length === 0) return { hit: false };
  return { hit: true, chars: [...new Set(hits)] };
}

/**
 * 撞名检查：名字是否与已有角色名完全相同。
 */
export function checkCollision(
  name: string,
  existingNames: string[],
): { hit: boolean; target?: string } {
  for (const existing of existingNames) {
    if (name === existing) {
      return { hit: true, target: existing };
    }
  }
  return { hit: false };
}

/**
 * 音韵检查：名字各字声调是否全部相同。
 * 如 "萧寂寒"（全去声）→ { hit: true }
 */
export function checkPhonetics(name: string): { hit: boolean; detail?: string } {
  if (isAllSameTone(name)) {
    return { hit: true, detail: '全组声调雷同，读起来缺乏起伏' };
  }
  return { hit: false };
}

/**
 * 组内相似检查：新名字与已有名字的编辑距离。
 * 编辑距离 ≤ 1 判定相似（如 "林冲" 与 "萧言"）。
 */
export function checkSimilarity(
  name: string,
  existingNames: string[],
): { hit: boolean; target?: string } {
  for (const existing of existingNames) {
    if (editDistance(name, existing) <= SIMILARITY_DISTANCE && name !== existing) {
      return { hit: true, target: existing };
    }
  }
  return { hit: false };
}

/**
 * 生僻字检查：名字中是否包含非常用字。
 */
export function checkRarity(name: string): { hit: boolean; chars?: string[] } {
  const chars = [...name].filter((c) => c >= '\u4e00' && c <= '\u9fff');
  const rare = chars.filter((c) => c > RARE_CHAR_MIN);
  if (rare.length === 0) return { hit: false };
  return { hit: true, chars: rare };
}

// ===== 组合检查 =====

/**
 * 运行全部检查，返回组合结果。
 *
 * @param name 待检查的名字
 * @param existingNames 已有角色名列表（用于撞名和组内相似检查）
 */
export function checkName(name: string, existingNames: string[] = []): CheckResult {
  const homophone = checkHomophone(name);
  const collision = checkCollision(name, existingNames);
  const phonetics = checkPhonetics(name);
  const similarity = checkSimilarity(name, existingNames);
  const rarity = checkRarity(name);

  const checks: NameChecks = { homophone, collision, phonetics, similarity, rarity };
  const warnings: string[] = [];
  let reject = false;

  if (homophone.hit) {
    warnings.push(`谐音警告：${homophone.chars!.join('、')}`);
    reject = true;
  }
  if (collision.hit) {
    warnings.push(`撞名：与已有角色「${collision.target}」重名`);
    reject = true;
  }
  if (phonetics.hit) {
    warnings.push(`音韵警告：${phonetics.detail}`);
  }
  if (similarity.hit) {
    warnings.push(`相似警告：与「${similarity.target}」过于相近`);
  }
  if (rarity.hit) {
    warnings.push(`生僻字警告：${rarity.chars!.join('、')}`);
  }

  return { checks, warnings, reject };
}

// ===== 工具 =====

/**
 * 计算两个字符串的 Levenshtein 编辑距离。
 * 用于组内相似检测。
 */
export function editDistance(a: string, b: string): number {
  const charsA = [...a];
  const charsB = [...b];
  const m = charsA.length;
  const n = charsB.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = charsA[i - 1] === charsB[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
    }
  }
  return dp[m]![n]!;
}
