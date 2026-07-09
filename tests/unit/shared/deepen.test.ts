import { describe, it, expect } from 'vitest';
import {
  DEEPEN_TO_CHAT_EVENT,
  DEEPEN_DIMENSIONS,
  DEEPEN_MIN_ROUNDS,
  NO_IMPROVEMENT_SIGNAL,
  buildDeepenMessage,
  isCritiqueRound,
  detectNoImprovement,
  parseDeadlineInput,
} from '../../../src/shared/deepen';

describe('deepen', () => {
  describe('DEEPEN_DIMENSIONS', () => {
    it('has dimensions for all 5 planning stages', () => {
      const stages = ['concept', 'world', 'characters', 'outline', 'scenes'];
      for (const stage of stages) {
        expect(DEEPEN_DIMENSIONS[stage]).toBeDefined();
        expect(DEEPEN_DIMENSIONS[stage].length).toBeGreaterThanOrEqual(4);
      }
    });
  });

  describe('DEEPEN_MIN_ROUNDS', () => {
    it('is at least 4 (2 critique + 2 revise cycles)', () => {
      expect(DEEPEN_MIN_ROUNDS).toBeGreaterThanOrEqual(4);
    });
  });

  describe('isCritiqueRound', () => {
    it('returns true for odd rounds (1, 3, 5, 7)', () => {
      expect(isCritiqueRound(1)).toBe(true);
      expect(isCritiqueRound(3)).toBe(true);
      expect(isCritiqueRound(5)).toBe(true);
      expect(isCritiqueRound(7)).toBe(true);
    });

    it('returns false for even rounds (2, 4, 6, 8)', () => {
      expect(isCritiqueRound(2)).toBe(false);
      expect(isCritiqueRound(4)).toBe(false);
      expect(isCritiqueRound(6)).toBe(false);
      expect(isCritiqueRound(8)).toBe(false);
    });
  });

  describe('buildDeepenMessage - Critique rounds (odd)', () => {
    it('includes "审查轮" marker for round 1', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).toContain('审查轮');
      expect(msg).toContain('独立审查者');
    });

    it('includes stage name and round number', () => {
      const msg = buildDeepenMessage('characters', 3);
      expect(msg).toContain('角色');
      expect(msg).toContain('第 3 轮');
    });

    it('includes dimensions for scoring', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).toContain('动机清晰度');
      expect(msg).toContain('弧光完整性');
    });

    it('forbids reading deepen-log (blind review isolation)', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).toContain('不要读 .novel/deepen-log.md');
      expect(msg).toContain('盲审');
    });

    it('forbids modifying output files', () => {
      const msg = buildDeepenMessage('world', 1);
      expect(msg).toContain('不要修改产出文件');
      expect(msg).toContain('只读不写');
    });

    it('forbids PATCH stage update and question tool', () => {
      const msg = buildDeepenMessage('outline', 1);
      expect(msg).toContain('不要调用 PATCH');
      expect(msg).toContain('不要用 question 工具');
    });

    it('includes NO_IMPROVEMENT_SIGNAL instructions', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).toContain(NO_IMPROVEMENT_SIGNAL);
    });

    it('writes critique to deepen-critique.md', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).toContain('deepen-critique.md');
    });

    it('rotates critique perspectives across rounds', () => {
      const msg1 = buildDeepenMessage('characters', 1);
      const msg3 = buildDeepenMessage('characters', 3);
      // Round 1 and round 3 should have different perspectives
      const p1 = msg1.split('## 你的审查视角\n')[1]?.split('\n')[0] || '';
      const p3 = msg3.split('## 你的审查视角\n')[1]?.split('\n')[0] || '';
      expect(p1).not.toBe(p3);
    });

    it('includes user hint when provided', () => {
      const msg = buildDeepenMessage('characters', 1, '增加更多女性角色');
      expect(msg).toContain('用户特别指导');
      expect(msg).toContain('增加更多女性角色');
    });

    it('omits hint section when no user hint', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).not.toContain('用户特别指导');
    });
  });

  describe('buildDeepenMessage - Revise rounds (even)', () => {
    it('includes "修订轮" marker for round 2', () => {
      const msg = buildDeepenMessage('characters', 2);
      expect(msg).toContain('修订轮');
      expect(msg).toContain('作者');
    });

    it('reads deepen-critique.md for feedback', () => {
      const msg = buildDeepenMessage('characters', 2);
      expect(msg).toContain('deepen-critique.md');
      expect(msg).toContain('审查者对你的产出的批评');
    });

    it('reads deepen-log.md for history', () => {
      const msg = buildDeepenMessage('characters', 2);
      expect(msg).toContain('deepen-log.md');
    });

    it('encourages creating new content', () => {
      const msg = buildDeepenMessage('characters', 2);
      expect(msg).toContain('扩展新内容');
      expect(msg).toContain('创建');
    });

    it('forbids PATCH stage update', () => {
      const msg = buildDeepenMessage('outline', 4);
      expect(msg).toContain('不要调用 PATCH');
    });

    it('includes user hint when provided', () => {
      const msg = buildDeepenMessage('characters', 2, '加强反派动机');
      expect(msg).toContain('加强反派动机');
    });
  });

  describe('detectNoImprovement', () => {
    it('detects NO_IMPROVEMENT_SIGNAL in critique content', () => {
      const content = `# 审查报告\n**维度评分**：动机 5\n${NO_IMPROVEMENT_SIGNAL}`;
      expect(detectNoImprovement(content)).toBe(true);
    });

    it('returns false when no signal present', () => {
      const content = '# 审查报告\n- 问题1：角色动机不足';
      expect(detectNoImprovement(content)).toBe(false);
    });
  });

  describe('parseDeadlineInput', () => {
    it('parses HH:MM to timestamp', () => {
      const ts = parseDeadlineInput('06:00');
      expect(ts).not.toBeNull();
      expect(new Date(ts!).getHours()).toBe(6);
    });

    it('handles empty input', () => {
      expect(parseDeadlineInput('')).toBeNull();
    });
  });

  describe('DEEPEN_TO_CHAT_EVENT', () => {
    it('is a non-empty string', () => {
      expect(typeof DEEPEN_TO_CHAT_EVENT).toBe('string');
      expect(DEEPEN_TO_CHAT_EVENT.length).toBeGreaterThan(0);
    });
  });
});
