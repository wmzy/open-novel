/**
 * 分层上下文的 token 估算与预算组装。
 *
 * 组装策略（超预算时）：
 * 1. 整层丢弃：从 priority 最大（最不重要）的层开始丢，直到回到预算内；
 * 2. 丢完仍超：对剩余层按 priority 从大到小截断尾部（保留层首 + 「…（已截断）」）；
 * 3. 硬约束层（priority 0）永不整层丢弃，只能被截断。
 *
 * 未超预算时逐层原样保留、按 '\n\n' 拼接——与既有 prompt 组装格式一致。
 */

/** 单个上下文层：priority 越小越重要，0 为硬约束层（永不整层丢弃）。 */
export interface ContextSection {
  name: string;
  priority: number;
  text: string;
}

/** 预算组装后的逐层报告：tokens 为该层构建文本的原始估算，
 *  kept=false 表示被整层丢弃，truncatedTo 为截断后保留的层首字符数。 */
export interface ContextSectionReport {
  name: string;
  priority: number;
  tokens: number;
  kept: boolean;
  truncatedTo?: number;
}

/** 预算组装结果：text 为最终注入文本（层间 '\n\n' 拼接）。 */
export interface AssembleResult {
  text: string;
  report: ContextSectionReport[];
  /** 最终注入文本的 token 估算（丢弃 / 截断之后的量）。 */
  totalTokens: number;
  budgetTokens: number;
}

/** 截断尾部时的结束标记。 */
const TRUNCATION_SUFFIX = '…（已截断）';

/** 层间拼接分隔符（与 prompt-composer 的既有组装格式一致）。 */
const SECTION_SEPARATOR = '\n\n';

/**
 * 估算文本 token 数（O(n) 单遍）：
 * - CJK 统一表意文字（U+4E00–U+9FFF）每字 1 token；
 * - 连续的 ASCII 字母 / 数字串记一个拉丁词，每词 1.3 token（总和向上取整）；
 * - 其余字符（标点 / 空白 / 其他文字）按 0 计。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let latinWords = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk++;
      inWord = false;
    } else if (
      (code >= 0x41 && code <= 0x5a) || // A-Z
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39)    // 0-9
    ) {
      if (!inWord) {
        latinWords++;
        inWord = true;
      }
    } else {
      inWord = false;
    }
  }
  return cjk + Math.ceil(latinWords * 1.3);
}

/** 截断文本尾部至目标 token 数：保留层首 + 截断标记。
 *  token 估算随前缀长度单调不减，故可二分查找最大可保留前缀。 */
function truncateToTokenBudget(
  text: string,
  targetTokens: number,
): { text: string; keptChars: number } {
  if (estimateTokens(text) <= targetTokens) {
    return { text, keptChars: text.length };
  }
  // 至少保留截断标记本身占用的 token（目标更小时前缀退化为空）
  const maxTarget = Math.max(targetTokens, estimateTokens(TRUNCATION_SUFFIX));
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid) + TRUNCATION_SUFFIX) <= maxTarget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { text: text.slice(0, lo) + TRUNCATION_SUFFIX, keptChars: lo };
}

/**
 * 按预算组装上下文层。
 * 未超预算：全部保留，text = 各层按原顺序以 '\n\n' 拼接。
 * 超预算：先整层丢弃（priority 降序；同 priority 丢更靠后的层），再按
 * priority 降序截断剩余层尾部；priority 0 只截不丢。
 * report 与入参层顺序一致，便于检查器按注入顺序展示。
 */
export function assembleWithBudget(
  sections: ContextSection[],
  budgetTokens: number,
): AssembleResult {
  const items = sections.map((s, index) => ({
    index,
    name: s.name,
    priority: s.priority,
    text: s.text,
    tokens: estimateTokens(s.text),
    finalText: s.text,
    kept: true,
    truncatedTo: undefined as number | undefined,
  }));

  let total = items.reduce((sum, it) => sum + it.tokens, 0);

  if (total > budgetTokens) {
    // 阶段一：整层丢弃。跳过 0 token 层（丢弃它们省不出预算，只会误伤）。
    const dropOrder = items
      .filter((it) => it.priority > 0 && it.tokens > 0)
      .sort((a, b) => b.priority - a.priority || b.index - a.index);
    for (const it of dropOrder) {
      if (total <= budgetTokens) break;
      it.kept = false;
      it.finalText = '';
      total -= it.tokens;
    }

    // 阶段二：丢完仍超 → 截断剩余层尾部（priority 降序；同 priority 先截更靠后的层）
    if (total > budgetTokens) {
      const truncOrder = items
        .filter((it) => it.kept)
        .sort((a, b) => b.priority - a.priority || b.index - a.index);
      for (const it of truncOrder) {
        if (total <= budgetTokens) break;
        const excess = total - budgetTokens;
        const target = Math.max(0, estimateTokens(it.finalText) - excess);
        const res = truncateToTokenBudget(it.finalText, target);
        if (res.text === it.finalText) continue; // 已最小化，无需标注
        total = total - it.tokens + estimateTokens(res.text);
        it.finalText = res.text;
        it.truncatedTo = res.keptChars;
      }
    }
  }

  const text = items
    .filter((it) => it.kept)
    .map((it) => it.finalText)
    .join(SECTION_SEPARATOR);

  const report: ContextSectionReport[] = items.map(({ name, priority, tokens, kept, truncatedTo }) =>
    truncatedTo === undefined ? { name, priority, tokens, kept } : { name, priority, tokens, kept, truncatedTo },
  );

  return { text, report, totalTokens: estimateTokens(text), budgetTokens };
}
