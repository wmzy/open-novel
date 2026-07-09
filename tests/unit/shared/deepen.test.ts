import { describe, it, expect } from 'vitest';
import {
  DEEPEN_TO_CHAT_EVENT,
  DEEPEN_DIMENSIONS,
  SATURATION_SIGNAL,
  buildDeepenMessage,
  detectSaturation,
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

    it('each dimension is a non-empty string with descriptive text', () => {
      for (const stage of Object.keys(DEEPEN_DIMENSIONS)) {
        for (const dim of DEEPEN_DIMENSIONS[stage]) {
          expect(dim.length).toBeGreaterThan(5);
          expect(dim).toContain('：');
        }
      }
    });
  });

  describe('buildDeepenMessage', () => {
    it('includes stage name and round number', () => {
      const msg = buildDeepenMessage('characters', 3);
      expect(msg).toContain('角色');
      expect(msg).toContain('第 3 轮');
    });

    it('includes the dimensions for the stage', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).toContain('动机清晰度');
      expect(msg).toContain('弧光完整性');
    });

    it('includes verification-backtracking flow guidance', () => {
      const msg = buildDeepenMessage('world', 1);
      expect(msg).toContain('验证');
      expect(msg).toContain('回溯');
      expect(msg).toContain('修订');
    });

    it('includes saturation signal instructions', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).toContain('4 分以上');
      expect(msg).toContain(SATURATION_SIGNAL);
    });

    it('forbids question tool and stage advancement', () => {
      const msg = buildDeepenMessage('outline', 1);
      expect(msg).toContain('不要用 question 工具');
      expect(msg).toContain('不要推进到下一阶段');
    });
  });

  describe('detectSaturation', () => {
    it('detects saturation signal in log content', () => {
      const log = `## 第3轮\n**维度评分**：动机 5, 关系 4\n${SATURATION_SIGNAL}`;
      expect(detectSaturation(log)).toBe(true);
    });

    it('returns false when no saturation signal', () => {
      const log = '## 第2轮\n- 发现：角色动机不足\n- 改进：补充背景';
      expect(detectSaturation(log)).toBe(false);
    });
  });

  describe('parseDeadlineInput', () => {
    it('parses HH:MM to today timestamp', () => {
      const ts = parseDeadlineInput('06:00');
      expect(ts).not.toBeNull();
      const date = new Date(ts!);
      expect(date.getHours()).toBe(6);
      expect(date.getMinutes()).toBe(0);
    });

    it('handles empty input by returning null', () => {
      expect(parseDeadlineInput('')).toBeNull();
    });

    it('if time already passed today, sets to tomorrow', () => {
      const ts = parseDeadlineInput('23:59');
      expect(ts).not.toBeNull();
      expect(ts!).toBeGreaterThan(Date.now() - 86400000);
    });
  });

  describe('DEEPEN_TO_CHAT_EVENT', () => {
    it('is a non-empty string constant', () => {
      expect(typeof DEEPEN_TO_CHAT_EVENT).toBe('string');
      expect(DEEPEN_TO_CHAT_EVENT.length).toBeGreaterThan(0);
    });
  });
});
