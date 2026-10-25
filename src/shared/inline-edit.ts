/**
 * 编辑器内联 AI（润色/扩写/续写）的纯函数层。
 *
 * 设计约束：
 * - 无任何 IO/框架依赖：prompt 构建、段落切分、段落级合并计划均为确定性纯函数，
 *   前后端共用——路由用它们生成 prompt 与 plan，编辑器用同一份 plan 渲染
 *   diff 预览并应用，保证「预览所见」与「写入正文」完全一致。
 * - 合并策略按段落 diff：模型输出段落数与原文相近时逐段原位替换（未变段落不动，
 *   diff 粒度细）；段落数剧变（>2 倍或不足一半）时整体替换（逐段配对已无意义）。
 */

export type InlineAction = 'polish' | 'expand' | 'continue';

export const INLINE_ACTION_LABELS: Record<InlineAction, string> = {
  polish: '润色',
  expand: '扩写',
  continue: '续写',
};

/** 选区前上下文窗口（字符）。 */
export const INLINE_BEFORE_CONTEXT_CHARS = 1500;
/** 选区后上下文窗口（字符）。 */
export const INLINE_AFTER_CONTEXT_CHARS = 1500;
/** 续写时光标前文窗口（字符）——续写只需要紧邻光标的近期文本。 */
export const INLINE_CONTINUE_TAIL_CHARS = 500;

export interface InlineEditPromptContext {
  /** 章节号（1 起）。 */
  chapter: number;
  /** 选区/光标之前的正文；超窗取尾部（紧邻选区的部分最有价值）。 */
  before?: string;
  /** 选区/光标之后的正文；超窗取头部。 */
  after?: string;
}

/** 取尾部 n 个字符（基于 trim 后文本）。 */
function clipTail(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(t.length - max);
}

/** 取头部 n 个字符（基于 trim 后文本）。 */
function clipHead(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max);
}

/**
 * 构建内联编辑 prompt：给动作指令、选中文本（续写时用光标前尾部 ~500 字）、
 * 章节前后文，要求模型只输出处理后的文本片段，不加解释不加围栏。
 */
export function buildInlineEditPrompt(
  action: InlineAction,
  selection: string,
  context: InlineEditPromptContext,
): string {
  const label = INLINE_ACTION_LABELS[action];
  const isContinue = action === 'continue';
  const lines: string[] = [];
  lines.push(`你是小说写作助手。请对小说第${context.chapter}章的以下片段执行「${label}」。`);
  lines.push('');
  if (action === 'polish') {
    lines.push('任务要求：在保持情节、事实、人物关系与对话内容完全不变的前提下润色这段文字，修正病句与错别字，提升文笔与节奏，不增删情节。');
  } else if (action === 'expand') {
    lines.push('任务要求：在不改变情节走向与既定事实的前提下扩写这段文字，补充细节描写、心理活动与环境感官，使内容更丰满。');
  } else {
    lines.push('任务要求：紧接着光标前文自然续写后续段落，保持人物语气与前文情节连贯，不重复前文，不复述设定。');
  }

  const before = clipTail(context.before ?? '', isContinue ? INLINE_CONTINUE_TAIL_CHARS : INLINE_BEFORE_CONTEXT_CHARS);
  const after = isContinue ? '' : clipHead(context.after ?? '', INLINE_AFTER_CONTEXT_CHARS);
  if (before || after) {
    lines.push('');
    lines.push('上下文（仅供理解，不要输出或改写）：');
    if (before) lines.push(`【${isContinue ? '光标前文' : '选区前文'}】\n${before}`);
    if (after) lines.push(`【选区后文】\n${after}`);
  }

  lines.push('');
  if (isContinue && !selection.trim()) {
    lines.push(before ? '请从上面「光标前文」的结尾处继续写。' : '请为本章写开篇段落。');
  } else {
    lines.push(`待${label}文本：\n${selection.trim()}`);
  }
  lines.push('');
  lines.push(`输出要求：只输出${label}后的文本片段（续写则输出续写的段落），保持原文的分段风格；不要任何解释、评述或引言，不要 markdown 代码围栏。`);
  return lines.join('\n');
}

/**
 * 按空行切分段落（章节正文是 markdown，段落间以空行分隔；段落内软换行保留）。
 * 归一化换行符，段落 trim、空段落丢弃——前后端必须用同一套切分才能对齐 plan 的 index。
 */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** 段落数组 → 文本（空行分段，与 splitParagraphs 互逆）。 */
export function joinParagraphs(paras: string[]): string {
  return paras.join('\n\n');
}

export interface ParagraphReplacement {
  /** 原文段落序号（0 起，对应 splitParagraphs 结果）。 */
  index: number;
  /** 原段落。 */
  from: string;
  /** 新段落。 */
  to: string;
}

export interface ParagraphMergePlan {
  /** 段落数剧变时的整体替换（from/to 为拼接后的完整文本）；此时 replaced/appended 为空。 */
  whole: { from: string; to: string } | null;
  /** 原位替换的段落（未列出的段落保持原文不动）。 */
  replaced: ParagraphReplacement[];
  /** 追加到末尾的新段落（原文没有对应，如扩写多出的段、续写的全部输出）。 */
  appended: string[];
}

/** 段落数「剧变」判定：超过 2 倍或不足一半——逐段配对失去意义，直接整体替换。 */
function isCountDrastic(origCount: number, newCount: number): boolean {
  if (origCount === 0) return false;
  return newCount > origCount * 2 || newCount * 2 < origCount;
}

/**
 * 计算段落级合并计划（确定性纯函数，供 diff 高亮与合并共用）。
 * 原文为空（续写）→ 全部 appended；段落数相近 → 按 index 原位配对，不同的记为 replaced，
 * 多出的新段落记为 appended。
 */
export function planParagraphMerge(origParas: string[], newParas: string[]): ParagraphMergePlan {
  if (isCountDrastic(origParas.length, newParas.length)) {
    return {
      whole: { from: joinParagraphs(origParas), to: joinParagraphs(newParas) },
      replaced: [],
      appended: [],
    };
  }
  const replaced: ParagraphReplacement[] = [];
  const pairCount = Math.min(origParas.length, newParas.length);
  for (let i = 0; i < pairCount; i++) {
    if (origParas[i] !== newParas[i]) replaced.push({ index: i, from: origParas[i], to: newParas[i] });
  }
  return { whole: null, replaced, appended: newParas.slice(pairCount) };
}

/** 把合并计划应用到原文段落数组，产出替换/追加后的完整文本。 */
export function applyParagraphMerge(origParas: string[], plan: ParagraphMergePlan): string {
  if (plan.whole) return plan.whole.to;
  const paras = [...origParas];
  for (const r of plan.replaced) {
    // index 越界防御：plan 与 origParas 不配套时忽略该条，而不是静默丢失或抛错
    if (r.index >= 0 && r.index < paras.length) paras[r.index] = r.to;
  }
  paras.push(...plan.appended);
  return joinParagraphs(paras);
}

/** 便捷入口：original/result 两段文本 → 按段落计划合并后的新文本。 */
export function mergeInlineResult(original: string, result: string): string {
  const origParas = splitParagraphs(original);
  return applyParagraphMerge(origParas, planParagraphMerge(origParas, splitParagraphs(result)));
}
