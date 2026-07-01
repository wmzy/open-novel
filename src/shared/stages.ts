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
  { id: 'writing', label: '写作', viewId: 'writing', order: 5 },
];

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
  { id: 'wuxia', label: '武侠' },
];
