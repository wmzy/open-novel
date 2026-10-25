import { describe, it, expect } from 'vitest';
import { summarizeExtractive } from '../../../src/shared/extractive-summary';

describe('summarizeExtractive（确定性抽取式摘要）', () => {
  it('同输入同输出（无随机）', () => {
    const body = '林青推开客栈的门。风雪灌了进来。他抖落肩上的雪，环视大堂。掌柜递来一封密信。';
    expect(summarizeExtractive(body, 50)).toBe(summarizeExtractive(body, 50));
  });

  it('未超预算时保留全部句子（含句末标点，顺序不变）', () => {
    const body = '林青在客栈里发现了密信。窗外的风雪越来越大。';
    expect(summarizeExtractive(body, 100)).toBe(body);
  });

  it('CJK 多句：按分选句、保持原文语序、长度不超上限', () => {
    const body = [
      '林青在客栈里发现了密信。', // 高频：林青/密信
      '窗外的风雪越来越大。',
      '林青把密信藏进袖中。', // 高频：林青/密信
      '远处传来更夫的梆子声。', // 低频 + 最靠后 → 预算不足时最先出局
    ].join('');
    const out = summarizeExtractive(body, 40);
    expect(out).toContain('林青在客栈里发现了密信。');
    expect(out).toContain('林青把密信藏进袖中。');
    // 原文语序：发现在前、藏进在后
    expect(out.indexOf('发现了密信')).toBeLessThan(out.indexOf('藏进袖中'));
    // 低频尾句被裁掉
    expect(out).not.toContain('梆子声');
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('。')).toBe(true);
  });

  it('词频优先于位置：高重复关键词的后句可反超前句入选', () => {
    const body = '无风的夜晚十分安静。林青想起林青的师父说过林青的刀。';
    // maxChars=16：只能装下一句；第二句因「林青」×3 词频更高而胜出
    const out = summarizeExtractive(body, 16);
    expect(out).toBe('林青想起林青的师父说过林青的刀。');
  });

  it('空输入与空白输入返回空串', () => {
    expect(summarizeExtractive('', 100)).toBe('');
    expect(summarizeExtractive('   \n\t  ', 100)).toBe('');
  });

  it('maxChars 为 0 时返回空串', () => {
    expect(summarizeExtractive('一句话。', 0)).toBe('');
  });

  it('纯英文：无中文分句标点，整段视为一句、超长回退截断补省略号', () => {
    const body = 'The wind rose over the northern mountains.';
    const out = summarizeExtractive(body, 10);
    expect(out).toBe('The wind r…');
  });

  it('无标点长文本回退截断（与旧占位摘要行为一致：maxChars 字 + 省略号）', () => {
    const out = summarizeExtractive('甲'.repeat(300), 200);
    expect(out).toBe('甲'.repeat(200) + '…');
  });

  it('单句不超预算时原样返回', () => {
    expect(summarizeExtractive('一句话。', 200)).toBe('一句话。');
  });

  it('换行/连续空白折叠为单空格（分句前归一化）', () => {
    const body = '第一句。\n\n第二句。  第三句。';
    const out = summarizeExtractive(body, 100);
    expect(out).toBe('第一句。第二句。第三句。');
  });
});
