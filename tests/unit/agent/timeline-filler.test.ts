import { describe, it, expect } from 'vitest';
import { buildFillPrompt, parseAiResponse, type FillChapterInput } from '../../../src/agent/timeline-filler';

describe('buildFillPrompt', () => {
  it('生成含 POV / 核心事件 / 出场角色的 prompt', () => {
    const input: FillChapterInput = {
      number: 3,
      title: '关卡',
      pov: '武松',
      coreEvent: '在客栈因无通行凭证被盘问',
      cast: ['武松', '何九叔'],
    };
    const prompt = buildFillPrompt(input);
    expect(prompt).toContain('武松');
    expect(prompt).toContain('何九叔');
    expect(prompt).toContain('通行凭证');
    expect(prompt).toContain('主动方→被动方[类型]：动作');
    // 列出 9 种类型
    expect(prompt).toContain('冲突');
    expect(prompt).toContain('重逢');
    expect(prompt).toContain('离别');
  });

  it('独角戏章节（cast 仅 1 人）提示返回（无）', () => {
    const input: FillChapterInput = {
      number: 1,
      title: '独角戏',
      pov: '武松',
      coreEvent: '备战',
      cast: ['武松'],
    };
    const prompt = buildFillPrompt(input);
    expect(prompt).toContain('（无）');
  });
});

describe('parseAiResponse', () => {
  it('提取符合格式的交互行（去除 AI 啰嗦的前后文）', () => {
    const aiOutput =
      '好的，分析如下：\n武松→何九叔[冲突]：被盘问 · 何九叔→武松[善意]：出手相助\n以上是交互。';
    const parsed = parseAiResponse(aiOutput);
    expect(parsed).toBe('武松→何九叔[冲突]：被盘问 · 何九叔→武松[善意]：出手相助');
  });

  it('AI 返回（无）时透传', () => {
    expect(parseAiResponse('（无）')).toBe('（无）');
  });

  it('AI 返回纯文本无格式时返回空串', () => {
    expect(parseAiResponse('本章没有交互')).toBe('');
  });
});
