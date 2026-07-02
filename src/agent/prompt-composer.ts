import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/drizzle';
import { projects } from '../db/schema';
import { getPlugin } from '../plugins/registry';
import { eq } from 'drizzle-orm';
import { buildRollingSummaryContext, getStateTable } from './context-manager';

export interface ComposePromptOptions {
  message: string;
  projectId: string;
  skillId?: string;
  stage?: string;
  projectDir: string;
  history?: { role: string; content: string }[];
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
大纲完成后，保存到 .novel/outline.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "scenes" }）将项目阶段更新为 "scenes"。`,

  scenes: `将大纲拆解为详细场景，包含节拍、情感弧光与节奏。规划每个场景的目的与关键时刻。

**脚手架提示**：你可以请用户调用（或自己通过 Bash/curl 调用）端点 POST /api/projects/{projectId}/generate-templates，自动生成与项目 chapterCount 匹配的逐章场景脚手架（主动 Scene / 被动 Sequel 配对）。不落盘预览可用 GET /api/projects/{projectId}/templates/scenes。以生成的脚手架为起点并加以打磨。
场景表完成后，保存到 .novel/scenes.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "writing" }）将项目阶段更新为 "writing"。`,

  writing: `为小说撰写真正的散文正文。聚焦叙事流畅度、对话、描写与节奏，产出打磨过的草稿正文。将章节保存到 .novel/chapters/ 目录。

每写完一章后，你必须完成以下两件事以保持后续章节的一致性：
(1) 为该章生成约 200 字的压缩摘要，写入 .novel/chapters/第N章.summary.md（将 N 替换为章节号，例如 第3章.summary.md）。
(2) 更新 .novel/state.json——刷新每个在场角色的位置、情绪、新获知的信息（knows）与关系变化；推进时间线和 lastUpdatedChapter；设置 updatedAt。

写完一章后，建议通过以下 API 自检质量：POST /api/projects/{projectId}/check/ai-patterns（body: {chapterNum: N}）检测 AI 味；如发现评分偏高，参照返回的 issues 逐条修改。`,
  drafting: `为小说撰写真正的散文正文。聚焦叙事流畅度、对话、描写与节奏，产出打磨过的草稿正文。`,
  revision: `审阅和改进已有内容。重点检查：(1) 剧情连贯性和逻辑漏洞；(2) 伏笔是否被遗忘（POST /api/projects/{projectId}/check/foreshadows）；(3) 人物行为是否偏离设定（POST /api/projects/{projectId}/check/ooc，body: {chapterNum: N}）；(4) 文笔AI味（POST /api/projects/{projectId}/check/ai-patterns，body: {chapterNum: N}）。根据检查报告逐章修订。`,
  polish: `最终润色。聚焦行文质量——用词精准度、句式节奏、对话自然度、描写具体化。删除抽象情绪标签和万能形容词，用具体细节替代。`,
};

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

/** 读取 `.novel/` 下指定相对路径文件内容，失败返回空串。 */
async function readNovelFile(projectDir: string, relativePath: string): Promise<string> {
  try {
    const full = path.join(projectDir, '.novel', relativePath);
    return (await fs.readFile(full, 'utf-8')).trim();
  } catch {
    return '';
  }
}

/** 核心设定层（恒定）：concept.md + world-building.md 全文。 */
async function buildCoreSettingsLayer(projectDir: string): Promise<string> {
  const blocks: string[] = [];
  const concept = await readNovelFile(projectDir, 'concept.md');
  if (concept) blocks.push(`#### 故事概念 (concept.md)\n${concept}`);
  const world = await readNovelFile(projectDir, 'world-building.md');
  if (world) blocks.push(`#### 世界观 (world-building.md)\n${world}`);
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

/** 活跃伏笔层：foreshadow.json 中 status=pending 的伏笔。 */
async function buildForeshadowLayer(projectDir: string): Promise<string> {
  const raw = await readNovelFile(projectDir, 'foreshadow.json');
  if (!raw) return '';
  let data: {
    foreshadows?: Array<{
      id: number;
      content: string;
      status: string;
      plantedIn?: number | null;
    }>;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    return '';
  }
  const pending = (data.foreshadows ?? []).filter(
    (f) => f && f.status === 'pending' && f.content,
  );
  if (pending.length === 0) return '';
  const lines: string[] = ['### 活跃伏笔层（待回收）'];
  for (const f of pending) {
    const planted = f.plantedIn ? `（埋于第${f.plantedIn}章）` : '';
    lines.push(`- [#${f.id}] ${f.content}${planted}`);
  }
  return lines.join('\n');
}

/**
 * 为写作阶段组装分层上下文：
 * 核心设定（恒定）→ 状态 → 滚动摘要 → 活跃伏笔。
 * 任一层缺失则跳过；整体为空时仍返回占位说明，提示 agent 维护摘要与状态。
 */
async function buildWritingContextLayers(projectDir: string): Promise<string> {
  const sections: string[] = [];

  const core = await buildCoreSettingsLayer(projectDir);
  if (core) sections.push(core);

  const stateLayer = await buildStateLayer(projectDir);
  if (stateLayer) sections.push(stateLayer);

  const rolling = await buildRollingSummaryContext(projectDir);
  if (rolling) {
    sections.push(`### 滚动摘要层（最近 3 章详摘，更早章节简摘）\n${rolling}`);
  } else {
    sections.push(
      '### 滚动摘要层\n（暂无章节摘要。每写完一章请在 `.novel/chapters/第N章.summary.md` 生成 200 字摘要。）',
    );
  }

  const foreshadow = await buildForeshadowLayer(projectDir);
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
  const { message, projectId, skillId, stage, projectDir, history } = options;

  // Load project metadata from DB
  let projectContext = '';
  try {
    const project = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (project.length > 0) {
      const p = project[0];
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

  // Stage-specific instructions
  const currentStage = stage || 'concept';
  const stageInstructions = STAGE_INSTRUCTIONS[currentStage] || `着手推进小说项目的「${currentStage}」阶段。`;

  // Compose the full prompt
  const parts: string[] = [];

  parts.push(`你是一位小说创作助手。你帮助用户写作、结构和精炼他们的小说。保持创意、周到、有支持性。被要求时撰写高质量散文，规划时提供清晰的结构性指导。

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

  // 写作阶段：注入分层上下文（核心设定 / 状态 / 滚动摘要 / 活跃伏笔）
  if (isWritingStage(currentStage)) {
    const layers = await buildWritingContextLayers(projectDir);
    if (layers) {
      parts.push(`\n${layers}`);
    }
  }

  parts.push(`\n${TOOL_INSTRUCTIONS}`);
  parts.push(`\n${OUTPUT_FORMAT}`);

  if (skillContent) {
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
