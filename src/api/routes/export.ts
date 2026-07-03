import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects, chapters } from '../../db/schema';
import { resolveNovelDir } from '../../shared/project-dir';

/** 读取章节正文，优先中文命名（agent 写），fallback 英文命名（旧约定）。 */
async function readChapterFile(novelDir: string, num: number): Promise<string> {
  for (const name of [`第${num}章.md`, `chapter-${num}.md`]) {
    try {
      return await fs.readFile(path.join(novelDir, 'chapters', name), 'utf-8');
    } catch { /* try next */ }
  }
  throw new Error(`chapter ${num} not found`);
}

const exportRouter = new Hono();

// Export all chapters as a single markdown file
exportRouter.get('/markdown', async (c) => {
  const projectId = c.req.param('projectId')!;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const allChapters = await db.select().from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(chapters.number);

  let projectDir: string;
  try {
    projectDir = await resolveNovelDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Build markdown content
  const parts: string[] = [];

  // Title page
  parts.push(`# ${project.title}\n`);
  if (project.genre) parts.push(`**类型**: ${project.genre}\n`);
  if (project.theme) parts.push(`**主题**: ${project.theme}\n`);
  parts.push(`---\n`);

  // Concept
  try {
    const concept = await fs.readFile(path.join(projectDir, 'concept.md'), 'utf-8');
    parts.push(`## 故事概念\n\n${concept}\n\n---\n`);
  } catch { /* skip */ }

  // World building
  try {
    const world = await fs.readFile(path.join(projectDir, 'world-building.md'), 'utf-8');
    parts.push(`## 世界观\n\n${world}\n\n---\n`);
  } catch { /* skip */ }

  // Characters
  try {
    const chars = await fs.readFile(path.join(projectDir, 'characters', 'profiles.md'), 'utf-8');
    parts.push(`## 角色\n\n${chars}\n\n---\n`);
  } catch { /* skip */ }

  // Chapters
  for (const ch of allChapters) {
    try {
      const content = await readChapterFile(projectDir, ch.number);
      parts.push(`## 第 ${ch.number} 章 ${ch.title || ''}\n\n${content}\n`);
    } catch { /* skip empty chapters */ }
  }

  const markdown = parts.join('\n');

  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(project.title)}.md"`);
  return c.body(markdown);
});

// Export all chapters as plain text
exportRouter.get('/text', async (c) => {
  const projectId = c.req.param('projectId')!;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const allChapters = await db.select().from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(chapters.number);

  let projectDir: string;
  try {
    projectDir = await resolveNovelDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const parts: string[] = [];
  parts.push(project.title);
  parts.push('='.repeat(project.title.length * 2));
  parts.push('');

  for (const ch of allChapters) {
    try {
      const content = await readChapterFile(projectDir, ch.number);
      parts.push(`第 ${ch.number} 章 ${ch.title || ''}`);
      parts.push('-'.repeat(20));
      parts.push(content);
      parts.push('');
    } catch { /* skip */ }
  }

  const text = parts.join('\n');

  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(project.title)}.txt"`);
  return c.body(text);
});

export default exportRouter;
