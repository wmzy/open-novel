/**
 * 角色灵感维度：把用户选择的维度+参数组装成一句自然语言消息，
 * 注入 ChatPanel 让 agent 在对话流里给候选种子。
 * 设计依据见 docs/superpowers/specs/2026-07-08-character-inspiration-design.md
 */

/** 灵感维度标识。 */
export type Dimension =
  | 'faction'    // 门派/势力
  | 'archetype'  // 历史/现实原型
  | 'role'       // 功能定位
  | 'triangle'   // 驱动力三角组合
  | 'tension'    // 关系张力
  | 'random';    // 随机刺激

/** 各维度参数。非必填维度对应字段可缺省。 */
export interface DimensionParams {
  /** 门派/势力名（faction 必填）。 */
  faction?: string;
  /** 原型人物名（可选；留空时由 AI 自由挑选原型）。 */
  archetype?: string;
  /** 功能定位（role 必填）。 */
  role?: '盟友' | '导师' | '镜面' | '障碍' | '叛徒' | '救星';
  /** 关系张力参数（tension 必填 target + type）。 */
  tension?: { target: string; type: '敌对' | '暧昧' | '师徒' | '利用' };
  // triangle / random 无参数
}

/** 共用指令片段：覆盖 INTERVIEW_PROTOCOL 的「先问后做」，强制种子形态。 */
const COMMON = [
  '我在卡角色，需要灵感刺激。',
  '请**跳过采访流程**，直接给我 3 个角色灵感种子——',
  '每个只要：姓名、一句话定位、一个记忆点（为什么读者会记住他）。',
  '结合现有的 concept 和 world-building，避免和已有角色重名。',
  '**不要写完整档案，我挑中后再展开。**',
].join('');

/**
 * 按维度+参数组装灵感请求消息。
 * 必填参数缺失时抛 Error——前端 InspirationPicker 应在参数为空时禁用按钮。
 */
export function buildInspirationMessage(dimension: Dimension, params: DimensionParams = {}): string {
  const prefix = buildDimensionPrefix(dimension, params);
  return `${prefix}${COMMON}`;
}

/** 各维度的定向指令（拼在共用片段前）。 */
function buildDimensionPrefix(dimension: Dimension, params: DimensionParams): string {
  switch (dimension) {
    case 'faction': {
      if (!params.faction) throw new Error('faction 维度需要 faction 参数');
      return `这 3 个角色都隶属「${params.faction}」——`;
    }
    case 'archetype': {
      if (params.archetype) {
        return `这 3 个角色都以「${params.archetype}」为蓝本，抽取其核心特质转译到本世界，不要照搬历史事迹——`;
      }
      return `这 3 个角色各以一个历史/现实人物为原型蓝本（由你挑选，可以是真实人物或经典虚构角色），抽取其核心特质转译到本世界，不要照搬原型事迹，每个标注参考了谁——`;
    }
    case 'role': {
      if (!params.role) throw new Error('role 维度需要 role 参数');
      return `这 3 个角色都承担「${params.role}」的叙事功能，说明此刻故事为什么需要这个功能——`;
    }
    case 'triangle': {
      return `这 3 个角色的驱动力三角（Want/Need/Wound）各不相同，每个标注三角组合——`;
    }
    case 'tension': {
      if (!params.tension?.target || !params.tension?.type) {
        throw new Error('tension 维度需要 target 和 type 参数');
      }
      return `这 3 个角色都与「${params.tension.target}」产生「${params.tension.type}」关系，说明冲突点——`;
    }
    case 'random': {
      return `这 3 个角色风格差异最大、来自不同维度——`;
    }
  }
}

// ── 角色丰富（内嵌灵感：针对单个已有角色）──────────────────────────────

/** 角色丰富方向。用于卡片内嵌的轻量方向选择。 */
export type EnrichDirection = 'deeds' | 'role' | 'backstory';

/** 各方向的中文标签与定向指令。 */
export const ENRICH_DIRECTION_LABELS: Record<EnrichDirection, string> = {
  deeds: '补充事迹',
  role: '强化定位',
  backstory: '挖掘背景',
};

const ENRICH_INSTRUCTIONS: Record<EnrichDirection, string> = {
  deeds: '为这个角色设计 3 个关键事件或转折点，说明每个如何推动现有剧情',
  role: '厘清这个角色在故事里的叙事功能与存在意义，给 3 个可强化的定位方向',
  backstory: '为这个角色挖掘登场前的来历、秘密或前史，给 3 个有张力的背景选项',
};

/** 共用片段：丰富现有角色（区别于生成新角色种子）。 */
const ENRICH_COMMON = [
  '请**跳过采访流程**，直接给候选方向。',
  '**不要改写现有档案**，只给方向和建议，我挑中后再展开。',
].join('');

/**
 * 针对单个已有角色，组装「丰富该角色」的灵感请求。
 * 角色名为空时抛 Error——调用方应保证传入有效角色名。
 */
export function buildCharacterEnrichMessage(characterName: string, direction: EnrichDirection): string {
  const name = characterName.trim();
  if (!name) throw new Error('角色名不能为空');
  return `请帮我丰富现有角色「${name}」，方向：${ENRICH_DIRECTION_LABELS[direction]}。${ENRICH_INSTRUCTIONS[direction]}。${ENRICH_COMMON}`;
}
