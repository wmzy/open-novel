/**
 * 敏感词扫描（发布前自检用）。
 *
 * 词表只收「各中文平台审核确定拦截/限流」的高危词，宁缺勿滥：
 * 单字动词（杀/死/血）与武侠玄幻高频词（灭门、凌迟、斩首）不入表，
 * 避免正常类型文误报。用户可在项目级 .novel/sensitive-words.txt 扩展。
 */

/** 内置默认词表：按类目分组注释，纯常量便于审阅与增删。 */
export const DEFAULT_SENSITIVE_WORDS: readonly string[] = [
  // ── 政治敏感 ──
  '六四', '天安门', '法轮功', '达赖喇嘛', '台独', '藏独', '疆独', '港独',
  '颠覆国家', '分裂国家', '邪教组织', '恐怖组织', '群体事件', '煽动颠覆',
  // ── 色情低俗 ──
  '做爱', '性交', '口交', '肛交', '性爱', '强奸', '轮奸', '乱伦', '猥亵',
  '露阴', '卖淫', '嫖娼', '援交', '约炮', '一夜情', '裸聊', '情色', '色情服务',
  '自慰', '手淫', '射精', '精液', '处女膜', '阴蒂', '阴茎', '阴道', '龟头',
  '乳房', '破处',
  // ── 暴力犯罪 ──
  '分尸', '碎尸', '虐杀', '奸杀', '虐待儿童', '拐卖妇女', '拐卖儿童',
  '买凶杀人', '泼硫酸', '活摘器官', '制造炸弹', '土制炸药', '雷管',
  '私藏枪支', '持枪抢劫',
  // ── 赌博 ──
  '赌博', '赌场', '博彩', '六合彩', '老虎机', '百家乐', '轮盘赌', '网赌',
  '高利贷', '押大小',
  // ── 毒品 ──
  '毒品', '吸毒', '贩毒', '制毒', '运毒', '海洛因', '冰毒', '大麻',
  '摇头丸', 'K粉', '可卡因', '鸦片', '毒瘾',
];

export interface SensitiveSample {
  /** 命中所在章号；对整本文本直接扫描时为 null。 */
  chapter: number | null;
  /** 命中在传入文本内的字符下标。 */
  index: number;
  /** 命中点 ±20 字上下文。 */
  context: string;
}

export interface SensitiveWordHit {
  word: string;
  count: number;
  /** 最多 3 处样本，按出现顺序取前 3。 */
  samples: SensitiveSample[];
}

/** 每处样本的上下文半径（字）。 */
const SAMPLE_CONTEXT_RADIUS = 20;
const MAX_SAMPLES = 3;

/** ASCII 折叠小写（长度不变，中文不受影响），保证 K粉/AV 这类含字母词大小写无关匹配且索引不错位。 */
function asciiLower(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i];
  }
  return out;
}

/** 词表清洗：去空白、按小写形态去重（保留原大小写便于展示）。 */
export function normalizeWordList(words: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of words) {
    const word = raw.trim();
    if (!word) continue;
    const key = asciiLower(word);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

/** 解析项目级词表文件（每行一词，# 开头为注释，允许 BOM）。 */
export function parseSensitiveWordsFile(content: string): string[] {
  return normalizeWordList(
    content
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('#')),
  );
}

/**
 * 扫描文本命中词表的情况。
 *
 * @param text 待检文本（通常是一章正文）
 * @param extraWords 项目级扩展词表（与默认表合并，大小写不敏感）
 * @param chapter 样本归属章号（多章扫描由调用方逐章传入）
 */
export function scanSensitiveWords(
  text: string,
  extraWords: string[] = [],
  chapter: number | null = null,
): SensitiveWordHit[] {
  const words = normalizeWordList([...DEFAULT_SENSITIVE_WORDS, ...extraWords]);
  const haystack = asciiLower(text);
  const hits: SensitiveWordHit[] = [];

  for (const word of words) {
    const needle = asciiLower(word); // 大小写无关匹配；长度不变，索引可直接用于原文切片
    let count = 0;
    const samples: SensitiveSample[] = [];
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      count += 1;
      if (samples.length < MAX_SAMPLES) {
        const start = Math.max(0, index - SAMPLE_CONTEXT_RADIUS);
        const end = Math.min(text.length, index + word.length + SAMPLE_CONTEXT_RADIUS);
        samples.push({ chapter, index, context: text.slice(start, end) });
      }
      from = index + word.length;
    }
    if (count > 0) hits.push({ word, count, samples });
  }

  // 命中多的排前面，便于作者按风险优先处理
  hits.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
  return hits;
}
