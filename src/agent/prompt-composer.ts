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
  concept: `Focus on brainstorming the core concept, premise, and high-level story idea. Help the user refine their vision into a clear, compelling concept.
When the concept is complete (clear premise, core conflict, and main characters defined), save the result to .novel/concept.md and update the project stage to "world" by calling: PATCH /api/projects/{projectId} with { "currentStage": "world" }`,

  world: `Build the story world - setting, rules, history, culture, and atmosphere. Create rich, consistent world-building that supports the narrative.
When world-building is complete, save to .novel/world-building.md and update stage to "characters" by calling: PATCH /api/projects/{projectId} with { "currentStage": "characters" }`,

  characters: `Develop detailed character profiles - protagonists, antagonists, and key supporting characters. Include motivations, backstories, relationships, and character arcs.
When characters are complete, save to .novel/characters/profiles.md and update stage to "outline" by calling: PATCH /api/projects/{projectId} with { "currentStage": "outline" }`,

  outline: `Create a detailed story outline including major plot points, character arcs, and chapter structure. Break the story into manageable sections.

**Scaffolding hint**: You can ask the user to call (or call yourself via Bash/curl) the endpoint POST /api/projects/{projectId}/generate-templates to auto-generate a chapter-by-chapter scaffold matching the project's chapterCount (acts, beats, word allocation). Preview without writing via GET /api/projects/{projectId}/templates/outline-detailed or templates/outline-brief. Use the generated scaffold as a starting point and refine it.
When the outline is complete, save to .novel/outline.md and update stage to "scenes" by calling: PATCH /api/projects/{projectId} with { "currentStage": "scenes" }`,

  scenes: `Break down the outline into detailed scenes with beats, emotional arcs, and pacing. Plan each scene's purpose and key moments.

**Scaffolding hint**: You can ask the user to call (or call yourself via Bash/curl) the endpoint POST /api/projects/{projectId}/generate-templates to auto-generate a per-chapter scene scaffold (active Scene / passive Sequel pairs) matching the project's chapterCount. Preview without writing via GET /api/projects/{projectId}/templates/scenes. Use it as a starting point and refine it.
When scenes are complete, save to .novel/scenes.md and update stage to "writing" by calling: PATCH /api/projects/{projectId} with { "currentStage": "writing" }`,

  writing: `Write actual prose for the novel. Focus on narrative flow, dialogue, description, and pacing. Produce polished draft text. Save chapters to .novel/chapters/ directory.

After finishing EACH chapter you MUST do both of the following to keep later chapters consistent:
(1) Write a ~200-character compressed summary of the chapter to .novel/chapters/第N章.summary.md (replace N with the chapter number, e.g. 第3章.summary.md).
(2) Update .novel/state.json — refresh each present character's location, emotion, newly learned information (knows), and relationship changes; advance the timeline and lastUpdatedChapter; set updatedAt.`,
  drafting: `Write actual prose for the novel. Focus on narrative flow, dialogue, description, and pacing. Produce polished draft text.`,
  revision: `Review and improve existing content. Focus on consistency, plot holes, character development, prose quality, and structural improvements.`,
  polish: `Final editing pass. Focus on line-level prose quality, grammar, word choice, and ensuring the manuscript reads smoothly.`,
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
  const stageInstructions = STAGE_INSTRUCTIONS[currentStage] || `Work on the "${currentStage}" stage of the novel project.`;

  // Compose the full prompt
  const parts: string[] = [];

  parts.push(`You are a novel writing assistant. You help users write, structure, and refine their novels. Be creative, thoughtful, and supportive. Write high-quality prose when asked, and provide clear structural guidance when planning.

## File Access Rules
- You MUST only read and write files within the project directory: ${projectDir}
- All novel content goes under .novel/ subdirectory
- Chapters go in .novel/chapters/ directory
- Never access files outside the project directory
- Never access system files, environment variables, or credentials`);

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
