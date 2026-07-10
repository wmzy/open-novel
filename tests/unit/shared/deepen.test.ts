import { describe, it, expect } from 'vitest';
import {
  DEEPEN_TO_CHAT_EVENT,
  DEEPEN_DIMENSIONS,
  DEEPEN_MIN_ROUNDS,
  DEEPEN_MAX_ROUNDS,
  NO_IMPROVEMENT_SIGNAL,
  buildDeepenMessage,
  isCritiqueRound,
  detectNoImprovement,
  parseDeadlineInput,
  parseLatestScores,
  extractScoreTrajectory,
  trimHistory,
  STAGE_OUTPUT_FILES,
  estimateTokens,
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

  describe('DEEPEN_MAX_ROUNDS', () => {
    it('is a reasonable upper bound (even number, >= 10)', () => {
      expect(DEEPEN_MAX_ROUNDS).toBeGreaterThanOrEqual(10);
      expect(DEEPEN_MAX_ROUNDS % 2).toBe(0); // 偶数：完整的 Critique-Revise 对
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
      expect(msg).toContain('审查报告');
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

  describe('parseLatestScores', () => {
    it('extracts latest score line from revise rounds', () => {
      const log = [
        '## 第2轮（修订）',
        '**回应的批评**：问题1→改进',
        '**维度评分变化**：动机清晰度 3→4, 关系丰富度 2→3',
        '**下轮建议**：差异化声音仍可加强',
        '',
        '## 第4轮（修订）',
        '**维度评分变化**：动机清晰度 4→5, 关系丰富度 3→4',
      ].join('\n');
      expect(parseLatestScores(log)).toBe('动机清晰度 4→5, 关系丰富度 3→4');
    });

    it('also matches plain "维度评分" without "变化"', () => {
      const log = '## 第1轮\n**维度评分**：动机 3, 关系 4';
      expect(parseLatestScores(log)).toBe('动机 3, 关系 4');
    });

    it('returns null when no scores found', () => {
      expect(parseLatestScores('没有评分的日志')).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(parseLatestScores('')).toBeNull();
    });
  });

  describe('buildDeepenMessage - plugin dimensions', () => {
    it('uses plugin dimensions when provided for the stage', () => {
      const customDims = {
        characters: ['功法-性格一致性：测试维度'],
      };
      const msg = buildDeepenMessage('characters', 1, undefined, customDims);
      expect(msg).toContain('功法-性格一致性');
      // 当 plugin 提供了自定义维度时，不包含通用维度
      expect(msg).not.toContain('动机清晰度');
    });

    it('falls back to default when plugin has no custom for this stage', () => {
      const customDims = { world: ['武学体系自洽'] };
      const msg = buildDeepenMessage('characters', 1, undefined, customDims);
      expect(msg).toContain('动机清晰度');
    });

    it('falls back to default when no plugin dimensions provided', () => {
      const msg = buildDeepenMessage('characters', 1);
      expect(msg).toContain('动机清晰度');
    });

    it('revise rounds are unaffected by plugin dimensions', () => {
      const customDims = { characters: ['测试维度'] };
      const msg = buildDeepenMessage('characters', 2, undefined, customDims);
      // 修订轮不列维度清单
      expect(msg).toContain('修订轮');
    });
  });

  describe('buildDeepenMessage - cross-stage critique', () => {
    it('characters includes cross-stage perspective referencing world-building', () => {
      // characters 有 5 个视角（原 4 + 跨阶段 1），第 9 轮是第 5 个 critique（索引 4）
      const msg = buildDeepenMessage('characters', 9);
      expect(msg).toContain('跨阶段一致性审计师');
      expect(msg).toContain('world-building.md');
    });

    it('world includes cross-stage perspective referencing characters', () => {
      const msg = buildDeepenMessage('world', 9);
      expect(msg).toContain('跨阶段一致性审计师');
      expect(msg).toContain('profiles.md');
    });

    it('outline includes cross-stage perspective referencing characters', () => {
      const msg = buildDeepenMessage('outline', 9);
      expect(msg).toContain('跨阶段一致性审计师');
      expect(msg).toContain('profiles.md');
    });

    it('scenes includes cross-stage perspective referencing outline', () => {
      const msg = buildDeepenMessage('scenes', 7);
      // scenes 有 3 个原视角 + 1 跨阶段 = 4 个，第 7 轮是第 4 个 critique（索引 3）
      expect(msg).toContain('跨阶段一致性审计师');
      expect(msg).toContain('outline');
    });

    it('concept includes cross-stage perspective', () => {
      // concept 有 3 个原视角 + 1 跨阶段 = 4 个，第 7 轮是第 4 个 critique（索引 3）
      const msg = buildDeepenMessage('concept', 7);
      expect(msg).toContain('跨阶段一致性审计师');
    });

    it('each stage has at least one cross-stage perspective in full rotation', () => {
      for (const stage of ['characters', 'world', 'outline', 'scenes', 'concept']) {
        let found = false;
        // 遍历足够多的 critique 轮覆盖所有视角
        for (let r = 1; r <= 19; r += 2) {
          const msg = buildDeepenMessage(stage, r);
          if (msg.includes('跨阶段一致性审计师')) {
            found = true;
            break;
          }
        }
        expect(found, `stage ${stage} should have cross-stage perspective`).toBe(true);
      }
    });

    it('cross-stage perspective instructs reading other stage files', () => {
      // 跨阶段视角应该指示读取其他阶段的文件
      const msg = buildDeepenMessage('characters', 9);
      expect(msg).toContain('先读取');
    });
  });

  describe('trimHistory', () => {
    it('returns history as-is when within keepHead + keepTail', () => {
      const history = [
        { role: 'user', content: 'critique-1' },
        { role: 'assistant', content: 'response-1' },
        { role: 'user', content: 'revise-2' },
      ];
      const result = trimHistory(history);
      expect(result).toBe(history); // 同一引用
      expect(result.length).toBe(3);
    });

    it('returns history as-is when exactly at keepHead + keepTail boundary', () => {
      // keepHead=2 + keepTail=6 = 8 条，恰好不触发截断
      const history = Array.from({ length: 8 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${i}`,
      }));
      const result = trimHistory(history);
      expect(result).toBe(history);
    });

    it('folds middle messages when exceeding window', () => {
      const history = Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${i}`,
      }));
      // keepHead=2 + keepTail=6 = 8 条保留 + 1 条占位 = 9
      const result = trimHistory(history);
      expect(result.length).toBe(9);

      // 首轮保留
      expect(result[0].content).toBe('msg-0');
      expect(result[1].content).toBe('msg-1');

      // 中间折叠为占位
      expect(result[2].role).toBe('system');
      expect(result[2].content).toContain('对话历史已折叠');
      expect(result[2].content).toContain('4'); // 12 - 8 = 4 条被省略

      // 尾部保留最近 6 条
      expect(result[3].content).toBe('msg-6');
      expect(result[8].content).toBe('msg-11');
    });

    it('custom keepHead and keepTail', () => {
      const history = Array.from({ length: 10 }, (_, i) => ({
        role: 'user',
        content: `msg-${i}`,
      }));
      const result = trimHistory(history, 1, 2);
      expect(result.length).toBe(4); // 1 head + 1 placeholder + 2 tail
      expect(result[0].content).toBe('msg-0');
      expect(result[1].role).toBe('system');
      expect(result[2].content).toBe('msg-8');
      expect(result[3].content).toBe('msg-9');
    });

    it('empty history returns empty', () => {
      expect(trimHistory([])).toEqual([]);
    });

    it('placeholder references deepen-log and deepen-critique', () => {
      const history = Array.from({ length: 10 }, (_, i) => ({
        role: 'user',
        content: `msg-${i}`,
      }));
      const result = trimHistory(history);
      expect(result[2].content).toContain('deepen-log.md');
      expect(result[2].content).toContain('deepen-critique.md');
    });

    it('appends contextNote to placeholder when provided', () => {
      const history = Array.from({ length: 10 }, (_, i) => ({
        role: 'user',
        content: `msg-${i}`,
      }));
      const note = '评分轨迹：动机清晰度 3→4 → 4→5';
      const result = trimHistory(history, 2, 6, note);
      expect(result[2].content).toContain('deepen-log.md');
      expect(result[2].content).toContain(note);
    });

    it('omits contextNote gracefully when undefined', () => {
      const history = Array.from({ length: 10 }, (_, i) => ({
        role: 'user',
        content: `msg-${i}`,
      }));
      const result = trimHistory(history, 2, 6, undefined);
      expect(result[2].content).not.toContain('评分轨迹');
    });
  });

  describe('STAGE_OUTPUT_FILES', () => {
    it('maps all 5 planning stages to at least one file', () => {
      const stages = ['concept', 'world', 'characters', 'outline', 'scenes'];
      for (const stage of stages) {
        expect(STAGE_OUTPUT_FILES[stage]).toBeDefined();
        expect(STAGE_OUTPUT_FILES[stage].length).toBeGreaterThanOrEqual(1);
      }
    });

    it('concept maps to concept.md', () => {
      expect(STAGE_OUTPUT_FILES.concept).toContain('concept.md');
    });

    it('characters maps to characters/profiles.md', () => {
      expect(STAGE_OUTPUT_FILES.characters).toContain('characters/profiles.md');
    });

    it('outline includes fallback files', () => {
      expect(STAGE_OUTPUT_FILES.outline).toContain('outline-detailed.md');
      expect(STAGE_OUTPUT_FILES.outline).toContain('outline-brief.md');
    });
  });

  describe('extractScoreTrajectory', () => {
    it('extracts multiple score lines joined by arrow', () => {
      const log = [
        '## 第2轮（修订）',
        '**维度评分变化**：动机清晰度 3→4, 关系丰富度 2→3',
        '## 第4轮（修订）',
        '**维度评分变化**：动机清晰度 4→5, 关系丰富度 3→4',
      ].join('\n');
      const result = extractScoreTrajectory(log);
      expect(result).toBe('动机清晰度 3→4, 关系丰富度 2→3 → 动机清晰度 4→5, 关系丰富度 3→4');
    });

    it('returns null when no score lines exist', () => {
      expect(extractScoreTrajectory('no scores here')).toBeNull();
    });

    it('returns null for empty content', () => {
      expect(extractScoreTrajectory('')).toBeNull();
    });

    it('handles single score line', () => {
      const log = '**维度评分**：动机清晰度 3';
      expect(extractScoreTrajectory(log)).toBe('动机清晰度 3');
    });
  });

  describe('estimateTokens', () => {
    it('estimates CJK-heavy text at ~1.5 token/char', () => {
      const text = '这是中文测试'.repeat(10); // 60 CJK chars
      const tokens = estimateTokens(text);
      expect(tokens).toBe(90); // 60 * 1.5
    });

    it('estimates ASCII text at ~4 chars/token', () => {
      const text = 'a'.repeat(40);
      expect(estimateTokens(text)).toBe(10);
    });

    it('handles mixed CJK + ASCII', () => {
      const text = '你好世界 hello world'; // 4 CJK + 12 ASCII (' hello world')
      const tokens = estimateTokens(text);
      expect(tokens).toBe(Math.round(4 * 1.5 + 12 / 4)); // 6 + 3 = 9
    });

    it('returns 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('counts fullwidth punctuation as CJK', () => {
      const text = '：，。！';
      expect(estimateTokens(text)).toBe(Math.round(4 * 1.5)); // 6
    });
  });
});
