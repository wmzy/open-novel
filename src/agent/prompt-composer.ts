import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/drizzle';
import { projects } from '../db/schema';
import { getPlugin } from '../plugins/registry';
import { eq } from 'drizzle-orm';
import { buildRollingSummaryContext, getStateTable, readCharacterNames, getProgressMarkdown, getCharacterStatesMarkdown, getStyleRefs } from './context-manager';
import { extractChapterOutline, identifyCast, buildCastLayer, type ChapterOutline } from './chapter-context';
import { buildReverseDecomposePrompt } from './reverse-decomposer';
import { buildEnrichPrompt } from './enricher';
import { STAGE_OUTPUT_FILES, isCritiqueRound } from '../shared/deepen';
import { isWritingStage } from '../shared/stages';
import {
  parseForeshadowFile,
  computeDensityBudget,
  FORESHADOW_TYPE_LABELS,
  FORESHADOW_WEIGHT_LABELS,
  type Foreshadow,
} from '../shared/foreshadow';
import { getSubagentGuidance } from './subagents';

export interface ComposePromptOptions {
  message: string;
  projectId: string;
  skillId?: string;
  stage?: string;
  projectDir: string;
  history?: { role: string; content: string }[];
  /** 运行模式：generate（默认，生成全新）或 revise（修订已有文件）。 */
  mode?: 'generate' | 'revise';
  /** revise 模式：目标文件相对路径。 */
  reviseTarget?: string;
  /** revise 模式：用户修订意见。 */
  reviseNote?: string;
  /** revise 模式：目标文件当前全文。 */
  reviseContent?: string;
  /** revise 模式：拆分文档的卡片文件列表（相对 .novel/）。存在时表示 reviseContent 是合并内容，
   *  LLM 需用 Edit 修改具体卡片文件而非 index.md。 */
  reviseFileList?: string[];

  /** 自治模式：跳过采访式协议，前期阶段改为自主决策。默认 false。 */
  autonomous?: boolean;

  /** Plan Mode：先分析规划再执行，不直接修改文件。默认 false。 */
  planMode?: boolean;

  /** Deepen 深化循环上下文：注入当前 stage 产出文件 + critique（Revise 轮），省去 agent Read 往返。 */
  deepenContext?: { round: number };

  /** 当前 agent CLI ID（'claude' | 'omp' | 'opencode'）。用于注入 subagent 使用指导。 */
  agentId?: string;

  /** 异常中断恢复：上一轮被中断，本轮用户输入"继续"。注入中断现场。 */
  interruptedResume?: {
    userMessage: string;      // 上一轮原始用户请求
    assistantContent: string;  // 上一轮中断前已生成的助手内容（可能截断）
    reason: string;            // 中断原因（如 timeout、watchdog、process crash）
  };
}

// 规划阶段共用的「采访式」协作流程。拼接进 concept/world/characters/outline/scenes 的指令。
// 设计依据：旧版 opencode-novel-plugin 的引导式问答（先示范→提问工具选择题→多轮追问→分步确认）。
// 写作阶段不注入本协议，保持自治。
const INTERVIEW_PROTOCOL = [
  '',
  '## 本阶段的协作方式：采访式',
  '规划阶段中，每当涉及需要用户拍板的方向性选择——无论是一次性创作流程的开头，还是用户中途提问引发的讨论——都必须通过提问工具让用户做选择，不要一次性写满文件就交差。流程：',
  '1. **先示范**：用 2-3 句话展示一个与本项目类型相近、完成度高的范例，让用户对「好的产出长什么样」有具体感觉。',
  '2. **结构化选择**：用提问工具就下方列出的关键创作决策提问。每题给 3-5 个选项，每个选项配一句话说明其含义与走向影响。用选择题代替开放式填空；不确定时主动把你推荐的选项标出来。',
  '3. **追问细节**：用户做出主要选择后，基于其选择用提问工具再追问 1 轮（每轮不超过 3 题）补全关键细节。',
  '4. **落盘**：综合用户的选择生成内容，写入对应文件。',
  '5. **确认收尾**：用简短清单列出你做的关键决策，邀请用户确认或要求调整；确认后再推进到下一阶段。',
  '',
  '**铁律：禁止用纯文字列举 A/B/C 方案让用户打字回复。** 任何需要用户在两个或以上方案间做选择的场景——包括中途讨论、修改建议、确认方向——都必须调用提问工具呈现选项，由前端渲染为可点击的选择框。多个独立决策时，逐个发起提问（每次一个决策），先写分析文字，再连续调用提问工具。',
  '',
  '> 「采访式」≠ brainstorming 式审批门——你不是做完一步停下来等用户批准才能继续，而是在需要用户偏好输入时用选择题收集，其余时候自主推进。',
  '',
].join('\n');

/** 规划阶段核心任务的首句（头部）。交互协议（采访式/自治式）与决策清单由 buildStageInstructions 动态拼接。 */
const STAGE_HEAD: Record<string, string> = {
  concept: '聚焦于构思核心概念、前提和高层故事创意。帮助用户将愿景精炼成清晰、有吸引力的概念。',
  world: '构建故事世界——设定、规则、历史、文化与氛围。创造丰富、自洽、能支撑叙事的世界观。',
  characters: '撰写详细的角色档案——主角、反派与关键配角。涵盖动机、背景、关系与角色弧光。',
  outline: '创建详细的故事大纲，包括主要剧情节点、角色弧光与章节结构。将故事拆解成可驾驭的段落。',
  scenes: '将大纲拆解为详细场景，包含节拍、情感弧光与节奏。规划每个场景的目的与关键时刻。',
};

/** 规划阶段「关键创作决策」清单——仅在采访式（非自治）模式下注入。 */
const DECISION_PROMPTS: Record<string, string> = {
  concept: `**本阶段需要用提问工具与用户确认的关键创作决策**：
- 主角原型（身份与处境）
- 核心冲突（外部矛盾 + 主角内心矛盾的方向）
- 故事主题 / 道德前提
- 整体情感基调`,

  world: `**本阶段需要用提问工具与用户确认的关键创作决策**：
- 世界类型（现实 / 架空 / 异世界 / 未来 / 混合）
- 力量体系（无 / 简单 / 复杂；若为武侠或修仙，追问功法体系风格）
- 社会结构（权力分布、阶层、主要势力）`,

  characters: `**本阶段需要用提问工具与用户确认的关键创作决策**：
- 主角外在目标（复仇 / 最强 / 保护 / 真相 / 自由 等）
- 主角内在需求（信任 / 接纳 / 放下 / 归属 等）
- 主角核心缺陷（自负 / 恐惧亲密 / 非黑即白 / 逃避 / 控制欲 等）
- 核心矛盾（理念 / 利益 / 宿命 / 误解）
- 配角规模（2 个 / 3-4 个 / 5+）`,

  outline: `**本阶段需要用提问工具与用户确认的关键创作决策**：
- 三幕骨架的起点（常态世界状态）
- 触发事件类型（打破常态的关键事件）
- 中点转折方向（故事方向逆转的关键时刻）
- 高潮与结局走向
**分步确认**：先用提问工具与用户敲定三幕骨架，用户确认结构满意后，再展开逐章详细规划——不要一次性把逐章大纲全部写完。`,

  scenes: `**本阶段需要用提问工具与用户确认的关键创作决策**：
- 场景密度（每章平均 2-3 / 3-4 / 4-5 个场景）
- 节奏模式（严格交替 / 整体平衡 / 前松后紧）
- 自动化程度（逐章引导 / 批量审核 / 仅关键章）`,
};

/** 规划阶段的完成/落盘指令（尾部）。采访式与自治式共用。 */
const STAGE_TAIL: Record<string, string> = {
  concept: `
概念完成后（前提清晰、核心冲突明确、主要角色已定义），将结果保存到 .novel/concept/ 目录——每个 ## 要素一个独立 .md 文件（如 concept/核心主题.md），同时创建 .novel/concept/index.md 索引文件（含要素标题表）。并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "world" }）将项目阶段更新为 "world"。`,

  world: `
世界观完成后，保存到 .novel/world/ 目录——每个 ## 节一个独立 .md 文件（如 world/社会结构.md），同时创建 .novel/world/index.md 索引文件。并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "characters" }）将项目阶段更新为 "characters"。`,

  characters: `
每个主要角色必须落出驱动力三角（外在目标 / 内在需求 / 核心缺陷）。
角色档案完成后，保存到 .novel/characters/profiles.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "outline" }）将项目阶段更新为 "outline"。`,

  outline: `

**脚手架提示**：你可以请用户调用（或自己通过 Bash/curl 调用）端点 POST /api/projects/{projectId}/generate-templates，自动生成与项目 chapterCount 匹配的逐章大纲脚手架（幕、节拍、字数分配）。不落盘预览可用 GET /api/projects/{projectId}/templates/outline-brief。以生成的脚手架为起点并加以打磨。
大纲完成后，保存到 .novel/outline/ 目录——每章一个独立文件 chapters/第N章.md，同时创建 .novel/outline/index.md 索引（含三幕结构 + 章节标题表）。同时生成 .novel/outline-meta.json，记录三幕分界与每章视点角色，格式如下：
\`\`\`json
{
  "actBreaks": [5, 15],
  "chapters": [
    { "chapter": 1, "pov": "林冲", "commitment": "committed" },
    { "chapter": 2, "pov": "林冲", "commitment": "tentative" }
  ]
}
\`\`\`
actBreaks 为第一幕结束章号、第二幕结束章号；pov 为该章的视点角色名；commitment 为该章的承诺等级（语义见下）。

**承诺等级（滚动式大纲，每张章节卡片必填）**：章节卡片在标题行下用引用行声明承诺等级与待决策问题，格式：
\`\`\`markdown
## 第 N 章：标题 ｜ 所属幕 ｜ 目标约 X 字

> commitment: committed
> open-questions:
>   - 待决策问题（open 级必填，其余等级可省略）
\`\`\`
三级语义与粒度：
- committed（已定）：写作依据，正文不得偏离；粒度为 beat 级——场景、冲突、结果齐备（每章几百字）。
- tentative（倾向）：可被正文推翻，推翻时须回写大纲卡片；粒度为 arc 级（段落级走向）。
- open（待决策）：必须携带 open-questions 待决策问题列表；粒度为幕级骨架（一两句话）。
未声明或等级写错时一律按 tentative 处理。

**粒度梯度要求（近细远粗）**：第 1-10 章与即将写作的章节应达 committed/beat 级；第一幕其余章节 tentative/arc 级；第二、三幕 open/骨架级。**远期章节粗粒度是设计而非未完成**——写作推进到某章前，先把它精化为 beat 级（精排窗口：以已写完的章为起点向后 10 章）。outline-meta.json 的 chapters 数组须逐章同步填写 commitment 字段。

**伏笔登记（必做）**：从大纲中识别贯穿全书的伏笔（每处埋设 + 对应回收），写入 .novel/foreshadow.json，**替换掉模板占位**（"伏笔内容" 那一条）。每条用**具体内容**描述该伏笔是什么，而非泛泛之词。标准 schema：
\`\`\`json
{
  "foreshadows": [
    { "id": 1, "content": "具体伏笔描述", "type": "chekhov", "status": "pending", "plantedIn": 预定埋设章号, "resolveDeadline": 最晚回收章号, "resolvedIn": null, "dependsOn": [], "weight": "major" }
  ]
}
\`\`\`
顶层键为 foreshadows（**不是** items），内容字段为 content（**不是** description）。type 取值 chekhov（契诃夫之枪）/identity（身份揭示）/emotional（情感回响）/world（世界观）；status 取值 pending/planted/resolved/dropped；plantedIn/resolveDeadline/resolvedIn 为数字章号，无法确定时填 null；dependsOn 填前置伏笔的 id 列表（该伏笔回收前必须先回收的前置）；weight 取值 major（主线级）/light（点缀级）。密度预算：每 3 章新埋不超过 2 条，登记时据此控制总量。写章时 agent 会据此把 pending 翻成 planted，故此处务必把全书伏笔登记齐全。然后通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "scenes" }）将项目阶段更新为 "scenes"。`,

  scenes: `
确保主动场景（目标→冲突→灾难/转折）与被动场景（反应→困境→新决定）交替，避免连续同型。

**脚手架提示**：你可以请用户调用（或自己通过 Bash/curl 调用）端点 POST /api/projects/{projectId}/generate-templates，自动生成与项目 chapterCount 匹配的逐章场景脚手架（主动 Scene / 被动 Sequel 配对）。不落盘预览可用 GET /api/projects/{projectId}/templates/scenes。以生成的脚手架为起点并加以打磨。
场景表完成后，保存到 .novel/scenes.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "sample" }）将项目阶段更新为 "sample"。`,

  sample: `
**样章完成核验（落盘清单）**——3 章样章全部写完后逐项核对：
- 3 个章节正文文件（.novel/chapters/第N章.md；章节号即真实章节号，不另设样章编号）
- .novel/sample-feedback.md（3 篇样章复盘 + 末尾的大纲修订汇总）
- 大纲修订（.novel/outline/ 相关章节卡片与承诺等级已按复盘更新）
全部就绪后，通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "writing" }）将项目阶段更新为 "writing"。`,
};

/** 自治协议（替代采访式，用于无人值守的夜间探索等场景）。结构与 INTERVIEW_PROTOCOL 平行。 */
const AUTONOMOUS_PROTOCOL = [
  '',
  '## 本阶段的协作方式：自治式',
  '这是无人值守的自治运行。你不需要等待用户输入——所有创作决策由你自主做出。流程：',
  '1. **理解方向**：仔细阅读 User Request 中给定的创作方向（种子概念/世界类型/主角原型等）。',
  '2. **自主决策**：对于本阶段需要确定的创作选择（角色原型、世界类型、核心冲突等），基于给定方向自主选择最契合、最有戏剧张力的方案。不要用提问工具提问。',
  '3. **高质量产出**：按照 Skill Instructions 的质量标准，产出完整的阶段产出文件。',
  '4. **落盘**：将内容写入对应的 .novel/ 文件。',
  '5. **不要调用 PATCH API 推进阶段**——阶段推进由外部调度器控制。',
  '',
].join('\n');

/**
 * 按自治/采访模式组装规划阶段的指令。
 * - 采访式（默认）：STAGE_HEAD + INTERVIEW_PROTOCOL + 决策清单 + STAGE_TAIL
 * - 自治式：STAGE_HEAD + AUTONOMOUS_PROTOCOL + STAGE_TAIL
 * 大纲阶段（采访式）追加意图采集指令。
 * 非规划阶段（writing/drafting/revision/polish/decompose/enrich）返回空串，由调用方回退到 STAGE_INSTRUCTIONS。
 */
function buildStageInstructions(stage: string, autonomous: boolean): string {
  const head = STAGE_HEAD[stage];
  if (head === undefined) return '';
  const tail = STAGE_TAIL[stage] ?? '';
  const base = autonomous
    ? head + AUTONOMOUS_PROTOCOL + '\n' + tail
    : head + INTERVIEW_PROTOCOL + '\n' + (DECISION_PROMPTS[stage] ?? '') + tail;
  // 大纲阶段（采访式）：追加意图采集指令
  if (stage === 'outline' && !autonomous) {
    return base + INTENT_COLLECTION_INSTRUCTION;
  }
  return base;
}

/** 大纲阶段的意图采集指令：先读意图卡 → 追问「未设定」维度 → 合并写回。仅采访式（非自治）注入。 */
const INTENT_COLLECTION_INSTRUCTION = [
  '',
  '## 作者意图采集（仅大纲阶段）',
  '生成大纲前，先处理作者意图卡（.novel/intent.md）：',
  '1. 用 Read 读取 .novel/intent.md。若文件不存在，用 Write 按下方模板创建：',
  '',
  '```markdown',
  '# 作者意图卡',
  '',
  '> 本文件记录作者的创作意图与偏好。AI 生成、修订、评审均以此为准。',
  '> 可随时手动编辑；缺失维度用「未设定」标注。',
  '',
  '## 节奏偏好',
  '- 每章字数：未设定',
  '- 张弛密度：未设定',
  '- 断章钩子：未设定',
  '',
  '## 角色权重',
  '- 核心角色（弧线优先）：未设定',
  '- 不可死亡角色：未设定',
  '- 配角戏份上限：未设定',
  '',
  '## 伏笔风格',
  '- 长线/短线配比：未设定',
  '- 埋设密度：未设定',
  '- 回收节奏：未设定',
  '',
  '## 文风锚点',
  '- 语言密度：未设定',
  '- 对话/描写比例：未设定',
  '- 用词禁区：未设定',
  '',
  '## 理念冲突偏好',
  '- 理念冲突 vs 武力冲突比重：未设定',
  '- 说教容忍度：未设定',
  '- 理念呈现方式：未设定',
  '',
  '## 多线叙事规则',
  '- 单章视角数上限：未设定',
  '- 线路切换频率：未设定',
  '',
  '## 结局方向',
  '- 基调：未设定',
  '- 开放/闭合程度：未设定',
  '',
  '## 叙事手法',
  '- 倒叙/插叙容忍度：未设定',
  '- 时间跳跃：未设定',
  '```',
  '',
  '2. 对仍为「未设定」的维度，用提问工具（ask）逐维追问——选择题形式，每轮不超过 3 题；相关维度可合并一轮。',
  '3. 追问结果写回 intent.md：写入前重读文件，用 Edit 精确替换你追问过的维度小节，其他小节原样保留。',
  '4. 用户拒绝补充的维度保持「未设定」，不要编造。',
  '5. 生成大纲时严格以 intent.md 为约束；大纲内容不得违背其中已设定的偏好。',
].join('\n');

/** Plan Mode 叠加指令：先分析规划，不直接执行修改操作。 */
const PLAN_MODE_INSTRUCTION = [
  '',
  '## Plan Mode（规划模式）',
  '当前处于规划模式。请先协作制定计划，不要直接执行修改操作。',
  '',
  '要求：',
  '1. 先分析用户需求、当前上下文和风险；需要了解现状时可用 Read 等只读方式收集信息。',
  '2. 在 Plan Mode 中不要主动执行会改变作品或工作区状态的操作；等用户确认计划后再进入执行。',
  '3. 如果需求、范围或实现取舍存在不确定性，先用提问工具提问，不要把不确定点偷偷写成假设。',
  '4. 方案明确后，输出最终方案卡：用清晰 Markdown 列出目标、关键步骤和取舍，邀请用户确认后再执行。',
  '5. 不要在用户确认前写入任何文件或修改现有内容。',
  '',
].join('\n');


/** 写作阶段的输出协议约束（借鉴 denova 的输出协议设计）。 */
const WRITING_OUTPUT_PROTOCOL = [
  '',
  '## 章节正文输出协议（严格遵守）',
  '',
  '章节正文文件（.novel/chapters/ 下的 .md 文件）必须只包含故事正文。',
  '- 正文只写场景描写、人物动作、对话和后果。',
  '- 不要在正文中输出写作计划、解释说明、工具使用说明或 AI 自述。',
  '- 不要使用 Markdown 标记语法（如 ## 小标题、**加粗**、- 列表、> 引用、代码块）。',
  '- 段落间用空行分隔，不使用 Markdown 标题分割场景。',
  '- 不要在正文中包含状态信息、伏笔清单、角色状态 JSON 或任何结构化数据。',
  '- 不要输出"以上是第N章的内容"之类的元叙述收尾。',
  '- 唯一允许的文件首行格式：# 第N章 标题（仅文件首行标题，正文内不再重复）。',
].join('\n');

// 仅保留写作阶段；规划阶段（concept/world/characters/outline/scenes）指令
// 由 buildStageInstructions(stage, autonomous) 动态组装，见上方。
const STAGE_INSTRUCTIONS: Record<string, string> = {

  writing: `**写章前**：本章大纲与出场角色档案已注入上方上下文。无需再 Read 这些文件——直接基于注入内容写作。仅在需要查阅未注入细节（如某角色完整弧线、某武学体系全貌）时才 Read。

为小说撰写真正的散文正文。聚焦叙事流畅度、对话、描写与节奏，产出打磨过的草稿正文。将章节保存到 .novel/chapters/ 目录。

**元叙事禁令**：正文内严禁出现章节编号引用（如「第15章」「第十二章」等）。章节编号只能出现在文件首行标题（如「# 第3章 令牌」），绝不能在散文叙事中出现。角色不会知道自己身处「第几章」。

**写章流程（职责分离）**：

1. **你的核心职责是写正文**——专注产出高质量的章节散文，写完后保存到 .novel/chapters/ 目录。
2. **正文写完后，委托 state-patcher SubAgent 完成状态更新**——告知它章节文件路径和章号，让它自行：
   - 在 .novel/chapters/第N章.summary.md 生成本章语义摘要
   - 更新 .novel/character-states.md（角色位置/情绪/目标/关系变化）
   - 更新 .novel/progress.md（当前进度、最近章节摘要、下一步提示）
   - 更新 .novel/state.json（lastUpdatedChapter、timeline、activeForeshadows）
   - 更新 .novel/foreshadow.json（伏笔状态）
3. **如果当前 Agent 不支持 SubAgent**（如 OpenCode），则你需要自行完成上述状态更新。参见下方 SubAgent 使用指导。
4. **正文写作和状态更新不要混在一起**——先把正文写完保存，再做状态更新。避免写到一半停下来更新状态文件。

写完一章后，建议通过以下 API 自检质量：POST /api/projects/{projectId}/check/ai-patterns（body: {chapterNum: N}）检测 AI 味；如发现评分偏高，参照返回的 issues 逐条修改。
${WRITING_OUTPUT_PROTOCOL}`,
  sample: `**本阶段为自治写作阶段**：写 3 章样章检验声口与节奏，把发现的问题反馈回灌大纲。本章大纲与出场角色档案已注入上方上下文，无需再 Read。

**选章规则**：第 1 章（开篇定调）+ 从大纲 committed 章节中自选 2 个关键章节，建议挑声口差异最大的角色视角章，最大化检验叙事口吻的可区分度。

**章节号即真实章节号**：样章正文直接写入真实章节文件（写第 1 章就是 .novel/chapters/第1章.md，选了大纲第 N 章就写 .novel/chapters/第N章.md），不另设平行的样章编号体系。

**样章循环（每章执行一遍）**：
1. 按注入的大纲与上下文撰写该章正文，保存到 .novel/chapters/第N章.md
2. 正文落盘后，在 .novel/sample-feedback.md **追加**该章复盘（不覆盖前章），固定四节：
   - **声口落地**：视点角色的口吻是否立得住？与其他已写样章的声口是否可区分？
   - **节奏体感**：本章场景推进的松紧、断章钩子是否有效？
   - **世界观落地**：设定在正文中是否自然融入，有无与卡片冲突之处？
   - **大纲需修正点**：写作过程暴露出的大纲问题（节拍失效/动机牵强/信息顺序不当等）
3. 委托 state-patcher SubAgent 更新章节摘要与状态文件（与写作阶段相同的职责分离；不支持 SubAgent 时自行完成）

**3 章全部完成后（反馈回灌）**：
1. 按三篇复盘中的「大纲需修正点」修订对应的大纲章节卡片与承诺等级
2. 将修订汇总说明（改了哪些卡片、为什么）写入 .novel/sample-feedback.md 末尾
${STAGE_TAIL.sample}
${WRITING_OUTPUT_PROTOCOL}`,

  drafting: `为小说撰写真正的散文正文。聚焦叙事流畅度、对话、描写与节奏，产出打磨过的草稿正文。${WRITING_OUTPUT_PROTOCOL}`,
  revision: `审阅和改进已有内容。重点检查：(1) 剧情连贯性和逻辑漏洞；(2) 伏笔是否被遗忘（POST /api/projects/{projectId}/check/foreshadows）；(3) 人物行为是否偏离设定（POST /api/projects/{projectId}/check/ooc，body: {chapterNum: N}）；(4) 文笔AI味（POST /api/projects/{projectId}/check/ai-patterns，body: {chapterNum: N}）。根据检查报告逐章修订。`,
  polish: `最终润色。聚焦行文质量——用词精准度、句式节奏、对话自然度、描写具体化。删除抽象情绪标签和万能形容词，用具体细节替代。${WRITING_OUTPUT_PROTOCOL}`,
};

/**
 * 修订模式的指令（替代 STAGE_INSTRUCTIONS）。注入目标文件全文 + 修订意见 + 外科手术规则。
 * 设计依据见 spec §3.4。 */
function buildReviseInstructions(reviseContent: string, reviseNote: string, reviseFileList?: string[]): string {
  const isSplitDoc = reviseFileList && reviseFileList.length > 0;
  const fileListSection = isSplitDoc
    ? `
### 文件结构
这是一个**拆分式文档**，索引文件（index.md）仅记录目录，实际内容分布在以下卡片文件中：
${reviseFileList!.map((f) => `- \`.novel/${f}\``).join('\n')}

修订时请用 Read 工具读取相关卡片文件确认内容，用 Edit 工具直接修改对应的卡片文件（而非 index.md）。
`
    : '';

  const targetHeader = isSplitDoc
    ? '### 目标文档全文（合并自索引 + 所有卡片文件）\n以下内容已读入上下文供你参考，实际修改时请针对具体卡片文件使用 Edit 工具：'
    : '### 目标文件\n以下是你需要修订的文件全文（已读入上下文，无需再 Read）：';

  return `## 当前任务：修订已有内容

你不是在从零创作，而是在对一份已有的文件做**定向修订**。
${fileListSection}
${targetHeader}

\`\`\`
${reviseContent}
\`\`\`

### 修订意见
${reviseNote}

### 修订规则（严格遵守）

1. **必须用 Edit 工具做外科手术修改**——只改动与修订意见直接相关的段落，其余原封不动。
2. **禁止重写整篇**——如果你的改动会超过文件 30% 的内容，停下来在回复里说明原因，建议用户将修订拆分为多次。
3. **保留原文风格**——修订是定向调整，不是风格重写。不要“顺手”优化你没被要求改的句子。
4. **保存修改**——用 Edit 工具直接修改原文件（Edit 会直接写盘，不需要额外的 Write）。对整个文件的重建式改动才用 Write。
5. **简短说明**——在回复中用 2-3 句话说明你改了什么、为什么，便于用户判断是否符合预期。

### 输出协议
修订后的文件同样必须只包含故事正文，不要包含解释说明、Markdown 标记或元叙述。`;
}

/**
 * 构建异常中断恢复提示词。
 * 借鉴 denova 的 ResumeFromInterruption，在用户"继续"时拼入中断现场。
 */
function buildInterruptedResumeInstruction(
  currentMessage: string,
  resume: { userMessage: string; assistantContent: string; reason: string },
): string {
  const sections: string[] = ['[异常中断恢复]'];
  sections.push('用户当前要求继续。请从上一轮异常中断的位置继续，不要重做已经完成且已经写入文件的工作。');
  sections.push('如果上一轮已有部分助手输出，请把它作为已完成内容的上下文，继续完成原始请求。');
  sections.push('');
  sections.push('上一轮原始请求：');
  sections.push(resume.userMessage);
  if (resume.assistantContent) {
    sections.push('');
    sections.push('上一轮中断前已生成的助手内容：');
    sections.push(resume.assistantContent);
  }
  if (resume.reason) {
    sections.push('');
    sections.push('上一轮中断原因：');
    sections.push(resume.reason);
  }
  sections.push('');
  sections.push('本轮用户继续请求：');
  sections.push(currentMessage);
  return sections.join('\n');
}

/**
 * List project files (names only, no content).
 */
async function listProjectFiles(projectDir: string): Promise<string[]> {
  try {
    const novelDir = path.join(projectDir, '.novel');
    const entries = await fs.readdir(novelDir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith('.md') || e.name.endsWith('.json')))
      .map((e) => {
        const fullPath = path.join(e.parentPath ?? novelDir, e.name);
        return fullPath.replace(projectDir + '/', '');
      });
  } catch {
    return [];
  }
}

/** 写作型阶段（含 sample 样章）统一使用 shared/stages 的 isWritingStage：
 * 这些阶段需要注入写作分层上下文（滚动摘要/状态/伏笔等），concept→scenes 阶段不注入。 */

/** 规划阶段：预注入 concept/world 核心设定文件，省去 agent 多轮 Read 往返。 */
const PLANNING_STAGES = new Set(['concept', 'world', 'characters', 'outline', 'scenes']);

function isPlanningStage(stage: string): boolean {
  return PLANNING_STAGES.has(stage);
}

/**
 * 检测用户消息与当前阶段的错配。
 *
 * Bug #4 的根因：用户说“写第3章”但项目还在 scenes 阶段时，agent 收到矛盾指令
 * （用户要写章节但 SKILL 说规划场景），最终产出 0 个文件。
 *
 * 本函数不自动切换阶段（可能有未完成的场景规划），而是在提示词头部注入
 * 明确的提醒，让 agent 告诉用户需要先切换阶段。
 */
function detectStageMismatch(message: string, stage?: string): string {
  if (!stage || !message) return '';

  // 检测写作意图
  const writingIntentPatterns = [
    /写第\s*[\d一二三四五六七八九十百零]+\s*章/,
    /写下一章/,
    /继续写/,
    /写章节/,
    /开始写作/,
    /写正文/,
  ];
  const wantsWriting = writingIntentPatterns.some((p) => p.test(message));

  if (wantsWriting && !isWritingStage(stage)) {
    return `> ⚠️ **阶段不匹配提醒**
> 用户消息包含写作意图（如“写第N章”），但当前项目阶段是「${stage}」。
> 写作阶段（sample 样章 / writing）的提示词和上下文层尚未注入——现在写章节会缺少必要的前期设定。
>
> **请在回复中明确告知用户**：当前阶段是「${stage}」，需要先完成当前阶段并切换到 sample（样章）阶段；写满 3 章样章后系统才放行 writing 阶段。
> 如果用户确实想跳过样章直接进入正式写作，请告诉他们可通过 PATCH /api/projects/{id} 切换阶段（后端对未达 3 章正文的 writing 请求会返回样章门拦截）。
> 不要在错误的阶段下直接写章节文件。\n`;
  }

  return '';
}

/** 读取 `.novel/` 下指定相对路径文件内容，失败返回空串。 */
async function readNovelFile(projectDir: string, relativePath: string): Promise<string> {
  try {
    const full = path.join(projectDir, '.novel', relativePath);
    return (await fs.readFile(full, 'utf-8')).trim();
  } catch {
    return '';
  }
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字（1-999）转阿拉伯数字；无法解析返回 null。 */
function cnNumberToInt(s: string): number | null {
  const t = s.trim();
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10);
    return n > 0 && n < 10000 ? n : null;
  }
  if (!/^[零一二两三四五六七八九十百]+$/.test(t)) return null;
  let total = 0;
  let section = 0;
  for (const ch of t) {
    if (ch === '十') {
      section = (section === 0 ? 1 : section) * 10;
      total += section;
      section = 0;
    } else if (ch === '百') {
      section = (section === 0 ? 1 : section) * 100;
      total += section;
      section = 0;
    } else {
      section = CN_DIGITS[ch];
    }
  }
  total += section;
  return total > 0 ? total : null;
}

/**
 * 从用户消息解析显式目标章号（「写第3章」「写第十二章」等）。
 * 返回 null 表示消息未指定章号（「写下一章」「继续写」）。
 */
export function parseChapterNumberFromMessage(message: string): number | null {
  if (!message) return null;
  const m = message.match(/写第\s*([0-9零一二两三四五六七八九十百]+)\s*章/);
  if (!m) return null;
  return cnNumberToInt(m[1]);
}

/**
 * 扫描 .novel/chapters/ 找最小未写章号（从 1 起第一个没有正文文件的章号）。
 * 全部已写则返回 最大章号+1；目录为空/不存在返回 1。
 * 只认正文章节命名（第N章.md / chapter-N.md），忽略摘要与归档文件。
 */
export async function findNextUnwrittenChapter(projectDir: string): Promise<number> {
  const chaptersDir = path.join(projectDir, '.novel', 'chapters');
  let files: string[];
  try {
    files = await fs.readdir(chaptersDir);
  } catch {
    return 1;
  }
  const nums = new Set<number>();
  for (const f of files) {
    const cn = f.match(/^第(\d+)章\.md$/);
    const en = f.match(/^chapter-(\d+)\.md$/i);
    const m = cn ?? en;
    if (m) nums.add(parseInt(m[1], 10));
  }
  let next = 1;
  while (nums.has(next)) next++;
  return next;
}

/**
 * 意图层：读取 .novel/intent.md（作者创作偏好），全量注入 prompt。
 * 文件缺失或为空返回空串——run 不阻断，存量项目平滑过渡。
 */
async function buildIntentLayer(projectDir: string): Promise<string> {
  const content = await readNovelFile(projectDir, 'intent.md');
  if (!content) return '';
  return `\n## 作者意图（以此为准）\n${content}`;
}

/** 核心设定层（恒定）：concept + world 索引注入，按需 Read 卡片。
 * 拆分后每个节文件是合理大小，不再需要截断 hack。 */
/** 角色档案层超过此长度时退化为索引模式（只注入角色名+按需读取提示）。 */
const CAST_INDEX_THRESHOLD = 6000;

async function buildCoreSettingsLayer(projectDir: string): Promise<string> {
  const blocks: string[] = [];

  // concept 索引
  const conceptIndex = await readNovelFile(projectDir, 'concept/index.md');
  if (conceptIndex) {
    blocks.push(`#### 故事概念索引 (concept/index.md)\n${conceptIndex}\n> 如需详细要素，用 Read 工具读取 concept/具体要素.md`);
  }

  // world 索引
  const worldIndex = await readNovelFile(projectDir, 'world/index.md');
  if (worldIndex) {
    blocks.push(`#### 世界观索引 (world/index.md)\n${worldIndex}\n> 如需详细设定，用 Read 工具读取 world/具体节.md`);
  }

  if (blocks.length === 0) return '';
  return `### 核心设定层（恒定）\n${blocks.join('\n\n')}`;
}

/** 预注入预算上限：超过此值退化为索引模式。 */
const PLANNING_CONTEXT_BUDGET = 80 * 1024; // 80KB

/** 规划阶段预注入的目录（按优先级排序）。 */
const PLANNING_DIRS = ['concept', 'world'];

/**
 * 读取 .novel/{dir}/ 下所有 .md 文件内容，按文件名排序返回。
 */
async function readNovelDirFiles(
  projectDir: string,
  dir: string,
): Promise<Array<{ rel: string; content: string }>> {
  const dirPath = path.join(projectDir, '.novel', dir);
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return [];
  }
  const result: Array<{ rel: string; content: string }> = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.md')) continue;
    const content = await readNovelFile(projectDir, `${dir}/${name}`);
    if (content) {
      result.push({ rel: `${dir}/${name}`, content });
    }
  }
  return result;
}

/**
 * 为规划阶段预注入核心设定文件内容，省去 agent 多轮 Read 往返。
 *
 * 背景：按请求计费模式下，concept 阶段 agent 平均需读 5-10 个文件
 * （2-3 轮 LLM 调用）。预注入可省去全部 Read 轮次。
 *
 * 注入范围：concept/ 全部 .md + world/ 全部 .md + outline-brief.md。
 * 总量超 80KB 时退化为索引模式（只注入文件名列表 + 按需 Read 提示）。
 */
async function buildPlanningContextLayer(projectDir: string): Promise<string> {
  const files: Array<{ rel: string; content: string }> = [];

  for (const dir of PLANNING_DIRS) {
    files.push(...await readNovelDirFiles(projectDir, dir));
  }

  const brief = await readNovelFile(projectDir, 'outline-brief.md');
  if (brief) {
    files.push({ rel: 'outline-brief.md', content: brief });
  }

  if (files.length === 0) return '';

  const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);

  if (totalSize > PLANNING_CONTEXT_BUDGET) {
    const fileList = files.map((f) => `- ${f.rel}`).join('\n');
    return `## 项目核心设定索引\n以下文件已存在但未注入全文（总量 ${Math.round(totalSize / 1024)}KB 超过 80KB 预算）。\n如需了解具体内容，请用 Read 工具读取相关文件。\n\n${fileList}`;
  }

  const blocks = files.map((f) => `### ${f.rel}\n${f.content}`);
  return `## 项目核心设定（已注入——无需再 Read）\n\n${blocks.join('\n\n')}`;
}

/** 文风参考索引层：列出可用文风参考文件，不注入全文。 */
async function buildStyleRefLayer(projectDir: string): Promise<string> {
  const refs = await getStyleRefs(projectDir);
  if (refs.length === 0) return '';
  const lines: string[] = ['### 文风参考索引'];
  lines.push('以下文风参考文件可用。如本轮涉及章节正文创作/续写/重写，请在写作前用 Read 工具读取最相关的参考文件：');
  for (const ref of refs) {
    lines.push(`- **${ref.name}**：${ref.description}（路径：.novel/styles/${ref.path}）`);
  }
  return lines.join('\n');
}

/** 状态层：角色位置/情绪/已知信息/关系 + 时间线（来自 state.json）。 */
async function buildStateLayer(projectDir: string): Promise<string> {
  const state = await getStateTable(projectDir);
  if (
    state.characters.length === 0 &&
    !state.timeline &&
    state.activeForeshadows.length === 0
  ) {
    return '';
  }
  const lines: string[] = ['### 状态层'];
  if (state.timeline) {
    lines.push(`- 时间线：${state.timeline}`);
  }
  for (const c of state.characters) {
    const segs: string[] = [`**${c.name}**`];
    if (c.location) segs.push(`位置=${c.location}`);
    if (c.emotion) segs.push(`情绪=${c.emotion}`);
    if (c.knows.length > 0) segs.push(`已知=[${c.knows.join('；')}]`);
    const rels = Object.entries(c.relationships);
    if (rels.length > 0) {
      segs.push(`关系=[${rels.map(([k, v]) => `${k}:${v}`).join('；')}]`);
    }
    if (c.lastAppearance > 0) segs.push(`最后出场=第${c.lastAppearance}章`);
    lines.push(`- ${segs.join('；')}`);
  }
  return lines.join('\n');
}

/** 进度层：从 progress.md 读取写作进度。 */
async function buildProgressLayer(projectDir: string): Promise<string> {
  const progress = await getProgressMarkdown(projectDir);
  if (!progress) return '';
  return `### 写作进度层（progress.md）\n${progress}`;
}

/** 角色状态层：从 character-states.md 读取角色当前状态。 */
async function buildCharacterStatesLayer(projectDir: string): Promise<string> {
  const states = await getCharacterStatesMarkdown(projectDir);
  if (!states) return '';
  return `### 角色当前状态层（character-states.md）\n${states}`;
}

/**
 * 解析 foreshadow.json（宽容解析 + 旧格式迁移），返回伏笔清单。
 * 调用方据此做分区注入；旧格式的 plantedIn 自由文本由 parseForeshadowFile
 * 提取章号（"第64-66章"→64），提取失败降级为 null 并保留 rawPlantedIn。
 */
export async function loadForeshadows(projectDir: string): Promise<{
  foreshadows: Foreshadow[];
}> {
  const raw = await readNovelFile(projectDir, 'foreshadow.json');
  if (!raw) return { foreshadows: [] };
  return { foreshadows: parseForeshadowFile(raw).foreshadows };
}

/** 伏笔条目标注前缀：[类型][权重]。 */
function foreshadowBadges(f: Foreshadow): string {
  const type = FORESHADOW_TYPE_LABELS[f.type] ?? FORESHADOW_TYPE_LABELS.chekhov;
  const weight = FORESHADOW_WEIGHT_LABELS[f.weight] ?? FORESHADOW_WEIGHT_LABELS.light;
  return `[${type}][${weight}]`;
}

/** 未结清（待埋/已埋未收）才需要逾期报警；resolved/dropped 不再报警。 */
function foreshadowUnsettled(f: Foreshadow): boolean {
  return f.status === 'pending' || f.status === 'planted';
}

/**
 * 伏笔条目括注：埋设章 / 期限章（含逾期标记）/ 前置依赖链。
 * planned=true 时埋设章显示为「应埋于」（该条仍是 pending，尚未真正落笔）。
 */
function foreshadowMetaNote(f: Foreshadow, currentChapter: number, planned = false): string {
  const segs: string[] = [];
  if (f.plantedIn !== null) {
    segs.push(planned ? `应埋于第${f.plantedIn}章` : `埋于第${f.plantedIn}章`);
  }
  if (f.resolveDeadline !== null) {
    const overdue = foreshadowUnsettled(f) && f.resolveDeadline < currentChapter;
    segs.push(`期限：第${f.resolveDeadline}章前回收${overdue ? ' ⚠已逾期' : ''}`);
  }
  if (f.dependsOn.length > 0) {
    segs.push(`前置：${f.dependsOn.map((d) => `#${d}`).join('、')}`);
  }
  return segs.length > 0 ? `（${segs.join('｜')}）` : '';
}

/** 全书章数：统计 .novel/chapters/ 下的 第N章.md；0 表示未知（跳过孤儿判定）。 */
async function readNovelChapterCount(projectDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(path.join(projectDir, '.novel', 'chapters'));
    const nums = entries
      .map((f) => parseInt(f.match(/^第(\d+)章\.md$/)?.[1] ?? '', 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    return nums.length === 0 ? 0 : Math.max(...nums, nums.length);
  } catch {
    return 0;
  }
}

/**
 * 本章须埋设的伏笔：plantedIn === currentChapter 且 status 仍为 pending 的条目。
 * 返回「置顶提醒」区块（含 [类型][权重]、期限、前置依赖标注），空则返回空串。
 */
async function buildCurrentChapterForeshadows(
  projectDir: string,
  currentChapter: number,
): Promise<string> {
  const { foreshadows } = await loadForeshadows(projectDir);
  const toPlant = foreshadows.filter(
    (f) => f.status === 'pending' && f.plantedIn === currentChapter,
  );
  if (toPlant.length === 0) return '';
  const lines: string[] = [`### ⚠ 本章须埋设的伏笔（plantedIn=${currentChapter}，切勿遗漏）`];
  for (const f of toPlant) {
    lines.push(`- [#${f.id}] ${foreshadowBadges(f)} ${f.content}${foreshadowMetaNote(f, currentChapter, true)}`);
  }
  return lines.join('\n');
}

/**
 * 活跃伏笔层（债务视角）：
 * - 「待回收」区 = status === 'planted'（已埋进故事，等待兑现），标注期限与依赖
 * - 「逾期未埋」区 = status === 'pending' 且 plantedIn < currentChapter
 *   （规划埋在本章或更早但状态仍未推进——提醒 agent 补埋或放弃）
 * - 「密度预算」行 = 每 3 章新埋不超过 2 条；超支报警并给出本章可新埋配额
 * - 「孤儿章号警告」= plantedIn 超出全书章数（引用了不存在/超范围的章号）
 * status === 'pending' 且 plantedIn >= currentChapter 的伏笔不在此层显示
 * （未来伏笔，避免信息过载），由 buildCurrentChapterForeshadows 在写作时定向提醒。
 */
async function buildForeshadowLayer(
  projectDir: string,
  currentChapter: number,
): Promise<string> {
  const { foreshadows } = await loadForeshadows(projectDir);
  if (foreshadows.length === 0) return '';

  const planted = foreshadows.filter((f) => f.status === 'planted');
  const overduePending = foreshadows.filter(
    (f) => f.status === 'pending' && f.plantedIn !== null && f.plantedIn < currentChapter,
  );
  const chapterCount = await readNovelChapterCount(projectDir);
  const orphaned = chapterCount > 0
    ? foreshadows.filter((f) => f.plantedIn !== null && f.plantedIn > chapterCount)
    : [];
  if (planted.length === 0 && overduePending.length === 0 && orphaned.length === 0) return '';

  const lines: string[] = ['### 活跃伏笔层'];
  if (planted.length > 0) {
    lines.push('**待回收**（已埋进故事，等待兑现）：');
    for (const f of planted) {
      lines.push(`- [#${f.id}] ${foreshadowBadges(f)} ${f.content}${foreshadowMetaNote(f, currentChapter)}`);
    }
  }
  if (overduePending.length > 0) {
    lines.push('**逾期未埋**（规划章号已过但状态仍为 pending——补埋或标记放弃）：');
    for (const f of overduePending) {
      lines.push(`- [#${f.id}] ${foreshadowBadges(f)} ${f.content}${foreshadowMetaNote(f, currentChapter, true)}`);
    }
  }
  if (orphaned.length > 0) {
    lines.push(`**⚠ 孤儿章号警告**（plantedIn 超出全书 ${chapterCount} 章——章号疑似错误，请修正或标记放弃）：`);
    for (const f of orphaned) {
      lines.push(`- [#${f.id}] ${f.content}（plantedIn=${f.plantedIn}）`);
    }
  }

  // 密度预算：默认「每 3 章新埋不超过 2 条」，按当前窗口实际新埋量判定是否超支。
  const budget = computeDensityBudget(foreshadows, currentChapter);
  lines.push(`**密度预算**（默认规则：每 ${budget.windowSize} 章新埋不超过 ${budget.limit} 条）：`);
  lines.push(
    `- 近 ${budget.windowSize} 章（第${budget.windowStart}~${currentChapter}章）新埋 ${budget.plantedInWindow}/${budget.limit} 条，`
    + `${budget.overBudget ? '⚠已超支，本章暂停新埋' : '未超支'}；`
    + `本章到期应回收 ${budget.dueForResolve} 条、可新埋 ${budget.canPlantNow} 条`,
  );
  return lines.join('\n');
}

/**
 * 按承诺等级生成本章大纲的框架语。
 * - committed：写作依据，正文不得偏离；
 * - tentative：可被正文推翻，推翻时须回写大纲；
 * - open：本章可自行决定，写完回填大纲与 openQuestions 决策结果。
 */
function commitmentFraming(chapter: number, outline: ChapterOutline): string {
  switch (outline.commitment) {
    case 'committed':
      return '> 本章大纲承诺等级：**committed（已定）**——写作依据，必须严格遵循；正文不得偏离其中的场景、冲突与结果。';
    case 'open': {
      const questions =
        outline.openQuestions.length > 0
          ? outline.openQuestions.map((q) => `> - ${q}`).join('\n')
          : '> - （卡片未登记 open-questions，写作时可先补充待决策问题）';
      return `> 本章大纲承诺等级：**open（待决策）**——本章走向可自行决定。写完后回填 outline/chapters/第${chapter}章.md：更新大纲内容、将承诺等级升级为 tentative/committed，并记录下列待决策问题的决策结果：\n${questions}`;
    }
    default:
      return `> 本章大纲承诺等级：**tentative（倾向）**——可被正文推翻；若实际走向偏离大纲，须在章末摘要中记录偏离点，并回写 outline/chapters/第${chapter}章.md 大纲。`;
  }
}

/**
 * 为写作阶段组装分层上下文：
 * 核心设定（恒定）→ 状态 → 滚动摘要 → 活跃伏笔。
 * 任一层缺失则跳过；整体为空时仍返回占位说明，提示 agent 维护摘要与状态。
 */
async function buildWritingContextLayers(
  projectDir: string,
  currentChapter: number,
): Promise<string> {
  const sections: string[] = [];

  const core = await buildCoreSettingsLayer(projectDir);
  if (core) sections.push(core);

  const styleRef = await buildStyleRefLayer(projectDir);
  if (styleRef) sections.push(styleRef);

  const stateLayer = await buildStateLayer(projectDir);
  if (stateLayer) sections.push(stateLayer);

  const progressLayer = await buildProgressLayer(projectDir);
  if (progressLayer) sections.push(progressLayer);

  const charStatesLayer = await buildCharacterStatesLayer(projectDir);
  if (charStatesLayer) sections.push(charStatesLayer);

  // 本章大纲块（按承诺等级注入不同框架语：committed=写作依据 / tentative=可推翻须回写 / open=自行决定须回填）
  const outline = await extractChapterOutline(projectDir, currentChapter);
  if (outline.content) {
    sections.push(`### 本章大纲（第${currentChapter}章）\n${outline.content}\n\n${commitmentFraming(currentChapter, outline)}`);
  }

  // 精排窗口（写作驱动精化：近章须达 beat 级，远粗是设计而非未完成）
  const state = await getStateTable(projectDir);
  const refineFrom = state.lastUpdatedChapter + 1;
  const refineTo = state.lastUpdatedChapter + 10;
  sections.push(
    `### 精排窗口\n精排窗口：第 ${refineFrom}..${refineTo} 章应达 beat 级（场景/冲突/结果齐备）；其中仍为 tentative/open 的章节，先精化对应大纲卡片再写。远期章节保持 arc/骨架级是设计意图，无需提前补全。`,
  );

  // 本章出场角色层（渐进式：内容过长时退化为索引模式）
  const knownNames = await readCharacterNames(projectDir);
  const cast = await identifyCast(projectDir, currentChapter, outline.content, knownNames);
  const castLayer = await buildCastLayer(projectDir, cast);
  if (castLayer) {
    // 如果角色档案内容过长，改为索引模式——只注入角色名 + 按需读取提示
    if (castLayer.length > CAST_INDEX_THRESHOLD) {
      // 合并 POV + full + brief，去重保序
      const seen = new Set<string>();
      const castNames: string[] = [];
      for (const name of [cast.pov, ...cast.full, ...cast.brief]) {
        if (name && !seen.has(name)) {
          seen.add(name);
          castNames.push(name);
        }
      }
      sections.push(`### 本章出场角色索引\n本章涉及角色：${castNames.join('、')}\n角色详细档案见 .novel/characters/profiles/ 目录下的各角色 .md 文件。如需了解某角色的完整设定（动机、背景、弧光），请用 Read 工具读取。`);
    } else {
      sections.push(castLayer);
    }
  }

  const rolling = await buildRollingSummaryContext(projectDir);
  if (rolling) {
    sections.push(`### 滚动摘要层（最近 3 章详摘，更早章节简摘）\n${rolling}`);
  } else {
    sections.push(
      '### 滚动摘要层\n（暂无章节摘要。每写完一章请在 `.novel/chapters/第N章.summary.md` 生成 200 字摘要。）',
    );
  }

  const foreshadow = await buildForeshadowLayer(projectDir, currentChapter);
  if (foreshadow) sections.push(foreshadow);

  return `## Novel Context Layers\n\n${sections.join('\n\n')}`;
}

const TOOL_INSTRUCTIONS = `## Available Tools

You have access to the following tools:

- **Read** — Read a file. Use: { "file_path": "path/to/file" }
- **Write** — Write a file (creates or overwrites). Use: { "file_path": "path/to/file", "content": "file content" }
- **Edit** — Edit a file with find-and-replace. Use: { "file_path": "path/to/file", "old_string": "text to find", "new_string": "replacement text" }
- **Bash** — Run a shell command. Use: { "command": "command to run" }
- **提问工具 (ask)** — 向用户呈现可点击选项让其做选择。使用方式：调用 ask 工具，提供 questions 数组，每题含 id、question、options（3-5 个选项，每项含 label 和 description）。

## Important Tool Usage Rules

1. **Always Read before Write** — You MUST read a file before writing to it. The Write tool requires the file to have been read first. If you need to create a new file or overwrite an existing one, read it first (even if it's empty or a template).
2. **Use Edit for partial changes** — When modifying specific parts of a file, use Edit instead of Write to preserve unchanged content.
3. **Use 提问工具 (ask)** — When you need user input to proceed (e.g., choosing between approaches, clarifying requirements). NEVER present A/B/C options as text tables/lists in your reply expecting the user to type back a letter — always call the ask tool so the user gets clickable options.`;

const OUTPUT_FORMAT = `## Output Format

- Use markdown for all content
- Chapter content: use standard prose paragraphs, no markdown headers inside chapters
- Outlines: use hierarchical markdown headers and bullet points
- Character profiles: use structured sections with headers
- When saving files, use appropriate markdown formatting for the content type`;

export async function composePrompt(options: ComposePromptOptions): Promise<string> {
  const { message, projectId, skillId, stage, projectDir, history,
          mode = 'generate', reviseTarget, reviseNote, reviseContent, reviseFileList,
          autonomous = false, planMode = false, deepenContext, agentId,
          interruptedResume } = options;

  const isRevise = mode === 'revise' && !!reviseNote && !!reviseContent;
  // revise 模式下，判断目标是否为章节正文（路径匹配 chapters/第N章.md）
  const isChapterTarget = isRevise && !!reviseTarget
    ? /^chapters[/\\]第\d+章\.md$/.test(reviseTarget)
    : false;

  // 阶段不匹配检测：用户消息含写作意图但当前阶段不是 writing。
  // 根因：agent 在错误阶段收到写作指令时，提示词要求的是场景规划而非章节写作，
  // 导致产出 0 个文件，浪费额度。这里在提示词头部注入明确提示。
  const STAGE_MISMATCH_HINT = detectStageMismatch(message, stage);

  // Load project metadata from DB
  let projectContext = '';
  let projectMeta: { targetWords: number | null; chapterCount: number | null } | null = null;
  try {
    const project = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (project.length > 0) {
      const p = project[0];
      projectMeta = { targetWords: p.targetWords, chapterCount: p.chapterCount };
      projectContext = [
        `Project: ${p.title}`,
        `Genre: ${p.genre}`,
        `Theme: ${p.theme || 'Not specified'}`,
        `Perspective: ${p.perspective}`,
        `Target word count: ${p.targetWords}`,
        `Chapter count: ${p.chapterCount}`,
        `Current stage: ${p.currentStage}`,
      ].join('\n');
    }
  } catch {
    projectContext = 'Project metadata unavailable.';
  }

  // Load skill content from plugin registry
  let skillContent = '';
  if (skillId) {
    const plugin = getPlugin(skillId);
    if (plugin) {
      skillContent = plugin.skillContent;
    }
  }

  // List project files (names only - agent reads content itself)
  const fileList = await listProjectFiles(projectDir);

  // Stage-specific instructions (generate 模式) 或 revise 指令 (revise 模式)
  const currentStage = stage || 'concept';
  const stageInstructions = isRevise
    ? buildReviseInstructions(reviseContent!, reviseNote!, reviseFileList)
    : currentStage === 'decompose'
      ? buildReverseDecomposePrompt({
          projectDir,
          chapterCount: projectMeta?.chapterCount ?? 0,
        })
      : currentStage === 'enrich'
        ? buildEnrichPrompt({ projectDir, skillId })
        : buildStageInstructions(currentStage, autonomous)
          || STAGE_INSTRUCTIONS[currentStage]
          || `着手推进小说项目的「${currentStage}」阶段。`;

  // Plan Mode 叠加层
  const effectiveStageInstructions = planMode
    ? stageInstructions + PLAN_MODE_INSTRUCTION
    : stageInstructions;

  // 全局「指令优先级」块中两条协作规则，按 autonomous 切换
  const collaborationRule = autonomous
    ? `- **按阶段切换协作方式**：
  - 规划阶段（concept / world / characters / outline / scenes）采用「自治式」——基于 User Request 给定的方向自主决策并落盘，**禁用提问工具提问**，不要等待用户输入。
  - 写作阶段（writing / drafting / revision / polish）同样自治——基于注入的上下文直接撰写章节正文。`
    : `- **按阶段切换协作方式**：
  - 规划阶段（concept / world / characters / outline / scenes）采用「采访式」——动手落盘前，用提问工具就关键创作决策与用户确认（详见各 Stage 指令中的「采访式」流程）。
  - 写作阶段（writing / drafting / revision / polish）采用「自治式」——基于注入的上下文直接撰写章节正文，写完在回复里说明你的选择即可；只有遇到会从根本上改变后续几万字走向且无法回滚的岔路口时，才用提问工具问一个问题。`;

  const questionRule = autonomous
    ? '- **禁用提问工具**：本会话为无人值守自治运行，所有创作决策由你自主做出。'
    : '- **何时用提问工具**：当需要用户在创作方向上拍板时使用（规划阶段的关键决策、写作阶段无法回滚的岔路口）；纯执行与文笔打磨一律自行判断，不要为细节反复打断用户。\n- **禁止用文字代替提问工具**：当你准备了 A/B/C 等多个方案需要用户选择时，必须调用提问工具，禁止在回复正文中用表格或列表列出方案让用户打字回复。正确做法：先在正文中写出分析和推荐理由，然后调用提问工具呈现选项。';

  // Compose the full prompt
  // 创作者指令（CREATOR.md）：用户自定义的最高优先级约束，覆盖以下所有指令。
  const creatorPrompt = await readNovelFile(projectDir, 'CREATOR.md');

  const parts: string[] = [];

  if (STAGE_MISMATCH_HINT && !isRevise) {
    parts.push(STAGE_MISMATCH_HINT);
  }

  // 创作者指令置于提示词最开头（阶段错配提示之后、角色定义之前），
  // 以最高优先级覆盖后续所有指令。
  if (creatorPrompt) {
    parts.push(`# 创作者指令（最高优先级——覆盖以下所有指令）\n\n${creatorPrompt}`);
  }

  parts.push(`你是一位小说创作助手。你帮助用户写作、结构和精炼他们的小说。保持创意、周到、有支持性。被要求时撰写高质量散文，规划时提供清晰的结构性指导。

# 指令优先级（最高——覆盖系统加载的任何其他 Skill）

本会话是受控的小说创作环境。系统可能加载了 superpowers、brainstorming 等第三方 Skill——**它们的工作流（尤其是 brainstorming 的“先提设计、等用户审批再写”的 HARD-GATE）不适用于本环境**。原因：小说创作的每个阶段都有明确的产出文件和验收标准，已由本指令和 Stage 指令定义；brainstorming 式的“每步停下来等审批”会把这些流程拖成无意义的反复确认。

铁律：
${collaborationRule}
- **不调用 Skill 工具**：不要调用 Skill / superpowers:brainstorming 等。你需要的所有创作方法论已在下方 Skill Instructions 提供。
${questionRule}

## 文件访问规则
- 你只能读写项目目录内的文件：${projectDir}
- 所有小说内容放在 .novel/ 子目录下
- 章节放在 .novel/chapters/ 目录下
- 绝不访问项目目录之外的文件
- 绝不访问系统文件、环境变量或凭据`);

  parts.push(`\n## Project Context\n${projectContext}`);

  // 作者意图层：意图卡（intent.md）作为硬约束，置于阶段指令之前
  const intentLayer = await buildIntentLayer(projectDir);
  if (intentLayer) {
    parts.push(intentLayer);
  }

  parts.push(`\n## Current Stage: ${currentStage}\n${effectiveStageInstructions}`);

  if (fileList.length > 0) {
    parts.push(`\n## Project Files\n${fileList.map((f) => `- ${f}`).join('\n')}`);
  }

  // Deepen 深化循环：注入当前 stage 产出文件 + critique（Revise 轮），
  // 省去 agent 每轮 Read 往返（每轮省 2-4 次 LLM 调用）
  if (deepenContext) {
    const stageFiles = STAGE_OUTPUT_FILES[currentStage] || [];
    const fileBlocks: string[] = [];
    for (const rel of stageFiles) {
      const content = await readNovelFile(projectDir, rel);
      if (content) {
        fileBlocks.push(`### ${rel}\n${content}`);
      }
    }
    if (fileBlocks.length > 0) {
      parts.push(`\n## 当前阶段产出文件（已注入——无需再 Read）\n${fileBlocks.join('\n\n')}`);
    }

    // Revise 轮（偶数轮）：注入最新审查报告
    if (!isCritiqueRound(deepenContext.round)) {
      const critique = await readNovelFile(projectDir, 'deepen-critique.md');
      if (critique) {
        parts.push(`\n## 最新审查报告（deepen-critique.md 已注入——无需再 Read）\n${critique}`);
      }
    }
  }

  // 写作阶段（generate）或章节修订（revise）：注入字数目标 + 分层上下文
  const needsWritingContext = isWritingStage(currentStage) || (isRevise && isChapterTarget);
  if (needsWritingContext) {
    // P1 缺陷4: 动态注入每章字数目标
    if (projectMeta?.targetWords && projectMeta?.chapterCount) {
      const perChapter = Math.round(projectMeta.targetWords / projectMeta.chapterCount);
      parts.push(`\n## 本章字数要求\n每章目标约 ${perChapter} 字（CJK 字符），允许 ±20% 浮动。偏差超 ±30% 将被系统标记为字数异常。`);
    }

    // 计算当前章号：优先用户消息显式指定的章号（写第N章），
    // 章节修订（revise）优先取修订目标文件的章号，
    // 否则扫描 chapters/ 目录取最小未写章（从 1 起第一个缺文件的章）。
    // 不再用 state.lastUpdatedChapter+1——样章阶段写第1章+自选2章后 state 停在
    // 最后一个样章号，会跳过中间未写章节。
    const targetChapter = isChapterTarget && reviseTarget
      ? (parseInt(reviseTarget.match(/第(\d+)章/)?.[1] ?? '', 10) || null)
      : null;
    const currentChapter = targetChapter
      ?? parseChapterNumberFromMessage(message)
      ?? await findNextUnwrittenChapter(projectDir);

    // 定向提醒：本章须埋设的伏笔，置顶于分层上下文之前（仅 generate 模式；revise 不埋新伏笔）
    if (mode === 'generate') {
      const chapterForeshadow = await buildCurrentChapterForeshadows(projectDir, currentChapter);
      if (chapterForeshadow) {
        parts.push(`\n${chapterForeshadow}`);
      }
    }

    const layers = await buildWritingContextLayers(projectDir, currentChapter);
    if (layers) {
      parts.push(`\n${layers}`);
    }
  }

  // 规划阶段（非 deepen）：预注入 concept/world 核心设定文件，
  // 省去 agent 每轮 Read 往返（按请求计费模式下省 2+ 轮 LLM 调用）
  if (isPlanningStage(currentStage) && !deepenContext) {
    const planningLayer = await buildPlanningContextLayer(projectDir);
    if (planningLayer) {
      parts.push(`\n${planningLayer}`);
    }
  }

  parts.push(`\n${TOOL_INSTRUCTIONS}`);
  parts.push(`\n${OUTPUT_FORMAT}`);

  // SubAgent 使用指导（按 agent CLI 注入；写作阶段和修订阶段都需要）
  const subagentGuidance = getSubagentGuidance(agentId);
  if (subagentGuidance) {
    parts.push(`\n${subagentGuidance}`);
  }

  if (skillContent && !isRevise) {
    parts.push(`\n## Skill Instructions\n${skillContent}`);
  }

  // Pass raw conversation history (agent manages its own context)
  if (history && history.length > 0) {
    const historyLines = history.map((msg) => {
      const label = msg.role === 'user' ? 'User' : msg.role === 'system' ? 'System' : 'Assistant';
      return `### ${label}\n${msg.content}`;
    });
    parts.push(`\n## Conversation History\n${historyLines.join('\n\n')}`);
  }

  // 上下文边界声明：防止多轮对话中模型把上一轮意图延续到本轮（借鉴 denova 的 ContextBoundary 设计）。
  // 异常中断恢复模式下，用中断现场替换普通 User Request，仍保留上下文边界声明。
  if (interruptedResume) {
    const resumeText = buildInterruptedResumeInstruction(message, interruptedResume);
    parts.push(`\n[上下文边界]\n- 当前用户请求是"这次要做什么"，请只按本轮请求行动。\n- 工作区与已确认的小说状态只用于判断"背景是什么"，不能替代本轮明确请求。\n\n## User Request\n${resumeText}`);
  } else {
    parts.push(`\n[上下文边界]\n- 当前用户请求是"这次要做什么"，请只按本轮请求行动。\n- 工作区与已确认的小说状态只用于判断"背景是什么"，不能替代本轮明确请求。\n- 历史对话只能辅助理解上下文，不要把上一轮的待办、工具意图或未完成动作当成本轮指令，除非用户在本轮明确延续。\n- 如果当前请求与历史看起来无关或冲突，以当前请求为准。\n\n## User Request\n${message}`);
  }

  return parts.join('\n');
}
