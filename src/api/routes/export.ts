import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects, chapters } from '../../db/schema';
import { resolveNovelDir } from '../../shared/project-dir';
import { parseChapterNumber } from '../../shared/chapter-names';
import { resyncChaptersFromDisk } from './chapters';

/** 读取拆分文档目录（index.md + 全部卡片），合并为单个 markdown。目录不存在返回 null。 */
async function readSplitDoc(docDir: string): Promise<string | null> {
  let indexContent: string;
  try {
    indexContent = await fs.readFile(path.join(docDir, 'index.md'), 'utf-8');
  } catch {
    return null;
  }
  const parts: string[] = [indexContent.trim()];
  let entries: string[];
  try {
    entries = await fs.readdir(docDir, { recursive: true }) as string[];
  } catch {
    entries = [];
  }
  const cardFiles = entries.filter((f) => f !== 'index.md' && f.endsWith('.md')).sort();
  for (const relPath of cardFiles) {
    try {
      const content = await fs.readFile(path.join(docDir, relPath), 'utf-8');
      parts.push(content.trim());
    } catch { /* skip */ }
  }
  return parts.join('\n\n');
}

/** 读取章节正文：扫描目录按章号匹配（兼容中文/英文/带标题后缀/全角数字命名）。 */
async function readChapterFile(novelDir: string, num: number): Promise<string> {
  const dir = path.join(novelDir, 'chapters');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    throw new Error(`chapter ${num} not found`);
  }
  for (const name of entries) {
    if (parseChapterNumber(name) === num) {
      return fs.readFile(path.join(dir, name), 'utf-8');
    }
  }
  throw new Error(`chapter ${num} not found`);
}

/** 收集质检归档章节号（导出时排除并返回警告）。 */
async function collectDegradedChapterNumbers(novelDir: string): Promise<number[]> {
  const nums: number[] = [];
  const dirs: Array<[string, (name: string) => number | null]> = [
    [path.join(novelDir, 'degraded'), (name) => parseChapterNumber(name)],
    [path.join(novelDir, 'chapters'), (name) => {
      // 旧版就地命名：第N章.degraded.md / chapter-N.degraded.md
      if (!name.includes('.degraded.')) return null;
      const base = name.replace('.degraded.md', '.md');
      return parseChapterNumber(base);
    }],
  ];
  for (const [dir, parse] of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const num = parse(name);
      if (num !== null) nums.push(num);
    }
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

const exportRouter = new Hono();

// Export all chapters as a single markdown file
// 支持 ?scope=manuscript（仅正文，适合投稿/发布）；默认 full（含概念/世界观/角色设定）
exportRouter.get('/markdown', async (c) => {
  const scope = c.req.query('scope') === 'manuscript' ? 'manuscript' : 'full';
  const projectId = c.req.param('projectId')!;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  // 磁盘为事实源：先对齐 chapters 表，避免导出缺章或含幽灵章节
  await resyncChaptersFromDisk(projectId, { force: true }).catch(() => {});

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

  // manuscript 仅导出正文；full 额外附带概念/世界观/角色设定（默认，向后兼容）
  if (scope === 'full') {
    // Concept（拆分格式：合并目录，fallback 旧单文件）
    {
      const conceptDir = path.join(projectDir, 'concept');
      const merged = await readSplitDoc(conceptDir);
      if (merged) {
        parts.push(`## 故事概念\n\n${merged}\n\n---\n`);
      } else {
        try {
          const concept = await fs.readFile(path.join(projectDir, 'concept.md'), 'utf-8');
          parts.push(`## 故事概念\n\n${concept}\n\n---\n`);
        } catch { /* skip */ }
      }
    }

    // World building（拆分格式：合并目录，fallback 旧单文件）
    {
      const worldDir = path.join(projectDir, 'world');
      const merged = await readSplitDoc(worldDir);
      if (merged) {
        parts.push(`## 世界观\n\n${merged}\n\n---\n`);
      } else {
        try {
          const world = await fs.readFile(path.join(projectDir, 'world-building.md'), 'utf-8');
          parts.push(`## 世界观\n\n${world}\n\n---\n`);
        } catch { /* skip */ }
      }
    }

    // Characters
    try {
      const chars = await fs.readFile(path.join(projectDir, 'characters', 'profiles.md'), 'utf-8');
      parts.push(`## 角色\n\n${chars}\n\n---\n`);
    } catch { /* skip */ }
  }

  // Chapters
  // 缺章占位：DB 行存在但文件缺失，或章号空洞（文件被删且 resync 已清行）——
  // 导出文件内插入显式占位，避免「没注意 toast 就发出缺章稿」。
  const missingChapters: number[] = [];
  let prevNumber = allChapters.length > 0 ? Math.min(...allChapters.map((c) => c.number)) - 1 : 0;
  for (const ch of allChapters) {
    for (let n = prevNumber + 1; n < ch.number; n++) {
      parts.push(`## 第 ${n} 章 【章节缺失】\n\n> 本章正文文件缺失，导出时未包含。\n`);
      missingChapters.push(n);
    }
    prevNumber = ch.number;
    try {
      const content = await readChapterFile(projectDir, ch.number);
      parts.push(`## 第 ${ch.number} 章 ${ch.title || ''}\n\n${content}\n`);
    } catch {
      parts.push(`## 第 ${ch.number} 章 ${ch.title || ''} 【章节缺失】\n\n> 本章正文文件缺失，导出时未包含。\n`);
      missingChapters.push(ch.number);
    }
  }

  // 质检归档章节不参与导出；收集后经响应头告知（前端 toast 提示缺章）。
  const degradedChapters = await collectDegradedChapterNumbers(projectDir).catch(() => [] as number[]);
  const warnings = [
    ...missingChapters.map((n) => `第${n}章文件缺失，已在导出文件中标注占位`),
    ...degradedChapters.map((n) => `第${n}章处于质检归档状态，未包含在导出中（可在写作视图恢复）`),
  ];

  const markdown = parts.join('\n');

  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(project.title)}.md"`);
  if (warnings.length > 0) {
    c.header('x-export-warnings', encodeURIComponent(warnings.join('；')));
  }
  return c.body(markdown);
});

// Export all chapters as plain text
exportRouter.get('/text', async (c) => {
  const projectId = c.req.param('projectId')!;
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  // 磁盘为事实源：先对齐 chapters 表，避免导出缺章或含幽灵章节
  await resyncChaptersFromDisk(projectId, { force: true }).catch(() => {});

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

  const missingChapters: number[] = [];
  let prevNumber = allChapters.length > 0 ? Math.min(...allChapters.map((c) => c.number)) - 1 : 0;
  for (const ch of allChapters) {
    for (let n = prevNumber + 1; n < ch.number; n++) {
      parts.push(`【第 ${n} 章缺失：正文文件不存在，导出时未包含】`);
      parts.push('');
      missingChapters.push(n);
    }
    prevNumber = ch.number;
    try {
      const content = await readChapterFile(projectDir, ch.number);
      parts.push(`第 ${ch.number} 章 ${ch.title || ''}`);
      parts.push('-'.repeat(20));
      parts.push(content);
      parts.push('');
    } catch {
      parts.push(`【第 ${ch.number} 章 ${ch.title || ''} 缺失：正文文件不存在，导出时未包含】`);
      parts.push('');
      missingChapters.push(ch.number);
    }
  }

  const degradedChapters = await collectDegradedChapterNumbers(projectDir).catch(() => [] as number[]);
  const warnings = [
    ...missingChapters.map((n) => `第${n}章文件缺失，已在导出文件中标注占位`),
    ...degradedChapters.map((n) => `第${n}章处于质检归档状态，未包含在导出中（可在写作视图恢复）`),
  ];

  const text = parts.join('\n');

  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${encodeURIComponent(project.title)}.txt"`);
  if (warnings.length > 0) {
    c.header('x-export-warnings', encodeURIComponent(warnings.join('；')));
  }
  return c.body(text);
});

export default exportRouter;
