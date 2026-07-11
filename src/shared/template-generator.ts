/**
 * 动态模板生成器：按项目元数据（章节数、目标字数等）生成结构化脚手架，
 * 替代 plugins 下静态占位模板。所有输出为中文 markdown。
 *
 * 四个生成函数覆盖：详细大纲、简要大纲、场景设计、角色档案。
 * 三幕结构按章节数比例划分——第 1 幕（前约 25%）/第 2 幕（约 25–75%）/第 3 幕（后约 25%）。
 */

/** 模板生成所需的全部项目元数据。 */
export interface TemplateGenOptions {
  /** 目标章节数。 */
  chapterCount: number;
  /** 全书目标字数。 */
  targetWords: number;
  /** 作品标题。 */
  title: string;
  /** 类型（如 fantasy / general / wuxia）。 */
  genre: string;
  /** 叙事视角（如 first-person / third-person）。 */
  perspective: string;
  /** 主题，可选。 */
  theme?: string;
}

/** 三幕划分结果（章节序号均为 1-based）。 */
interface ActPlan {
  /** 第一幕包含的章节数。 */
  act1Count: number;
  /** 第三幕首章序号（>= 此序号即属第三幕）。 */
  act3Start: number;
}

/**
 * 生成大纲元数据：三幕分界 + 每章视点占位。
 * agent 在大纲阶段填充 pov，写作阶段按需修正。
 */
export function generateOutlineMeta(options: TemplateGenOptions): string {
  const n = Math.max(1, options.chapterCount);
  const plan = planActs(n);
  return JSON.stringify({
    actBreaks: [plan.act1Count, plan.act3Start - 1],
    chapters: Array.from({ length: n }, (_, i) => ({
      chapter: i + 1,
      pov: '',
    })),
  }, null, 2);
}

/** 生成器名称 → 生成函数，供 API 路由统一调度。 */
export const TEMPLATE_GENERATORS: Record<string, (o: TemplateGenOptions) => string> = {
  'outline-detailed': generateOutlineDetailed,
  'outline-brief': generateOutlineBrief,
  scenes: generateScenes,
  'character-profiles': generateCharacterProfiles,
  'outline-meta': generateOutlineMeta,
};

/** 生成器名称 → 写入 .novel/ 下的相对路径，供 API 路由统一落盘。 */
export const TEMPLATE_FILE_PATHS: Record<string, string> = {
  'outline-detailed': 'outline/',  // 拆分型：目录（index.md + chapters/）
  'outline-brief': 'outline-brief.md',
  scenes: 'scenes.md',
  'character-profiles': 'characters/profiles.md',
  'outline-meta': 'outline-meta.json',
};

/** 视角标识 → 中文标签，未知值原样返回。 */
function perspectiveLabel(p: string): string {
  const map: Record<string, string> = {
    'first-person': '第一人称',
    'third-person': '第三人称',
    'third-limited': '第三人称有限视角',
    'third-omniscient': '第三人称全知视角',
    'second-person': '第二人称',
    'multi-pov': '多视角',
  };
  return map[p] ?? p;
}

/** 每章平均字数，至少 1。 */
function wordsPerChapter(options: TemplateGenOptions): number {
  const n = Math.max(1, options.chapterCount);
  return Math.max(1, Math.round(options.targetWords / n));
}

/** 按章节数计算三幕边界。小章节数也能保证每幕至少 1 章（第二幕可能为空）。 */
function planActs(chapterCount: number): ActPlan {
  const n = Math.max(1, chapterCount);
  const act1Count = Math.max(1, Math.round(n * 0.25));
  const act3Count = Math.max(1, Math.round(n * 0.25));
  const act3Start = n - act3Count + 1;
  return { act1Count, act3Start };
}

/** 返回某章所属幕的中文标签。 */
function actName(chapter: number, plan: ActPlan): string {
  if (chapter <= plan.act1Count) return '第一幕·设置';
  if (chapter >= plan.act3Start) return '第三幕·解决';
  return '第二幕·对抗';
}

/** 给出某章的结构定位提示，引导 agent 填写关键节点。 */
function chapterHint(chapter: number, chapterCount: number, plan: ActPlan): string {
  const mid = Math.max(1, Math.round(chapterCount / 2));
  if (chapter === 1) return '开篇：建立日常世界，引入主角的欲望与缺陷';
  if (chapter === plan.act1Count) return '触发事件：打破平衡，迫使主角踏上旅程';
  // 中点转折落在第二幕中部
  if (chapter === mid && chapter > plan.act1Count && chapter < plan.act3Start) {
    return '中点转折：真相或代价浮出，主角目标发生质变';
  }
  // 第二幕末章为灵魂黑夜（仅当第二幕存在时）
  if (chapter === plan.act3Start - 1 && chapter > plan.act1Count) {
    return '灵魂黑夜：失去一切，主角跌入最低谷';
  }
  if (chapter === chapterCount) return '高潮与结局：最终对决，建立新的常态';
  const name = actName(chapter, plan);
  if (name.startsWith('第一幕')) return '铺垫：深化世界观与人物关系';
  if (name.startsWith('第二幕')) return '推进：障碍递进，冲突持续升级';
  return '收束：汇聚各条线索，推向最终对决';
}

/** 格式化章节区间字符串，如「第 1–5 章」。起止相同则返回单章。 */
function rangeStr(from: number, to: number): string {
  if (from >= to) return `第 ${to} 章`;
  return `第 ${from}–${to} 章`;
}

/** 通用文档头：标题 + 元数据摘要行。 */
function buildHeader(options: TemplateGenOptions, subtitle: string): string {
  const themePart = options.theme ? `｜主题：${options.theme}` : '';
  return [
    `# ${subtitle}：《${options.title}》`,
    '',
    `> 类型：${options.genre}${themePart}｜视角：${perspectiveLabel(options.perspective)}｜目标字数：约 ${options.targetWords} 字｜共 ${options.chapterCount} 章（每章约 ${wordsPerChapter(options)} 字）`,
  ].join('\n');
}

/**
 * 生成详细大纲：按 chapterCount 逐章生成骨架，每章含标题占位、主要场景、
 * 目标、冲突、结果、伏笔/回调，并标注所属幕与结构定位。
 */
export function generateOutlineDetailed(options: TemplateGenOptions): string {
  const n = Math.max(1, options.chapterCount);
  const per = wordsPerChapter(options);
  const plan = planActs(n);

  const lines: string[] = [buildHeader(options, '详细大纲'), ''];
  lines.push('<!-- 由 template-generator 按 chapterCount 动态生成脚手架，请逐章填充具体内容 -->');
  lines.push('');

  for (let i = 1; i <= n; i++) {
    lines.push(`## 第 ${i} 章：{章节标题} ｜ ${actName(i, plan)} ｜ 目标约 ${per} 字`);
    lines.push(`- **结构定位**：${chapterHint(i, n, plan)}`);
    lines.push('- **主要场景**：{一句话概括本章核心场景与发生地点}');
    lines.push('- **目标**：{主角在本章想要达成什么}');
    lines.push('- **冲突**：{什么力量或角色阻碍了目标的实现}');
    lines.push('- **结果**：{本章结局——灾难升级还是取得进展？}');
    lines.push('- **伏笔/回调**：{埋下的伏笔，或回收的前文线索}');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** 拆分型模板生成结果。 */
export interface SplitTemplateResult {
  indexContent: string;
  cards: Array<{ relativePath: string; content: string }>;
}

/**
 * 生成详细大纲（拆分格式）：返回索引 + 逐章卡片文件。
 * 每章一张独立卡片文件（chapters/第N章.md），index.md 提供全局结构索引。
 */
export function generateOutlineDetailedSplit(options: TemplateGenOptions): SplitTemplateResult {
  const n = Math.max(1, options.chapterCount);
  const per = wordsPerChapter(options);
  const plan = planActs(n);

  const cards: SplitTemplateResult['cards'] = [];
  for (let i = 1; i <= n; i++) {
    const lines: string[] = [
      `## 第 ${i} 章：{章节标题} ｜ ${actName(i, plan)} ｜ 目标约 ${per} 字`,
      `- **结构定位**：${chapterHint(i, n, plan)}`,
      '- **主要场景**：{一句话概括本章核心场景与发生地点}',
      '- **目标**：{主角在本章想要达成什么}',
      '- **冲突**：{什么力量或角色阻碍了目标的实现}',
      '- **结果**：{本章结局——灾难升级还是取得进展？}',
      '- **伏笔/回调**：{埋下的伏笔，或回收的前文线索}',
    ];
    cards.push({ relativePath: `chapters/第${i}章.md`, content: lines.join('\n') });
  }

  // 构建索引
  const themePart = options.theme ? `｜主题：${options.theme}` : '';
  const indexLines: string[] = [
    `# 详细大纲索引：《${options.title}》`,
    '',
    `> 类型：${options.genre}${themePart}｜视角：${perspectiveLabel(options.perspective)}｜目标字数：约 ${options.targetWords} 字｜共 ${n} 章（每章约 ${per} 字）`,
    '> 每章独立文件位于 chapters/第N章.md，用 Read 工具按需读取单章大纲。',
    '',
    '## 三幕结构',
    '',
    '| 幕 | 章节范围 |',
    '|---|---|',
    `| 第一幕·设置 | ${rangeStr(1, plan.act1Count)} |`,
  ];
  if (plan.act3Start > plan.act1Count + 1) {
    indexLines.push(`| 第二幕·对抗 | ${rangeStr(plan.act1Count + 1, plan.act3Start - 1)} |`);
  }
  indexLines.push(`| 第三幕·解决 | ${rangeStr(plan.act3Start, n)} |`);
  indexLines.push('', '## 章节索引', '', '| 章 | 标题 | 文件 |', '|---|---|---|');
  for (let i = 1; i <= n; i++) {
    indexLines.push(`| ${i} | {章节标题} | chapters/第${i}章.md |`);
  }

  return { indexContent: `${indexLines.join('\n')}\n`, cards };
}

/**
 * 生成简要大纲：三幕结构 + 各幕字数分配，用于快速把握全局节奏。
 */
export function generateOutlineBrief(options: TemplateGenOptions): string {
  const n = Math.max(1, options.chapterCount);
  const plan = planActs(n);
  const act1Words = Math.round(options.targetWords * 0.25);
  const act3Words = Math.round(options.targetWords * 0.25);
  const act2Words = options.targetWords - act1Words - act3Words;

  const lines: string[] = [buildHeader(options, '简要大纲'), ''];

  // 第一幕
  lines.push(`## 第一幕：设置（${rangeStr(1, plan.act1Count)}，约 ${act1Words} 字）`);
  lines.push('- {引入主角、世界观与日常状态}');
  lines.push('- {展示主角的内在需求与外部困境}');
  lines.push('- {触发事件打破平衡，主角被迫踏上旅程}');
  lines.push('');

  // 第二幕（当章节过少导致第二幕为空时给出说明）
  const act2From = plan.act1Count + 1;
  const act2To = plan.act3Start - 1;
  if (act2From <= act2To) {
    lines.push(`## 第二幕：对抗（${rangeStr(act2From, act2To)}，约 ${act2Words} 字）`);
    lines.push('- {主角追求目标，遇到递进的障碍与冲突}');
    lines.push('- {中点转折：目标、真相或代价发生质变}');
    lines.push('- {灵魂黑夜：失去一切，跌入最低谷}');
  } else {
    lines.push(`## 第二幕：对抗（本章节数较少，与第一/三幕合并）`);
    lines.push('- {如需扩展，可在此补充对抗阶段的冲突与转折}');
  }
  lines.push('');

  // 第三幕
  lines.push(`## 第三幕：解决（${rangeStr(plan.act3Start, n)}，约 ${act3Words} 字）`);
  lines.push('- {主角觉醒，重新集结力量}');
  lines.push('- {最终对决：与反派或核心矛盾正面交锋}');
  lines.push('- {代价与新生：问题解决，建立新的常态}');

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * 生成场景设计：按 chapterCount 为每章生成主动场景（Scene）与被动场景（Sequel）骨架，
 * 每个场景含视点、目标、冲突、灾难 / 反应、困境、决定。
 */
export function generateScenes(options: TemplateGenOptions): string {
  const n = Math.max(1, options.chapterCount);
  const per = wordsPerChapter(options);
  const plan = planActs(n);

  const lines: string[] = [buildHeader(options, '场景设计'), ''];
  lines.push('<!-- 主动场景(Scene) 推进行动，被动场景(Sequel) 处理情感与决策，二者交替构成节奏 -->');
  lines.push('');

  for (let i = 1; i <= n; i++) {
    lines.push(`## 第 ${i} 章场景 ｜ ${actName(i, plan)} ｜ 目标约 ${per} 字`);
    lines.push('');
    lines.push('### 场景 1：主动场景（Scene）');
    lines.push(`- **视点**：{POV 角色}（${perspectiveLabel(options.perspective)}）`);
    lines.push('- **目标**：{角色此刻想要得到什么？}');
    lines.push('- **冲突**：{什么阻碍了角色达成目标？}');
    lines.push('- **灾难**：{结果如何变得更糟？}');
    lines.push('');
    lines.push('### 场景 2：被动场景（Sequel）');
    lines.push('- **反应**：{角色对灾难的情感与生理反应}');
    lines.push('- **困境**：{角色面临的两难选择}');
    lines.push('- **决定**：{角色做出的决定，引向下一章的目标}');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * 生成角色档案：主角（欲望/需求/创伤 驱动三角）、反派、至少 2 个配角。
 * 每个角色包含：外貌锚点、行为习惯、3 句典型台词样本。
 */
export function generateCharacterProfiles(options: TemplateGenOptions): string {
  const lines: string[] = [buildHeader(options, '角色档案'), ''];
  lines.push('<!-- 驱动三角（欲望/需求/创伤）决定主角弧光，反派与配角从不同方向施压 -->');
  lines.push('');

  // 一、主角
  lines.push('## 一、主角（驱动三角：欲望 / 需求 / 创伤）');
  lines.push('');
  appendCharacterBlock(lines, '{主角姓名}', {
    role: '主角',
    extra: [
      '- **驱动三角**：',
      '  - 欲望（Want，外在目标）：{ }',
      '  - 需求（Need，内在成长）：{ }',
      '  - 创伤（Ghost/Wound，过往阴影）：{ }',
      '- **弧光**：起点 { } → 中点 { } → 终点 { }',
    ],
  });

  // 二、反派
  lines.push('## 二、反派');
  lines.push('');
  appendCharacterBlock(lines, '{反派姓名}', {
    role: '反派',
    extra: [
      '- **动机**：{为什么与主角对立，要合理可信}',
      '- **手段**：{用什么方式制造阻碍}',
      '- **弱点**：{可被主角利用的破绽}',
    ],
  });

  // 三、配角（至少 2 个）
  lines.push('## 三、配角（至少 2 个）');
  lines.push('');
  appendCharacterBlock(lines, '{配角 1 姓名}', {
    role: '配角',
    functionHint: '盟友 / 导师 / 镜面 / 障碍',
    extra: ['- **与主角关系**：{如何推动或阻碍主角的成长}'],
  });
  lines.push('');
  appendCharacterBlock(lines, '{配角 2 姓名}', {
    role: '配角',
    functionHint: '盟友 / 导师 / 镜面 / 障碍',
    extra: ['- **与主角关系**：{如何推动或阻碍主角的成长}'],
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

/** 角色通用分块：基础信息 + 外貌锚点 + 行为习惯 + 3 句典型台词，可插入额外字段。 */
function appendCharacterBlock(
  lines: string[],
  name: string,
  opts: {
    role: string;
    functionHint?: string;
    extra?: string[];
  },
): void {
  const title = opts.functionHint ? `${name}（功能：${opts.functionHint}）` : name;
  lines.push(`### ${title}`);
  lines.push('- **基础信息**：年龄｜性别｜身份/职业');
  for (const e of opts.extra ?? []) lines.push(e);
  lines.push('- **外貌锚点**（用于重复强化读者记忆的细节）：');
  lines.push('  - {一个标志性外貌特征，如疤痕、旧外套或独特步态}');
  lines.push('  - {一个随身物品或标志性穿着}');
  lines.push('- **行为习惯**：');
  lines.push('  - {紧张、愤怒或思考时的习惯动作}');
  lines.push('  - {口头禅、思维模式或生活规律}');
  lines.push('- **说话特征**（3 句典型台词，用于统一语气）：');
  lines.push('  1. "{ }"');
  lines.push('  2. "{ }"');
  lines.push('  3. "{ }"');
  lines.push('');
}
