// @vitest-environment node
/** 内联 AI 纯函数层：prompt 构建 + 段落切分 + 段落级合并计划。 */
import { describe, it, expect } from 'vitest';
import {
  buildInlineEditPrompt,
  splitParagraphs,
  joinParagraphs,
  planParagraphMerge,
  applyParagraphMerge,
  mergeInlineResult,
  INLINE_BEFORE_CONTEXT_CHARS,
  INLINE_AFTER_CONTEXT_CHARS,
  INLINE_CONTINUE_TAIL_CHARS,
} from '../../../src/shared/inline-edit';

describe('buildInlineEditPrompt', () => {
  const ctx = { chapter: 3, before: '前文。', after: '后文。' };

  it('三动作都包含动作指令、章节号、选中文本与前文', () => {
    for (const action of ['polish', 'expand', 'continue'] as const) {
      const prompt = buildInlineEditPrompt(action, '被选中的片段。', ctx);
      expect(prompt).toContain('第3章');
      expect(prompt).toContain('被选中的片段。');
      expect(prompt).toContain('前文。');
      expect(prompt).toContain('不要 markdown 代码围栏');
    }
    // 选区后文只给润色/扩写（面向已有文本），续写不吃后文
    expect(buildInlineEditPrompt('polish', '片段。', ctx)).toContain('后文。');
    expect(buildInlineEditPrompt('expand', '片段。', ctx)).toContain('后文。');
    expect(buildInlineEditPrompt('continue', '', ctx)).not.toContain('后文。');
    expect(buildInlineEditPrompt('polish', '片段。', ctx)).toContain('润色');
    expect(buildInlineEditPrompt('expand', '片段。', ctx)).toContain('扩写');
    expect(buildInlineEditPrompt('continue', '', ctx)).toContain('续写');
  });

  it('润色/扩写的前后文分别取尾部/头部窗口', () => {
    const head = 'A'.repeat(3000);
    const tail = 'B'.repeat(3000);
    const prompt = buildInlineEditPrompt('polish', '片段。', { chapter: 1, before: head, after: tail });
    // 前文只含尾部 1500 字、后文只含头部 1500 字
    expect(prompt).not.toContain('A'.repeat(INLINE_BEFORE_CONTEXT_CHARS + 1));
    expect(prompt).toContain('A'.repeat(INLINE_BEFORE_CONTEXT_CHARS));
    expect(prompt).not.toContain('B'.repeat(INLINE_AFTER_CONTEXT_CHARS + 1));
    expect(prompt).toContain('B'.repeat(INLINE_AFTER_CONTEXT_CHARS));
    expect(prompt).toContain('【选区前文】');
    expect(prompt).toContain('【选区后文】');
  });

  it('续写：selection 为空时用光标前尾部 ~500 字，不输出待处理文本块', () => {
    const before = '甲'.repeat(2000);
    const prompt = buildInlineEditPrompt('continue', '', { chapter: 2, before, after: '无关后文' });
    expect(prompt).toContain('【光标前文】');
    expect(prompt).toContain('甲'.repeat(INLINE_CONTINUE_TAIL_CHARS));
    expect(prompt).not.toContain('甲'.repeat(INLINE_CONTINUE_TAIL_CHARS + 1));
    // 续写不吃选区后文
    expect(prompt).not.toContain('无关后文');
    expect(prompt).not.toContain('待');
    expect(prompt).toContain('结尾处继续写');
  });

  it('上下文全空时省略上下文块（章节开头场景）', () => {
    const prompt = buildInlineEditPrompt('polish', '片段。', { chapter: 1 });
    expect(prompt).not.toContain('【');
    expect(prompt).toContain('待润色文本');
    expect(prompt).toContain('片段。');
  });
});

describe('splitParagraphs / joinParagraphs', () => {
  it('按空行切段落：trim、去空段、归一化换行', () => {
    expect(splitParagraphs('第一段。\n\n\n  第二段。 \n\n\n第三段。')).toEqual(['第一段。', '第二段。', '第三段。']);
    expect(splitParagraphs('第一段。\r\n\r\n第二段。')).toEqual(['第一段。', '第二段。']);
    // 段内软换行保留为一个段落
    expect(splitParagraphs('一行\n两行')).toEqual(['一行\n两行']);
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('\n\n \n')).toEqual([]);
  });

  it('joinParagraphs 与 splitParagraphs 互逆', () => {
    const paras = ['一', '二', '三'];
    expect(splitParagraphs(joinParagraphs(paras))).toEqual(paras);
  });
});

describe('planParagraphMerge', () => {
  it('原文为空（续写）→ 全部 appended', () => {
    const plan = planParagraphMerge([], ['新段一。', '新段二。']);
    expect(plan.whole).toBeNull();
    expect(plan.replaced).toEqual([]);
    expect(plan.appended).toEqual(['新段一。', '新段二。']);
  });

  it('段落数相近 → 原位替换变更段，未变段不出现', () => {
    const orig = ['一', '二', '三'];
    const next = ['一', '二改', '三'];
    const plan = planParagraphMerge(orig, next);
    expect(plan.whole).toBeNull();
    expect(plan.appended).toEqual([]);
    expect(plan.replaced).toEqual([{ index: 1, from: '二', to: '二改' }]);
  });

  it('新增段落 → 变更段原位替换，多出的段落 appended', () => {
    const plan = planParagraphMerge(['一', '二'], ['一', '二', '三', '四']);
    expect(plan.whole).toBeNull();
    expect(plan.replaced).toEqual([]);
    expect(plan.appended).toEqual(['三', '四']);
  });

  it('完全一致 → 空计划', () => {
    const plan = planParagraphMerge(['一', '二'], ['一', '二']);
    expect(plan).toEqual({ whole: null, replaced: [], appended: [] });
  });

  it('段落数剧变（>2 倍）→ 整体替换', () => {
    const orig = ['一', '二', '三', '四'];
    const next = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const plan = planParagraphMerge(orig, next);
    expect(plan.whole).toEqual({ from: joinParagraphs(orig), to: joinParagraphs(next) });
    expect(plan.replaced).toEqual([]);
    expect(plan.appended).toEqual([]);
  });

  it('段落数剧变（不足一半）→ 整体替换', () => {
    const plan = planParagraphMerge(['一', '二', '三', '四', '五'], ['只剩一段']);
    expect(plan.whole).toEqual({ from: '一\n\n二\n\n三\n\n四\n\n五', to: '只剩一段' });
  });

  it('结果为空 → 整体替换为空文本', () => {
    const plan = planParagraphMerge(['一', '二'], []);
    expect(plan.whole).toEqual({ from: '一\n\n二', to: '' });
  });

  it('恰在 2 倍边界不判剧变（配对仍有意义）', () => {
    const plan = planParagraphMerge(['一', '二'], ['一', '二', '三', '四']);
    expect(plan.whole).toBeNull();
    expect(plan.appended).toEqual(['三', '四']);
  });
});

describe('applyParagraphMerge / mergeInlineResult', () => {
  it('原位替换 + 追加：未变段落原样保留', () => {
    const orig = splitParagraphs('一\n\n二\n\n三');
    const plan = planParagraphMerge(orig, splitParagraphs('一\n\n二改\n\n三\n\n四'));
    expect(applyParagraphMerge(orig, plan)).toBe('一\n\n二改\n\n三\n\n四');
  });

  it('整体替换计划直接产出新文本', () => {
    const orig = splitParagraphs('一\n\n二\n\n三\n\n四');
    const plan = planParagraphMerge(orig, splitParagraphs('只有一段了'));
    expect(applyParagraphMerge(orig, plan)).toBe('只有一段了');
  });

  it('mergeInlineResult：续写（原文空）→ 追加段落拼接', () => {
    expect(mergeInlineResult('', '新段一。\n\n新段二。')).toBe('新段一。\n\n新段二。');
  });

  it('mergeInlineResult：常规润色等价于规范化后的结果文本', () => {
    expect(mergeInlineResult('原文一\n\n原文二', ' 原文一改 \n\n\n原文二\n\n\n')).toBe('原文一改\n\n原文二');
  });
});
