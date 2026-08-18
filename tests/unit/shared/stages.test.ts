// 注：本文件随「样章门 + deepen 收敛」工作包新增——此前 shared/stages 无专属测试文件。
// 归并建议：若后续出现统一的 shared 工作流测试模块，可将本文件并入。
import { describe, it, expect } from 'vitest';
import {
  STAGES,
  stageToView,
  viewToStage,
  getStageIndex,
  getNextStage,
  isWritingStage,
  ALL_VIEWS,
} from '../../../src/shared/stages';

describe('shared/stages', () => {
  describe('STAGES 七阶段顺序', () => {
    it('sample 插入 scenes 与 writing 之间', () => {
      const ids = STAGES.map((s) => s.id);
      expect(ids).toEqual(['concept', 'world', 'characters', 'outline', 'scenes', 'sample', 'writing']);
    });

    it('sample order 为 5，writing 顺延为 6', () => {
      expect(STAGES.find((s) => s.id === 'sample')?.order).toBe(5);
      expect(STAGES.find((s) => s.id === 'writing')?.order).toBe(6);
    });

    it('sample 阶段 label 为「样章」', () => {
      expect(STAGES.find((s) => s.id === 'sample')?.label).toBe('样章');
    });
  });

  describe('isWritingStage', () => {
    it('sample 为写作型阶段（需注入写作分层上下文）', () => {
      expect(isWritingStage('sample')).toBe(true);
    });

    it('writing 及其子模式为写作型阶段', () => {
      expect(isWritingStage('writing')).toBe(true);
      expect(isWritingStage('drafting')).toBe(true);
      expect(isWritingStage('revision')).toBe(true);
      expect(isWritingStage('polish')).toBe(true);
    });

    it('规划阶段不是写作型阶段', () => {
      expect(isWritingStage('concept')).toBe(false);
      expect(isWritingStage('world')).toBe(false);
      expect(isWritingStage('characters')).toBe(false);
      expect(isWritingStage('outline')).toBe(false);
      expect(isWritingStage('scenes')).toBe(false);
    });
  });

  describe('派生映射', () => {
    it('getNextStage：scenes → sample → writing', () => {
      expect(getNextStage('scenes')).toBe('sample');
      expect(getNextStage('sample')).toBe('writing');
    });

    it('getStageIndex 反映插入后的索引', () => {
      expect(getStageIndex('scenes')).toBe(4);
      expect(getStageIndex('sample')).toBe(5);
      expect(getStageIndex('writing')).toBe(6);
    });

    it('stageToView / viewToStage 覆盖 sample', () => {
      expect(stageToView['sample']).toBe('sample');
      expect(viewToStage['sample']).toBe('sample');
    });

    it('ALL_VIEWS 侧边栏包含样章节点', () => {
      expect(ALL_VIEWS.some((v) => v.id === 'sample' && v.label === '样章')).toBe(true);
    });
  });
});
