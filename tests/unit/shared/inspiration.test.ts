import { describe, it, expect } from 'vitest';
import {
  buildInspirationMessage,
  buildCharacterEnrichMessage,
  ENRICH_DIRECTION_LABELS,
  type EnrichDirection,
} from '../../../src/shared/inspiration';

describe('buildInspirationMessage', () => {
  // 共用片段断言——所有维度都须包含
  const COMMON_PATTERNS = [
    '跳过采访流程',
    '不要写完整档案',
    '避免和已有角色重名',
    '我挑中后再展开',
  ];

  describe('faction 维度', () => {
    it('注入势力名 + 共用片段', () => {
      const msg = buildInspirationMessage('faction', { faction: '明教' });
      expect(msg).toContain('隶属「明教」');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });

    it('缺 faction 参数抛错', () => {
      expect(() => buildInspirationMessage('faction', {})).toThrow('faction');
    });
  });

  describe('archetype 维度', () => {
    it('注入原型名 + 不照搬历史 + 共用片段', () => {
      const msg = buildInspirationMessage('archetype', { archetype: '诸葛亮' });
      expect(msg).toContain('以「诸葛亮」为蓝本');
      expect(msg).toContain('不要照搬历史事迹');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });

    it('原型留空则由 AI 自由发挥', () => {
      const msg = buildInspirationMessage('archetype', {});
      expect(msg).toContain('由你挑选');
      expect(msg).toContain('标注参考了谁');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });
  });

  describe('role 维度', () => {
    it('注入功能定位 + 共用片段', () => {
      const msg = buildInspirationMessage('role', { role: '导师' });
      expect(msg).toContain('承担「导师」的叙事功能');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });

    it('缺 role 参数抛错', () => {
      expect(() => buildInspirationMessage('role', {})).toThrow('role');
    });
  });

  describe('triangle 维度', () => {
    it('标注三角组合 + 共用片段，无需参数', () => {
      const msg = buildInspirationMessage('triangle');
      expect(msg).toContain('驱动力三角（Want/Need/Wound）各不相同');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });
  });

  describe('tension 维度', () => {
    it('注入目标角色 + 关系类型 + 共用片段', () => {
      const msg = buildInspirationMessage('tension', {
        tension: { target: '林冲', type: '敌对' },
      });
      expect(msg).toContain('与「林冲」产生「敌对」关系');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });

    it('缺 target 抛错', () => {
      expect(() => buildInspirationMessage('tension', { tension: { target: '', type: '敌对' } })).toThrow('tension');
    });

    it('缺 type 抛错', () => {
      expect(() => buildInspirationMessage('tension', { tension: { target: '林冲', type: '' as never } })).toThrow('tension');
    });
  });

  describe('random 维度', () => {
    it('风格差异最大 + 共用片段，无需参数', () => {
      const msg = buildInspirationMessage('random');
      expect(msg).toContain('风格差异最大');
      for (const p of COMMON_PATTERNS) expect(msg).toContain(p);
    });
  });
});

describe('buildCharacterEnrichMessage', () => {
  // 丰富现有角色，不生成新角色种子，共用片段不同
  const ENRICH_PATTERNS = [
    '跳过采访流程',
    '不要改写现有档案',
    '我挑中后再展开',
  ];

  it.each(Object.keys(ENRICH_DIRECTION_LABELS) as EnrichDirection[])(
    '%s 方向：注入角色名 + 方向说明 + 丰富共用片段',
    (dir) => {
      const msg = buildCharacterEnrichMessage('林冲', dir);
      expect(msg).toContain('林冲');
      expect(msg).toContain(ENRICH_DIRECTION_LABELS[dir]);
      for (const p of ENRICH_PATTERNS) expect(msg).toContain(p);
    },
  );

  it('角色名留空抛错', () => {
    expect(() => buildCharacterEnrichMessage('  ', 'deeds')).toThrow('角色名');
  });
});
