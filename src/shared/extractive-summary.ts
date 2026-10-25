/**
 * 确定性抽取式摘要（纯函数，无 IO / 无随机）。
 *
 * 用于 agent 漏写章节摘要时的占位兜底：相比「截正文前 200 字」的机械截断，
 * 按句打分选取（字符 bigram 词频 + 位置衰减）能保留正文的关键句。
 *
 * 性质约束（测试锁定）：
 * - 无随机、同输入同输出；
 * - 分句 / 词频统计为 O(n) 单遍，选句排序仅与句子数相关；
 * - 输出句子保持原文语序，句末标点保留；
 * - 整句选取时输出长度 ≤ maxChars；无法整句容纳时回退为截断（补省略号）。
 */

/** 分句标点：中文句号 / 问号 / 叹号 / 分号（保留在句内）。 */
const SENTENCE_DELIMITERS = '。！？；';

/** 按「非标点 + 可选句末标点」切句；无标点时整段视为一句。 */
const SENTENCE_RE = new RegExp(`[^${SENTENCE_DELIMITERS}]+[${SENTENCE_DELIMITERS}]?`, 'g');

/** 位置衰减系数：第 i 句（0 起）得分 = 词频和 × 1 / (1 + i × POSITION_DECAY)。 */
const POSITION_DECAY = 0.15;

/** 是否为 CJK 统一表意文字（与 context-manager 的 CJK 判定口径一致）。 */
function isCjkChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x4e00 && code <= 0x9fff;
}

/** 折叠空白（换行 / 连续空格 → 单空格）并去首尾。 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 按中文句读分句，保留句末标点；空白句丢弃。 */
function splitSentences(text: string): string[] {
  const matches = text.match(SENTENCE_RE) ?? [];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 统计全文相邻 CJK 字符对的频次（简化的「词频」：字符 bigram）。 */
function countBigrams(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (let i = 0; i + 1 < text.length; i++) {
    if (!isCjkChar(text[i]) || !isCjkChar(text[i + 1])) continue;
    const bigram = text.slice(i, i + 2);
    freq.set(bigram, (freq.get(bigram) ?? 0) + 1);
  }
  return freq;
}

/** 单句得分：句内 bigram 频次之和 × 位置衰减（越靠前加分越多）。 */
function sentenceScore(sentence: string, index: number, freq: Map<string, number>): number {
  let sum = 0;
  for (let i = 0; i + 1 < sentence.length; i++) {
    const bigram = sentence.slice(i, i + 2);
    const count = isCjkChar(sentence[i]) && isCjkChar(sentence[i + 1]) ? freq.get(bigram) : undefined;
    if (count !== undefined) sum += count;
  }
  return sum / (1 + index * POSITION_DECAY);
}

/**
 * 确定性抽取式摘要：按分取句直至 maxChars，输出保持原文语序。
 * 无有效句子或单句都放不下时回退为截断（超出部分补「…」）。
 */
export function summarizeExtractive(body: string, maxChars: number): string {
  const text = normalizeWhitespace(body);
  if (!text || maxChars <= 0) return '';

  const sentences = splitSentences(text);
  if (sentences.length === 0) return '';

  // 全文词频（字符 bigram 频次）
  const freq = countBigrams(text);

  // 打分排序：分高者优先入选；同分取更靠前的句子（确定性）
  const order = sentences
    .map((sentence, index) => ({ sentence, index, score: sentenceScore(sentence, index, freq) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // 贪心装填：放不下整句则跳过，尝试后面的短句
  const selected: number[] = [];
  let acc = 0;
  for (const item of order) {
    if (acc + item.sentence.length <= maxChars) {
      selected.push(item.index);
      acc += item.sentence.length;
    }
  }

  // 一句都装不下：回退截断最高分句（与旧占位摘要的截断行为一致，补省略号）
  if (selected.length === 0) {
    const top = order[0].sentence;
    return top.length > maxChars ? top.slice(0, maxChars) + '…' : top;
  }

  // 保持原文语序输出
  return selected.sort((a, b) => a - b).map((i) => sentences[i]).join('');
}
