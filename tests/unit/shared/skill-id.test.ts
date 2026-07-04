import { describe, it, expect, beforeAll } from 'vitest';
import { initPlugins } from '../../../src/plugins/registry';
import { resolveSkillId } from '../../../src/shared/skill-id';

/**
 * resolveSkillId：从项目 genre 派生 skillId，决定 composePrompt 注入哪份 SKILL.md。
 * 这是"武侠项目用武侠 SKILL.md"的契约守卫——wuxia/reality 有专属 plugin，其余回退 novel。
 */
describe('resolveSkillId', () => {
  beforeAll(() => initPlugins());

  it('wuxia → wuxia（武侠专属 SKILL.md）', () => {
    expect(resolveSkillId('wuxia')).toBe('wuxia');
  });

  it('reality → reality（现实专属 SKILL.md）', () => {
    expect(resolveSkillId('reality')).toBe('reality');
  });

  it('general → novel（无专属 plugin，回退通用）', () => {
    expect(resolveSkillId('general')).toBe('novel');
  });

  it('fantasy → novel（无专属 plugin）', () => {
    expect(resolveSkillId('fantasy')).toBe('novel');
  });

  it('空值 → novel', () => {
    expect(resolveSkillId(null)).toBe('novel');
    expect(resolveSkillId(undefined)).toBe('novel');
    expect(resolveSkillId('')).toBe('novel');
  });
});
