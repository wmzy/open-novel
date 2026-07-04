import { getPlugin } from '../plugins/registry';

/**
 * 从项目 genre 派生 skillId：有专属 SKILL.md 的 genre 用专属 plugin，否则回退通用 'novel'。
 *
 * plugin registry 为唯一真相源——新增 plugin 时无需改动调用方。
 * 这决定了 composePrompt 注入哪份 SKILL.md（如 wuxia → 武侠专属写作技法）。
 */
export function resolveSkillId(genre: string | null | undefined): string {
  if (genre && getPlugin(genre)) return genre;
  return 'novel';
}
