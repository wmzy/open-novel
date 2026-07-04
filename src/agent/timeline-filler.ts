/** AI 预填的单章输入。 */
export interface FillChapterInput {
  number: number;
  title: string;
  pov: string;
  coreEvent: string;
  cast: string[];
}

const INTERACTION_TYPES = ['冲突', '合作', '对话', '试探', '对决', '善意', '背叛', '重逢', '离别'];

/**
 * 为单章构造 AI prompt，要求输出符合「角色交互」字段格式的文本。
 * 独角戏章节（cast 仅 1 人）直接返回（无），不调 AI。
 */
export function buildFillPrompt(input: FillChapterInput): string {
  const isSolo = input.cast.length <= 1;

  return `你是故事分析助手。请为以下章节生成「角色交互」字段。

## 章节信息
- 章号：第${input.number}章 ${input.title}
- POV：${input.pov}
- 核心事件：${input.coreEvent}
- 出场角色：${input.cast.join('、')}

## 输出格式
${isSolo
  ? '本章是独角戏（仅 1 个出场角色），无角色间交互。请直接输出：\n（无）'
  : `每条交互格式：主动方→被动方[类型]：动作描述
多条交互用「 · 」（中点 + 两侧空格）分隔。
类型必须取自以下枚举：${INTERACTION_TYPES.join(' / ')}

示例：
武松→何九叔[冲突]：被盘问 · 何九叔→武松[善意]：出手相助

请只输出角色交互字段内容，不要其他文字。`}`;
}

/**
 * 从 AI 输出中提取有效的角色交互字段。
 * 找到包含 `→` 和 `[...]` 的行；若无则检查是否为「（无）」；否则返回空串。
 */
export function parseAiResponse(aiOutput: string): string {
  const trimmed = aiOutput.trim();
  if (trimmed === '（无）') return '（无）';

  // 找包含交互格式（→...[...]：）的行
  const lines = trimmed.split('\n');
  for (const line of lines) {
    const clean = line.trim();
    if (clean.includes('→') && /\[.+?\]/.test(clean)) {
      return clean;
    }
  }
  return '';
}
