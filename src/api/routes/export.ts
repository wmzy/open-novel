import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects, chapters } from '../../db/schema';
import { resolveNovelDir } from '../../shared/project-dir';
import { parseChapterNumber } from '../../shared/chapter-names';
import { resyncChaptersFromDisk } from './chapters';
import {
  buildDocx,
  buildEpub,
  exportChapterTitle,
  stripLeadingChapterHeading,
  type EbookChapter,
  type EbookFrontMatter,
} from '../../shared/ebook-export';

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

/** 读取单文件；不存在/不可读返回 null。 */
async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
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

type Project = typeof projects.$inferSelect;

interface ManuscriptExport {
  project: Project;
  projectDir: string;
  /** 按章号排序的章节；content=null 表示正文文件缺失（占位）。 */
  chapters: EbookChapter[];
  warnings: string[];
}

/**
 * 章节装配公共逻辑：项目 → 磁盘对齐 → 按章号排序 → 读正文 → 缺章/归档警告。
 * markdown/text/epub/docx 四种导出共用，避免各写一份排序与缺章判断。
 */
async function loadManuscriptExport(projectId: string): Promise<ManuscriptExport | null> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return null;

  // 磁盘为事实源：先对齐 chapters 表，避免导出缺章或含幽灵章节
  await resyncChaptersFromDisk(projectId, { force: true }).catch(() => {});

  const allChapters = await db.select().from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(chapters.number);

  let projectDir: string;
  try {
    projectDir = await resolveNovelDir(projectId);
  } catch {
    return null;
  }

  // 质检归档章节不参与导出（含旧版 chapters/*.degraded.md 就地归档）。
  const degradedChapters = await collectDegradedChapterNumbers(projectDir).catch(() => [] as number[]);
  const degradedSet = new Set(degradedChapters);

  const result: EbookChapter[] = [];
  const missingChapters: number[] = [];
  let prevNumber = allChapters.length > 0 ? Math.min(...allChapters.map((c) => c.number)) - 1 : 0;
  for (const ch of allChapters) {
    // 缺章占位：DB 行存在但文件缺失，或章号空洞（文件被删且 resync 已清行）。
    // 归档章号不产生占位。
    for (let n = prevNumber + 1; n < ch.number; n++) {
      if (degradedSet.has(n)) continue;
      result.push({ number: n, title: '', content: null });
      missingChapters.push(n);
    }
    prevNumber = ch.number;
    try {
      // 正文文件存在时优先导出（即使存在同名归档残留）。
      // 正文文件以 `# 第N章 标题` 开头是项目约定；导出标题由导出器统一生成，
      // 这里先剥掉重复标题行，避免四种格式都出现两级重复标题。
      const content = stripLeadingChapterHeading(await readChapterFile(projectDir, ch.number), ch.title);
      result.push({ number: ch.number, title: ch.title || '', content });
    } catch {
      // 归档章节：不输出正文，也不重复产生「缺章」占位。
      if (degradedSet.has(ch.number)) continue;
      result.push({ number: ch.number, title: ch.title || '', content: null });
      missingChapters.push(ch.number);
    }
  }

  // 同名正文已导出时，不把残留归档误报为「未包含」。
  const includedNumbers = new Set(
    result.filter((chapter) => chapter.content !== null).map((chapter) => chapter.number),
  );
  const archivedChapters = degradedChapters.filter((n) => !includedNumbers.has(n));

  const warnings = [
    ...missingChapters.map((n) => `第${n}章文件缺失，已在导出文件中标注占位`),
    ...archivedChapters.map((n) => `第${n}章处于质检归档状态，未包含在导出中（可在写作视图恢复）`),
  ];

  return {
    project,
    projectDir,
    chapters: result,
    warnings,
  };
}

/** scope=full 的设定资料（概念/世界观/角色），与 markdown 导出保持一致。 */
async function loadFrontMatter(projectDir: string): Promise<EbookFrontMatter | undefined> {
  const concept = (await readSplitDoc(path.join(projectDir, 'concept')))
    ?? (await readFileOrNull(path.join(projectDir, 'concept.md')));
  const world = (await readSplitDoc(path.join(projectDir, 'world')))
    ?? (await readFileOrNull(path.join(projectDir, 'world-building.md')));
  const characters = await readFileOrNull(path.join(projectDir, 'characters', 'profiles.md'));

  const front: EbookFrontMatter = {};
  if (concept?.trim()) front.concept = concept.trim();
  if (world?.trim()) front.world = world.trim();
  if (characters?.trim()) front.characters = characters.trim();
  return Object.keys(front).length > 0 ? front : undefined;
}

/** RFC 5987：filename* 携带 UTF-8 文件名；filename 提供 ASCII 回退。 */
function attachmentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename)
    .replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function setExportHeaders(
  c: { header: (name: string, value: string) => void },
  filename: string,
  contentType: string,
  warnings: string[],
): void {
  c.header('Content-Type', contentType);
  c.header('Content-Disposition', attachmentDisposition(filename));
  if (warnings.length > 0) {
    c.header('x-export-warnings', encodeURIComponent(warnings.join('；')));
  }
}

function titlePageMarkdown(project: Project): string[] {
  const parts: string[] = [`# ${project.title}\n`];
  if (project.genre) parts.push(`**类型**: ${project.genre}\n`);
  if (project.theme) parts.push(`**主题**: ${project.theme}\n`);
  parts.push(`---\n`);
  return parts;
}

const exportRouter = new Hono();

// Export all chapters as a single markdown file
// 支持 ?scope=manuscript（仅正文，适合投稿/发布）；默认 full（含概念/世界观/角色设定）
exportRouter.get('/markdown', async (c) => {
  const scope = c.req.query('scope') === 'manuscript' ? 'manuscript' : 'full';
  const projectId = c.req.param('projectId')!;
  const data = await loadManuscriptExport(projectId);
  if (!data) return c.json({ error: 'Project not found' }, 404);
  const { project, projectDir } = data;

  // Build markdown content
  const parts: string[] = titlePageMarkdown(project);

  // manuscript 仅导出正文；full 额外附带概念/世界观/角色设定（默认，向后兼容）
  if (scope === 'full') {
    const front = await loadFrontMatter(projectDir);
    if (front?.concept) parts.push(`## 故事概念\n\n${front.concept}\n\n---\n`);
    if (front?.world) parts.push(`## 世界观\n\n${front.world}\n\n---\n`);
    if (front?.characters) parts.push(`## 角色\n\n${front.characters}\n\n---\n`);
  }

  // Chapters
  for (const ch of data.chapters) {
    const heading = exportChapterTitle(ch.number, ch.title);
    if (ch.content === null) {
      parts.push(`## ${heading} 【章节缺失】\n\n> 本章正文文件缺失，导出时未包含。\n`);
    } else {
      parts.push(`## ${heading}\n\n${ch.content}\n`);
    }
  }

  setExportHeaders(c, `${project.title}.md`, 'text/markdown; charset=utf-8', data.warnings);
  return c.body(parts.join('\n'));
});

// Export all chapters as plain text
exportRouter.get('/text', async (c) => {
  const projectId = c.req.param('projectId')!;
  const data = await loadManuscriptExport(projectId);
  if (!data) return c.json({ error: 'Project not found' }, 404);
  const { project } = data;

  const parts: string[] = [];
  parts.push(project.title);
  parts.push('='.repeat(project.title.length * 2));
  parts.push('');

  for (const ch of data.chapters) {
    const heading = exportChapterTitle(ch.number, ch.title);
    if (ch.content === null) {
      parts.push(`【${heading} 缺失：正文文件不存在，导出时未包含】`);
      parts.push('');
    } else {
      parts.push(heading);
      parts.push('-'.repeat(20));
      parts.push(ch.content);
      parts.push('');
    }
  }

  setExportHeaders(c, `${project.title}.txt`, 'text/plain; charset=utf-8', data.warnings);
  return c.body(parts.join('\n'));
});

// Export as EPUB 3（?scope=full 附带设定资料；默认仅正文）
exportRouter.get('/epub', async (c) => {
  const projectId = c.req.param('projectId')!;
  const data = await loadManuscriptExport(projectId);
  if (!data) return c.json({ error: 'Project not found' }, 404);

  const scope = c.req.query('scope') === 'full' ? 'full' : 'manuscript';
  const frontMatter = scope === 'full' ? await loadFrontMatter(data.projectDir) : undefined;
  const bytes = buildEpub({
    id: data.project.id,
    title: data.project.title,
    genre: data.project.genre,
    theme: data.project.theme,
    language: 'zh',
    chapters: data.chapters,
    frontMatter,
  });

  setExportHeaders(c, `${data.project.title}.epub`, 'application/epub+zip', data.warnings);
  return c.body(bytes);
});

// Export as DOCX（?scope=full 附带设定资料；默认仅正文）
exportRouter.get('/docx', async (c) => {
  const projectId = c.req.param('projectId')!;
  const data = await loadManuscriptExport(projectId);
  if (!data) return c.json({ error: 'Project not found' }, 404);

  const scope = c.req.query('scope') === 'full' ? 'full' : 'manuscript';
  const frontMatter = scope === 'full' ? await loadFrontMatter(data.projectDir) : undefined;
  const bytes = buildDocx({
    id: data.project.id,
    title: data.project.title,
    genre: data.project.genre,
    theme: data.project.theme,
    chapters: data.chapters,
    frontMatter,
  });

  setExportHeaders(
    c,
    `${data.project.title}.docx`,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data.warnings,
  );
  return c.body(bytes);
});

export default exportRouter;
