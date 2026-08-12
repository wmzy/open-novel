/**
 * 意图卡纯函数测试。
 * 来源：intent-card 功能（2026-08-13 规格）。
 * 归并建议：后续意图卡相关纯函数（如意图符合度解析）可继续追加本文件。
 */
import { describe, it, expect } from 'vitest';
import { buildIntentSkeleton, mergeIntentSections, INTENT_DIMENSIONS } from '../../../src/shared/intent-card';

describe('buildIntentSkeleton', () => {
  it('无输入时生成 8 个维度全部「未设定」的骨架', () => {
    const skeleton = buildIntentSkeleton();
    expect(skeleton).toContain('# 作者意图卡');
    for (const dim of INTENT_DIMENSIONS) {
      expect(skeleton).toContain(`## ${dim.title}`);
    }
    expect(skeleton.match(/未设定/g)?.length).toBeGreaterThanOrEqual(8);
    // 无输入时每个维度小节都应含至少一个「未设定」条目
    expect(skeleton.split('## ').length - 1).toBe(8);
  });

  it('表单提供值的维度以自由文本写入，其余维度保持「未设定」', () => {
    const skeleton = buildIntentSkeleton({ pacing: '每章 4000 字，张弛有度' });
    const pacingSection = skeleton.slice(skeleton.indexOf('## 节奏偏好'), skeleton.indexOf('## 角色权重'));
    expect(pacingSection).toContain('每章 4000 字，张弛有度');
    // 其他维度仍为未设定
    expect(skeleton).toContain('核心角色（弧线优先）：未设定');
  });

  it('空字符串维度按未提供处理', () => {
    const skeleton = buildIntentSkeleton({ pacing: '  ' });
    expect(skeleton).toContain('每章字数：未设定');
  });

  it('超过 500 字的维度值截断到 500 字', () => {
    const long = '字'.repeat(600);
    const skeleton = buildIntentSkeleton({ pacing: long });
    const pacingSection = skeleton.slice(skeleton.indexOf('## 节奏偏好'), skeleton.indexOf('## 角色权重'));
    expect(pacingSection).toContain('字'.repeat(500));
    expect(pacingSection).not.toContain('字'.repeat(501));
  });
});

describe('mergeIntentSections', () => {
  const base = [
    '# 作者意图卡',
    '',
    '> 本文件记录作者的创作意图与偏好。',
    '',
    '## 节奏偏好',
    '',
    '每章 4000 字',
    '',
    '## 角色权重',
    '',
    '- 核心角色（弧线优先）：未设定',
  ].join('\n');

  it('只更新目标维度小节，其他小节原样保留', () => {
    const merged = mergeIntentSections(base, { 角色权重: '- 核心角色（弧线优先）：林冲' });
    expect(merged).toContain('## 节奏偏好');
    expect(merged).toContain('每章 4000 字');
    expect(merged).toContain('## 角色权重');
    expect(merged).toContain('林冲');
    expect(merged).not.toContain('核心角色（弧线优先）：未设定');
    // 文档头保留
    expect(merged).toContain('# 作者意图卡');
  });

  it('更新不存在的维度时追加到末尾', () => {
    const merged = mergeIntentSections(base, { 伏笔风格: '- 长线/短线配比：1:3' });
    expect(merged.indexOf('## 节奏偏好')).toBeLessThan(merged.indexOf('## 伏笔风格'));
    expect(merged).toContain('- 长线/短线配比：1:3');
  });

  it('空 updates 返回原文', () => {
    expect(mergeIntentSections(base, {})).toBe(base);
  });

  it('current 为空字符串时生成仅含更新节的文档', () => {
    const merged = mergeIntentSections('', { 节奏偏好: '每章 5000 字' });
    expect(merged.trim()).toBe('## 节奏偏好\n\n每章 5000 字');
  });
});
