/**
 * 拼音工具：汉字 → 拼音 + 声调分析。
 *
 * 用于检查器的谐音检测（拼音匹配尴尬音表）和音韵检测（声调组合分析）。
 */
import { pinyin } from 'pinyin-pro';

/** 单字拼音信息：带调拼音 + 声调数字（1-4，轻声为 0）。 */
export interface PinyinInfo {
  /** 带调拼音，如 "shěn" */
  pinyin: string;
  /** 无调拼音（纯声母韵母），如 "shen" */
  base: string;
  /** 声调：1-4，轻声 0 */
  tone: number;
}

const TONE_MARKS: Record<string, number> = {
  'ā': 1, 'á': 2, 'ǎ': 3, 'à': 4,
  'ē': 1, 'é': 2, 'ě': 3, 'è': 4,
  'ī': 1, 'í': 2, 'ǐ': 3, 'ì': 4,
  'ō': 1, 'ó': 2, 'ǒ': 3, 'ò': 4,
  'ū': 1, 'ú': 2, 'ǔ': 3, 'ù': 4,
  'ǖ': 1, 'ǘ': 2, 'ǚ': 3, 'ǜ': 4,
};

/** 从带调拼音提取声调数字。 */
function extractTone(pinyinStr: string): number {
  for (const [mark, tone] of Object.entries(TONE_MARKS)) {
    if (pinyinStr.includes(mark)) return tone;
  }
  return 0;
}

/** 去除声调标记，返回纯声母韵母。 */
function stripTone(pinyinStr: string): string {
  let result = pinyinStr;
  for (const mark of Object.keys(TONE_MARKS)) {
    const base = mark.normalize('NFD')[0] ?? mark;
    result = result.replaceAll(mark, base);
  }
  return result;
}

/**
 * 将单个汉字转为拼音信息。
 * 非汉字字符返回空对象。
 */
export function charToPinyin(char: string): PinyinInfo | null {
  const py = pinyin(char, { toneType: 'symbol', type: 'array' });
  if (!py || py.length === 0 || py[0] === char) return null;
  const p = py[0];
  return {
    pinyin: p,
    base: stripTone(p),
    tone: extractTone(p),
  };
}

/**
 * 将名字（多字）转为各字的拼音信息数组。
 */
export function nameToPinyin(name: string): PinyinInfo[] {
  const chars = [...name].filter((c) => c >= '\u4e00' && c <= '\u9fff');
  const result: PinyinInfo[] = [];
  for (const c of chars) {
    const info = charToPinyin(c);
    if (info) result.push(info);
  }
  return result;
}

/**
 * 获取名字的完整带调拼音字符串（空格分隔）。
 * 如 "林冲" → "xiāo yuǎn"
 */
export function nameToPinyinString(name: string): string {
  const result = pinyin(name, { toneType: 'symbol', type: 'array' });
  return Array.isArray(result) ? result.join(' ') : '';
}

/**
 * 检测名字各字声调是否全部相同（音韵雷同）。
 * 如 "萧寂寒"（全去声）→ true
 */
export function isAllSameTone(name: string): boolean {
  const infos = nameToPinyin(name);
  if (infos.length < 2) return false;
  const first = infos[0]!.tone;
  if (first === 0) return false;
  return infos.every((info) => info.tone === first);
}
