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

// ── 多阶段定制灵感（数据驱动框架）──────────────────────────────────────
// 角色阶段纳入统一框架（维度定义照搬上方逻辑），其余为新增阶段。
// 设计依据见 docs/superpowers/specs/2026-07-15-per-stage-inspiration-design.md

/** 灵感阶段标识。character 保留向后兼容，其余为新增。 */
export type InspireStage = 'character' | 'concept' | 'world' | 'outline' | 'scene' | 'wuxia';

/** 维度参数定义：text 输入或 select 下拉。 */
export interface InspireParamDef {
  key: string;
  label: string;
  type: 'text' | 'select';
  /** select 类型的可选项。 */
  options?: string[];
  /** text 类型是否必填（影响生成按钮禁用状态）。 */
  required?: boolean;
  placeholder?: string;
}

/** 单个灵感维度定义。 */
export interface InspireDimensionDef {
  id: string;
  label: string;
  params?: InspireParamDef[];
  /** 组装该维度的定向指令前缀；params 为用户填写的参数值。 */
  buildPrefix: (params: Record<string, string>) => string;
}

/** 阶段定义：共用指令片段 + 维度集合。 */
export interface InspireStageDef {
  label: string;
  common: string;
  dimensions: InspireDimensionDef[];
}

/** 取去空格后的值，空串视为缺省。 */
const clean = (v: string | undefined) => (v && v.trim()) || '';

export const INSPIRE_STAGES: Record<InspireStage, InspireStageDef> = {
  character: {
    label: '角色',
    common: COMMON,
    dimensions: [
      {
        id: 'faction',
        label: '门派/势力',
        params: [{ key: 'faction', label: '势力名', type: 'text', required: true, placeholder: '如：明教、丐帮、朝廷' }],
        buildPrefix: (pr) => `这 3 个角色都隶属「${pr.faction}」——`,
      },
      {
        id: 'archetype',
        label: '历史/现实原型',
        params: [{ key: 'archetype', label: '原型人物', type: 'text', placeholder: '留空则 AI 自由发挥' }],
        buildPrefix: (pr) =>
          clean(pr.archetype)
            ? `这 3 个角色都以「${pr.archetype}」为蓝本，抽取其核心特质转译到本世界，不要照搬历史事迹——`
            : `这 3 个角色各以一个历史/现实人物为原型蓝本（由你挑选），抽取核心特质转译到本世界，每个标注参考了谁——`,
      },
      {
        id: 'role',
        label: '功能定位',
        params: [{ key: 'role', label: '功能', type: 'select', options: ['盟友', '导师', '镜面', '障碍', '叛徒', '救星'] }],
        buildPrefix: (pr) => `这 3 个角色都承担「${pr.role}」的叙事功能，说明此刻故事为什么需要这个功能——`,
      },
      {
        id: 'triangle',
        label: '驱动力三角',
        buildPrefix: () => '这 3 个角色的驱动力三角（Want/Need/Wound）各不相同，每个标注三角组合——',
      },
      {
        id: 'tension',
        label: '关系张力',
        params: [
          { key: 'target', label: '对手角色', type: 'text', required: true, placeholder: '已有角色名' },
          { key: 'type', label: '关系', type: 'select', options: ['敌对', '暧昧', '师徒', '利用'] },
        ],
        buildPrefix: (pr) => `这 3 个角色都与「${pr.target}」产生「${pr.type}」关系，说明冲突点——`,
      },
      {
        id: 'random',
        label: '随机刺激',
        buildPrefix: () => '这 3 个角色风格差异最大、来自不同维度——',
      },
    ],
  },

  concept: {
    label: '故事概念',
    common: [
      '我在打磨故事概念，需要灵感刺激。',
      '请**跳过采访流程**，直接给我 3 个方向——',
      '每个只要一句话核心 + 一个记忆点。',
      '结合现有设定，避免俗套。',
      '**不要改写现有概念文档，只给方向，我挑中后再展开。**',
    ].join(''),
    dimensions: [
      { id: 'conflict', label: '冲突锐化', buildPrefix: () => '这 3 个方向都用来强化核心冲突的烈度与不可调和性——' },
      { id: 'twist', label: '反转点子', buildPrefix: () => '这 3 个方向都是能颠覆读者预期的反转设计——' },
      {
        id: 'premise',
        label: '前提变体',
        params: [{ key: 'keyword', label: '关键词', type: 'text', placeholder: '可选，聚焦某个主题词' }],
        buildPrefix: (pr) =>
          clean(pr.keyword)
            ? `这 3 个变体都围绕「${pr.keyword}」展开不同切入角度——`
            : '这 3 个变体是对现有核心前提的不同切入角度——',
      },
      { id: 'hook', label: '开头钩子', buildPrefix: () => '这 3 个方向都是能抓住读者情感的开场设计——' },
      { id: 'random', label: '随机刺激', buildPrefix: () => '这 3 个方向风格差异最大、来自不同维度——' },
    ],
  },

  world: {
    label: '世界观',
    common: [
      '我在扩展世界观，需要灵感刺激。',
      '请**跳过采访流程**，直接给我 3 个设定种子——',
      '每个只要名称、一句话定位、一个记忆点。',
      '结合现有世界观保持自洽，避免与已有设定冲突。',
      '**不要改写现有设定文档，只给种子，我挑中后再展开。**',
    ].join(''),
    dimensions: [
      {
        id: 'faction',
        label: '势力格局',
        params: [{ key: 'name', label: '势力名', type: 'text', placeholder: '可选，围绕某势力展开' }],
        buildPrefix: (pr) =>
          clean(pr.name)
            ? `这 3 个势力种子围绕「${pr.name}」展开——`
            : '这 3 个势力种子各属不同阵营、利益诉求各异——',
      },
      {
        id: 'rule',
        label: '规则体系',
        params: [{ key: 'name', label: '体系名', type: 'text', placeholder: '可选，如：灵力、武学、科技' }],
        buildPrefix: (pr) =>
          clean(pr.name)
            ? `这 3 个方向拓展「${pr.name}」体系——`
            : '这 3 个方向分别拓展力量/社会/经济某一体系——',
      },
      { id: 'geography', label: '地理拓展', buildPrefix: () => '这 3 个地理种子各是一个有特色的新区域或地标——' },
      { id: 'culture', label: '文化习俗', buildPrefix: () => '这 3 个文化种子涉及风俗、禁忌、信仰或语言——' },
      { id: 'random', label: '随机刺激', buildPrefix: () => '这 3 个设定种子风格差异最大——' },
    ],
  },

  outline: {
    label: '大纲',
    common: [
      '我在打磨大纲结构，需要灵感刺激。',
      '请**跳过采访流程**，直接给我 3 个方向——',
      '每个只要一句话描述 + 对现有因果链的影响。',
      '结合已有章节脉络，保持因果连贯。',
      '**不要改写现有大纲，只给方向，我挑中后再展开。**',
    ].join(''),
    dimensions: [
      {
        id: 'turn',
        label: '剧情转折',
        params: [{ key: 'range', label: '章节范围', type: 'text', placeholder: '可选，如：第5-8章' }],
        buildPrefix: (pr) =>
          clean(pr.range) ? `这 3 个转折点都设在「${pr.range}」附近——` : '这 3 个转折点分布在不同幕——',
      },
      { id: 'foreshadow', label: '伏笔设计', buildPrefix: () => '这 3 个伏笔种子都能在后续回收，说明埋设与回收的呼应——' },
      { id: 'pacing', label: '节奏调整', buildPrefix: () => '这 3 个方向用于改善张弛节奏，指出当前哪里拖沓或仓促——' },
      { id: 'climax', label: '高潮设计', buildPrefix: () => '这 3 个高潮方案都把核心冲突推向顶点——' },
      { id: 'random', label: '随机刺激', buildPrefix: () => '这 3 个方向风格差异最大——' },
    ],
  },

  scene: {
    label: '场景',
    common: [
      '我在打磨场景设计，需要灵感刺激。',
      '请**跳过采访流程**，直接给我 3 个方向——',
      '每个只要一句话描述 + 一个具体的感官细节。',
      '结合已有场景的角色目标和冲突。',
      '**不要改写现有场景，只给方向，我挑中后再展开。**',
    ].join(''),
    dimensions: [
      { id: 'conflict', label: '冲突升级', buildPrefix: () => '这 3 个方向都用来升级场景内的冲突烈度——' },
      { id: 'atmosphere', label: '氛围营造', buildPrefix: () => '这 3 个方向强化场景的视听嗅味触感官氛围——' },
      { id: 'reveal', label: '信息揭露', buildPrefix: () => '这 3 个方向设计场景内关键信息的释放时机与方式——' },
      { id: 'transition', label: '转场设计', buildPrefix: () => '这 3 个方向设计场景之间的过渡与衔接——' },
      { id: 'random', label: '随机刺激', buildPrefix: () => '这 3 个方向风格差异最大——' },
    ],
  },

  wuxia: {
    label: '武侠',
    common: [
      '我在扩展武侠设定，需要灵感刺激。',
      '请**跳过采访流程**，直接给我 3 个种子——',
      '每个只要名称、一句话定位、一个记忆点。',
      '结合现有江湖格局保持自洽。',
      '**不要改写现有设定，只给种子，我挑中后再展开。**',
    ].join(''),
    dimensions: [
      {
        id: 'sect',
        label: '门派设计',
        params: [{ key: 'name', label: '门派名', type: 'text', placeholder: '可选，围绕某门派展开' }],
        buildPrefix: (pr) =>
          clean(pr.name)
            ? `这 3 个门派种子围绕「${pr.name}」展开——`
            : '这 3 个门派种子各有独特武学与江湖立场——',
      },
      {
        id: 'martial',
        label: '武学体系',
        params: [{ key: 'type', label: '类型', type: 'select', options: ['内功', '外功', '轻功', '暗器', '阵法'] }],
        buildPrefix: (pr) => `这 3 个武学种子都属于「${pr.type || '内功'}」范畴，说明威力与代价——`,
      },
      { id: 'jianghu', label: '江湖格局', buildPrefix: () => '这 3 个方向设计江湖事件、恩怨格局或势力博弈——' },
      { id: 'artifact', label: '奇物神兵', buildPrefix: () => '这 3 个神兵或奇物种子各有独特来历与能力——' },
      { id: 'random', label: '随机刺激', buildPrefix: () => '这 3 个种子风格差异最大——' },
    ],
  },
};

/**
 * 组装某阶段某维度的灵感请求消息。维度 id 不存在时抛 Error。
 */
export function buildStageInspirationMessage(
  stage: InspireStage,
  dimensionId: string,
  params: Record<string, string> = {},
): string {
  const stageDef = INSPIRE_STAGES[stage];
  const dim = stageDef.dimensions.find((d) => d.id === dimensionId);
  if (!dim) throw new Error(`阶段 ${stage} 无维度 ${dimensionId}`);
  return `${dim.buildPrefix(params)}${stageDef.common}`;
}

/** 检查某维度的必填参数是否齐全，用于禁用生成按钮。 */
export function stageDimensionReady(
  stage: InspireStage,
  dimensionId: string,
  params: Record<string, string>,
): boolean {
  const dim = INSPIRE_STAGES[stage].dimensions.find((d) => d.id === dimensionId);
  if (!dim) return false;
  return (dim.params || []).every((pd) => !pd.required || clean(params[pd.key]));
}

/** 为某维度初始化参数：select 参数取首个选项作为默认值。 */
export function initDimensionParams(dim?: InspireDimensionDef): Record<string, string> {
  const init: Record<string, string> = {};
  for (const pd of dim?.params ?? []) {
    if (pd.type === 'select') init[pd.key] = pd.options?.[0] ?? '';
  }
  return init;
}
