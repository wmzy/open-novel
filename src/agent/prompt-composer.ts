import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db/drizzle';
import { projects } from '../db/schema';
import { getPlugin } from '../plugins/registry';
import { eq } from 'drizzle-orm';

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
When the outline is complete, save to .novel/outline.md and update stage to "scenes" by calling: PATCH /api/projects/{projectId} with { "currentStage": "scenes" }`,

  scenes: `Break down the outline into detailed scenes with beats, emotional arcs, and pacing. Plan each scene's purpose and key moments.
When scenes are complete, save to .novel/scenes.md and update stage to "writing" by calling: PATCH /api/projects/{projectId} with { "currentStage": "writing" }`,

  writing: `Write actual prose for the novel. Focus on narrative flow, dialogue, description, and pacing. Produce polished draft text. Save chapters to .novel/chapters/ directory.`,
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
