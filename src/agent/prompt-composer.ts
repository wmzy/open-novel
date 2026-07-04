import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/drizzle';
import { projects } from '../db/schema';
import { getPlugin } from '../plugins/registry';
import { eq } from 'drizzle-orm';
import { buildRollingSummaryContext, getStateTable, readCharacterNames } from './context-manager';
import { extractChapterOutline, identifyCast, buildCastLayer } from './chapter-context';
import { buildReverseDecomposePrompt } from './reverse-decomposer';
import { buildEnrichPrompt } from './enricher';

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
}

const STAGE_INSTRUCTIONS: Record<string, string> = {
  concept: `聚焦于构思核心概念、前提和高层故事创意。帮助用户将愿景精炼成清晰、有吸引力的概念。
概念完成后（前提清晰、核心冲突明确、主要角色已定义），将结果保存到 .novel/concept.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "world" }）将项目阶段更新为 "world"。`,

  world: `构建故事世界——设定、规则、历史、文化与氛围。创造丰富、自洽、能支撑叙事的世界观。
世界观完成后，保存到 .novel/world-building.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "characters" }）将项目阶段更新为 "characters"。`,

  characters: `撰写详细的角色档案——主角、反派与关键配角。涵盖动机、背景、关系与角色弧光。
角色档案完成后，保存到 .novel/characters/profiles.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "outline" }）将项目阶段更新为 "outline"。`,

  outline: `创建详细的故事大纲，包括主要剧情节点、角色弧光与章节结构。将故事拆解成可驾驭的段落。

**脚手架提示**：你可以请用户调用（或自己通过 Bash/curl 调用）端点 POST /api/projects/{projectId}/generate-templates，自动生成与项目 chapterCount 匹配的逐章大纲脚手架（幕、节拍、字数分配）。不落盘预览可用 GET /api/projects/{projectId}/templates/outline-detailed 或 templates/outline-brief。以生成的脚手架为起点并加以打磨。
大纲完成后，保存到 .novel/outline.md。同时生成 .novel/outline-meta.json，记录三幕分界与每章视点角色，格式如下：
\`\`\`json
{
  "actBreaks": [5, 15],
  "chapters": [
    { "chapter": 1, "pov": "林冲" },
    { "chapter": 2, "pov": "林冲" }
  ]
}
\`\`\`
actBreaks 为第一幕结束章号、第二幕结束章号；pov 为该章的视点角色名。然后通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "scenes" }）将项目阶段更新为 "scenes"。`,

  scenes: `将大纲拆解为详细场景，包含节拍、情感弧光与节奏。规划每个场景的目的与关键时刻。

**脚手架提示**：你可以请用户调用（或自己通过 Bash/curl 调用）端点 POST /api/projects/{projectId}/generate-templates，自动生成与项目 chapterCount 匹配的逐章场景脚手架（主动 Scene / 被动 Sequel 配对）。不落盘预览可用 GET /api/projects/{projectId}/templates/scenes。以生成的脚手架为起点并加以打磨。
场景表完成后，保存到 .novel/scenes.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "writing" }）将项目阶段更新为 "writing"。`,

  writing: `**写章前**：本章大纲与出场角色档案已注入上方上下文。无需再 Read 这些文件——直接基于注入内容写作。仅在需要查阅未注入细节（如某角色完整弧线、某武学体系全貌）时才 Read。

为小说撰写真正的散文正文。聚焦叙事流畅度、对话、描写与节奏，产出打磨过的草稿正文。将章节保存到 .novel/chapters/ 目录。

**元叙事禁令**：正文内严禁出现章节编号引用（如「第15章」「第十二章」等）。章节编号只能出现在文件首行标题（如「# 第3章 令牌」），绝不能在散文叙事中出现。角色不会知道自己身处「第几章」。

每写完一章后，你必须完成以下三件事以保持后续章节的一致性：
(1) 为该章生成约 200 字的**语义摘要**，写入 .novel/chapters/第N章.summary.md（将 N 替换为章节号，例如 第3章.summary.md）。摘要必须包含：本章情节推进、角色状态变化（位置/情绪/获知新信息）、伏笔兑现或新增。**严禁复制正文原文段落**——摘要必须是你的概括重述，不是截取。
(2) 更新 .novel/state.json——刷新每个在场角色的位置（location）、情绪（emotion）、新获知的信息（knows）；**角色间关系变化必须写入 relationships 字段**（键=对方角色名，值=关系描述，如 \"孙二娘\": \"脆弱的盟友\"），不能留空——这是人物关系图的唯一数据源；推进时间线和 lastUpdatedChapter；设置 updatedAt。
(3) 更新 .novel/foreshadow.json 的伏笔状态：本章埋设了某条伏笔（首次在正文中植入线索），将该伏笔的 status 从 "pending" 改为 "planted"；本章回收了某条伏笔（伏笔线索得到兑现/揭晓），将 status 改为 "resolved" 并填写 resolvedIn 为当前章号。同时同步 state.json 的 activeForeshadows 字段——收集所有 status 为 "planted" 的伏笔 ID 列表。

写完一章后，建议通过以下 API 自检质量：POST /api/projects/{projectId}/check/ai-patterns（body: {chapterNum: N}）检测 AI 味；如发现评分偏高，参照返回的 issues 逐条修改。`,
  drafting: `为小说撰写真正的散文正文。聚焦叙事流畅度、对话、描写与节奏，产出打磨过的草稿正文。`,
  revision: `审阅和改进已有内容。重点检查：(1) 剧情连贯性和逻辑漏洞；(2) 伏笔是否被遗忘（POST /api/projects/{projectId}/check/foreshadows）；(3) 人物行为是否偏离设定（POST /api/projects/{projectId}/check/ooc，body: {chapterNum: N}）；(4) 文笔AI味（POST /api/projects/{projectId}/check/ai-patterns，body: {chapterNum: N}）。根据检查报告逐章修订。`,
  polish: `最终润色。聚焦行文质量——用词精准度、句式节奏、对话自然度、描写具体化。删除抽象情绪标签和万能形容词，用具体细节替代。`,
};

/**
 * 修订模式的指令（替代 STAGE_INSTRUCTIONS）。注入目标文件全文 + 修订意见 + 外科手术规则。
 * 设计依据见 spec §3.4。 */
function buildReviseInstructions(reviseContent: string, reviseNote: string): string {
  return `## 当前任务：修订已有内容

你不是在从零创作，而是在对一份已有的文件做**定向修订**。

### 目标文件
以下是你需要修订的文件全文（已读入上下文，无需再 Read）：

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
5. **简短说明**——在回复中用 2-3 句话说明你改了什么、为什么，便于用户判断是否符合预期。`;
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

/** 需要注入分层上下文的写作阶段（concept→scenes 阶段不注入，因为还没有章节内容）。 */
const WRITING_STAGES = new Set(['writing', 'drafting', 'revision', 'polish']);

function isWritingStage(stage: string): boolean {
  return WRITING_STAGES.has(stage);
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
> writing 阶段的提示词和上下文层尚未注入——现在写章节会缺少必要的前期设定。
>
> **请在回复中明确告知用户**：当前阶段是「${stage}」，需要先完成当前阶段并切换到 writing 阶段。
> 如果用户确实想跳过前期直接写章节，请告诉他们可通过 PATCH /api/projects/{id} 切换阶段。
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

/** 核心设定层（恒定）：concept.md + world-building.md。
 * 全量注入会消耗大量 token（concept+world 可达 60KB+），导致 agent 上下文超载。
 * 这里在保持完整性的前提下控制大小：超过 CORE_LAYER_MAX_CHARS 时截断 world-building 的末尾细节。 */
const CORE_LAYER_MAX_CHARS = 16000; // 约 8K token，留足空间给其他层

async function buildCoreSettingsLayer(projectDir: string): Promise<string> {
  const blocks: string[] = [];
  const concept = await readNovelFile(projectDir, 'concept.md');
  if (concept) blocks.push(`#### 故事概念 (concept.md)\n${concept}`);
  const world = await readNovelFile(projectDir, 'world-building.md');
  if (world) {
    let worldContent = world;
    const totalSize = blocks.join('\n\n').length + world.length;
    if (totalSize > CORE_LAYER_MAX_CHARS) {
      // 截断 world-building，保留开头（力量体系 / 社会结构等核心部分通常在前半）
      const budget = CORE_LAYER_MAX_CHARS - blocks.join('\n\n').length;
      worldContent = world.slice(0, Math.max(budget, 6000))
        + `\n\n[…世界观文档已截断，完整内容见 world-building.md…]`;
    }
    blocks.push(`#### 世界观 (world-building.md)\n${worldContent}`);
  }
  if (blocks.length === 0) return '';
  return `### 核心设定层（恒定）\n${blocks.join('\n\n')}`;
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

/**
 * 解析 foreshadow.json，返回未回收伏笔列表。
 * 调用方据此做分区注入。
 */
export async function loadForeshadows(projectDir: string): Promise<{
  foreshadows: Array<{ id: number; content: string; status: string; plantedIn: number | null; resolvedIn?: number | null }>;
}> {
  const raw = await readNovelFile(projectDir, 'foreshadow.json');
  if (!raw) return { foreshadows: [] };
  try {
    const data = JSON.parse(raw) as {
      foreshadows?: Array<{ id: number; content: string; status: string; plantedIn?: number | null; resolvedIn?: number | null }>;
    };
    const list = (data.foreshadows ?? [])
      .filter((f) => f && f.content)
      .map((f) => ({
        id: f.id,
        content: f.content,
        status: f.status,
        plantedIn: typeof f.plantedIn === 'number' ? f.plantedIn : null,
        resolvedIn: typeof f.resolvedIn === 'number' ? f.resolvedIn : null,
      }));
    return { foreshadows: list };
  } catch {
    return { foreshadows: [] };
  }
}

/**
 * 本章须埋设的伏笔：plantedIn === currentChapter 且 status 仍为 pending 的条目。
 * 返回「置顶提醒」区块，空则返回空串。
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
    lines.push(`- [#${f.id}] ${f.content}`);
  }
  return lines.join('\n');
}

/**
 * 活跃伏笔层：
 * - 「待回收」区 = status === 'planted'（已埋进故事，等待回收）
 * - 「逾期未埋」区 = status === 'pending' 且 plantedIn < currentChapter
 *   （规划埋在本章或更早但状态仍未推进——提醒 agent 补埋或放弃）
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
  const overdue = foreshadows.filter(
    (f) => f.status === 'pending' && f.plantedIn !== null && f.plantedIn < currentChapter,
  );
  if (planted.length === 0 && overdue.length === 0) return '';

  const lines: string[] = ['### 活跃伏笔层'];
  if (planted.length > 0) {
    lines.push('**待回收**（已埋进故事，等待兑现）：');
    for (const f of planted) {
      const plantedNote = f.plantedIn ? `（埋于第${f.plantedIn}章）` : '';
      lines.push(`- [#${f.id}] ${f.content}${plantedNote}`);
    }
  }
  if (overdue.length > 0) {
    lines.push('**逾期未埋**（规划章号已过但状态仍为 pending——补埋或标记放弃）：');
    for (const f of overdue) {
      lines.push(`- [#${f.id}] ${f.content}（应埋于第${f.plantedIn}章）`);
    }
  }
  return lines.join('\n');
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

  const stateLayer = await buildStateLayer(projectDir);
  if (stateLayer) sections.push(stateLayer);

  // 本章大纲块
  const outlineBlock = await extractChapterOutline(projectDir, currentChapter);
  if (outlineBlock) {
    sections.push(`### 本章大纲（第${currentChapter}章）\n${outlineBlock}\n\n> 严格按大纲推进。若需偏离（增删事件、调整节奏），在回复里说明原因。`);
  }

  // 本章出场角色层
  const knownNames = await readCharacterNames(projectDir);
  const cast = await identifyCast(projectDir, currentChapter, outlineBlock, knownNames);
  const castLayer = await buildCastLayer(projectDir, cast);
  if (castLayer) sections.push(castLayer);

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
- **question** — Ask the user a clarifying question. Use: { "question": "your question", "header": "short label", "options": [{ "label": "Option A", "description": "what this means" }] }

## Important Tool Usage Rules

1. **Always Read before Write** — You MUST read a file before writing to it. The Write tool requires the file to have been read first. If you need to create a new file or overwrite an existing one, read it first (even if it's empty or a template).
2. **Use Edit for partial changes** — When modifying specific parts of a file, use Edit instead of Write to preserve unchanged content.
3. **Use question tool** — When you need user input to proceed (e.g., choosing between approaches, clarifying requirements).`;

const OUTPUT_FORMAT = `## Output Format

- Use markdown for all content
- Chapter content: use standard prose paragraphs, no markdown headers inside chapters
- Outlines: use hierarchical markdown headers and bullet points
- Character profiles: use structured sections with headers
- When saving files, use appropriate markdown formatting for the content type`;

export async function composePrompt(options: ComposePromptOptions): Promise<string> {
  const { message, projectId, skillId, stage, projectDir, history,
          mode = 'generate', reviseTarget, reviseNote, reviseContent } = options;

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
    ? buildReviseInstructions(reviseContent!, reviseNote!)
    : currentStage === 'decompose'
      ? buildReverseDecomposePrompt({
          projectDir,
          chapterCount: projectMeta?.chapterCount ?? 0,
        })
      : currentStage === 'enrich'
        ? buildEnrichPrompt({ projectDir })
        : STAGE_INSTRUCTIONS[currentStage] || `着手推进小说项目的「${currentStage}」阶段。`;

  // Compose the full prompt
  const parts: string[] = [];

  if (STAGE_MISMATCH_HINT && !isRevise) {
    parts.push(STAGE_MISMATCH_HINT);
  }

  parts.push(`你是一位小说创作助手。你帮助用户写作、结构和精炼他们的小说。保持创意、周到、有支持性。被要求时撰写高质量散文，规划时提供清晰的结构性指导。

# 指令优先级（最高——覆盖系统加载的任何其他 Skill）

本会话是受控的小说创作环境。系统可能加载了 superpowers、brainstorming 等第三方 Skill——**它们的工作流（尤其是 brainstorming 的“先提设计、等用户审批再写”的 HARD-GATE）不适用于本环境**。原因：小说创作的每个阶段（concept / world / characters / outline / scenes / writing）都有明确的产出文件和验收标准，已由本指令和 Stage 指令定义；用户下达任务时期望的是直接产出文件，而不是反复追问审批。

铁律：
- **直接产出**：收到任务后直接读取上下文、撰写内容、写入对应文件。不要先呈现“设计概要”等用户确认。
- **不调用 Skill 工具**：不要调用 Skill / superpowers:brainstorming 等。你需要的所有创作方法论已在下方 Skill Instructions 提供。
- **最多一次确认**：只有在“某个创作选择会从根本上改变后续几万字走向且无法回滚”时，才可用 question 工具问一个问题；其余情况一律用你的最佳判断直接写，写完在回复里说明你的选择即可。

## 文件访问规则
- 你只能读写项目目录内的文件：${projectDir}
- 所有小说内容放在 .novel/ 子目录下
- 章节放在 .novel/chapters/ 目录下
- 绝不访问项目目录之外的文件
- 绝不访问系统文件、环境变量或凭据`);

  parts.push(`\n## Project Context\n${projectContext}`);

  parts.push(`\n## Current Stage: ${currentStage}\n${stageInstructions}`);

  if (fileList.length > 0) {
    parts.push(`\n## Project Files\n${fileList.map((f) => `- ${f}`).join('\n')}`);
  }

  // 写作阶段（generate）或章节修订（revise）：注入字数目标 + 分层上下文
  const needsWritingContext = isWritingStage(currentStage) || (isRevise && isChapterTarget);
  if (needsWritingContext) {
    // P1 缺陷4: 动态注入每章字数目标
    if (projectMeta?.targetWords && projectMeta?.chapterCount) {
      const perChapter = Math.round(projectMeta.targetWords / projectMeta.chapterCount);
      parts.push(`\n## 本章字数要求\n每章目标约 ${perChapter} 字（CJK 字符），允许 ±20% 浮动。偏差超 ±30% 将被系统标记为字数异常。`);
    }

    // 计算当前章号 = 已完成章数 + 1（从 state.json lastUpdatedChapter 推断）
    const state = await getStateTable(projectDir);
    const currentChapter = state.lastUpdatedChapter + 1;

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

  parts.push(`\n${TOOL_INSTRUCTIONS}`);
  parts.push(`\n${OUTPUT_FORMAT}`);

  if (skillContent && !isRevise) {
    parts.push(`\n## Skill Instructions\n${skillContent}`);
  }

  // Pass raw conversation history (agent manages its own context)
  if (history && history.length > 0) {
    const historyLines = history.map((msg) => {
      const label = msg.role === 'user' ? 'User' : 'Assistant';
      return `### ${label}\n${msg.content}`;
    });
    parts.push(`\n## Conversation History\n${historyLines.join('\n\n')}`);
  }

  parts.push(`\n## User Request\n${message}`);

  return parts.join('\n');
}
