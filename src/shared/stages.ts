/**
 * Shared stage definitions and mappings between workflow stages and UI views.
 */

export interface StageDefinition {
  id: string;
  label: string;
  viewId: string;
  order: number;
}

export const STAGES: StageDefinition[] = [
  { id: 'concept', label: '概念', viewId: 'concept', order: 0 },
  { id: 'world', label: '世界观', viewId: 'world', order: 1 },
  { id: 'characters', label: '角色', viewId: 'characters', order: 2 },
  { id: 'outline', label: '大纲', viewId: 'outline', order: 3 },
  { id: 'scenes', label: '场景', viewId: 'scenes', order: 4 },
  { id: 'sample', label: '样章', viewId: 'sample', order: 5 },
  { id: 'writing', label: '写作', viewId: 'writing', order: 6 },
];

/** 需要注入写作分层上下文（滚动摘要/状态/伏笔等）的阶段。
 * sample（样章）要写真实章节正文，故与写作阶段共用分层上下文；
 * drafting / revision / polish 为写作子模式，不在 STAGES 主线中。 */
const WRITING_CONTEXT_STAGES = new Set(['sample', 'writing', 'drafting', 'revision', 'polish']);

/** 判断某阶段是否为写作型阶段（需注入写作分层上下文）。 */
export function isWritingStage(stageId: string): boolean {
  return WRITING_CONTEXT_STAGES.has(stageId);
}

// Map from stage ID to view ID
export const stageToView: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.id, s.viewId])
);

// Map from view ID to stage ID
export const viewToStage: Record<string, string> = Object.fromEntries(
  STAGES.map((s) => [s.viewId, s.id])
);

// Get stage index (for progress display)
export function getStageIndex(stageId: string): number {
  return STAGES.findIndex((s) => s.id === stageId);
}

// Get next stage
export function getNextStage(currentStageId: string): string | null {
  const idx = getStageIndex(currentStageId);
  if (idx < 0 || idx >= STAGES.length - 1) return null;
  return STAGES[idx + 1].id;
}

// Additional views that aren't workflow stages
export const EXTRA_VIEWS = [
  { id: 'dashboard', label: '总览' },
  { id: 'foreshadow', label: '伏笔' },
  { id: 'wuxia', label: '武侠' },
];

// All sidebar views (stages + extras)
export const ALL_VIEWS = [
  { id: 'dashboard', label: '总览' },
  ...STAGES.map((s) => ({ id: s.viewId, label: s.label })),
  { id: 'foreshadow', label: '伏笔' },
  { id: 'story-arc', label: '故事脉络' },
  { id: 'character-graph', label: '角色关系' },
  { id: 'wuxia', label: '武侠' },
];
