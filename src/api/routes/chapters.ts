import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { chapters } from '../../db/schema';
import { generateId } from '../../utils/id';
import { resolveNovelDir } from '../../shared/project-dir';

/** 章节状态枚举：草稿 / 审阅中 / 已修订 / 已定稿。 */
export const CHAPTER_STATUSES = ['draft', 'review', 'revised', 'finalized'] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

const chaptersRouter = new Hono();

/**
 * 计算章节正文文件的绝对路径。
 * 主命名：第{N}章.md（SKILL 指导 agent 写的中文命名）。
 * 兼容旧数据：chapter-{N}.md（早期英文约定）。
 */
function chapterFilePath(novelDir: string, num: number): string {
  return path.join(novelDir, 'chapters', `第${num}章.md`);
}

/** 英文命名 fallback 路径（兼容旧数据）。 */
function legacyChapterFilePath(novelDir: string, num: number): string {
  return path.join(novelDir, 'chapters', `chapter-${num}.md`);
}

/**
 * 读取章节正文，文件不存在返回空串。
 * 先尝试中文命名（agent 写的），再 fallback 英文命名（旧约定）。
 */
async function readChapterContent(novelDir: string, num: number): Promise<string> {
  try {
    return await fs.readFile(chapterFilePath(novelDir, num), 'utf-8');
  } catch {
    try {
      return await fs.readFile(legacyChapterFilePath(novelDir, num), 'utf-8');
    } catch {
      return '';
    }
  }
}

/**
 * 扫描 .novel/chapters/ 目录，将磁盘上存在但 DB 缺失的章节补入。
 * 解决 DB 数据丢失（如 PGlite 重建）后写作视图为空的问题。
 * 文件系统是事实来源，DB 仅缓存元数据。
 */
async function resyncChaptersFromDisk(projectId: string): Promise<void> {
  const novelDir = await resolveNovelDir(projectId);
  const chaptersDir = path.join(novelDir, 'chapters');
  let files: string[];
  try {
    files = await fs.readdir(chaptersDir);
  } catch { return; }

  for (const file of files) {
    if (!file.endsWith('.md') || file.endsWith('.summary.md')) continue;
    const match = file.match(/(\d+)/);
    if (!match) continue;
    const num = parseInt(match[1], 10);

    const [existing] = await db.select().from(chapters)
      .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
      .limit(1);
    if (existing) continue;

    try {
      const content = await fs.readFile(path.join(chaptersDir, file), 'utf-8');
      const stripped = content.replace(/^[#*>\-\[\]()!|]+\s*/gm, '').trim();
      const cjk = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
      const wordCount = cjk > 0 ? cjk : stripped.split(/\s+/).filter(Boolean).length;
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : '';

      await db.insert(chapters).values({
        id: generateId('ch_'),
        projectId,
        number: num,
        title,
        wordCount,
        status: 'draft',
      });
    } catch { /* skip unreadable */ }
  }
}

chaptersRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  await resyncChaptersFromDisk(projectId).catch(() => {});
  const all = await db.select().from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(chapters.number);
  return c.json({ chapters: all });
});

chaptersRouter.get('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const num = parseInt(c.req.param('num'), 10);
  if (Number.isNaN(num)) return c.json({ error: 'Invalid chapter number' }, 400);
  const [chapter] = await db.select().from(chapters)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .limit(1);
  if (!chapter) return c.json({ error: 'Not found' }, 404);

  // 从磁盘读取章节正文附加到响应（正文存储在 .novel/chapters/ 下，DB 仅存元数据）
  let content = '';
  try {
    const novelDir = await resolveNovelDir(projectId);
    content = await readChapterContent(novelDir, num);
  } catch { /* 项目目录未初始化时忽略，返回空正文 */ }

  return c.json({ chapter: { ...chapter, content } });
});

chaptersRouter.post('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const body = await c.req.json();

  if (!body.number) return c.json({ error: 'number is required' }, 400);

  // Check for duplicate
  const existing = await db.select().from(chapters)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, body.number)))
    .limit(1);
  if (existing.length > 0) return c.json({ error: 'Chapter already exists' }, 409);

  const id = generateId('ch_');
  const [chapter] = await db.insert(chapters).values({
    id,
    projectId,
    number: body.number,
    title: body.title || `Chapter ${body.number}`,
    wordCount: body.wordCount || 0,
    status: body.status || 'draft',
  }).returning();

  return c.json({ chapter }, 201);
});

chaptersRouter.patch('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const num = parseInt(c.req.param('num'), 10);
  if (Number.isNaN(num)) return c.json({ error: 'Invalid chapter number' }, 400);
  const body = await c.req.json();

  // 正文落盘到 .novel/chapters/第{N}章.md（DB 不存正文列）
  if (typeof body.content === 'string') {
    try {
      const novelDir = await resolveNovelDir(projectId);
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      await fs.writeFile(chapterFilePath(novelDir, num), body.content, 'utf-8');
    } catch {
      return c.json({ error: 'Failed to write chapter content' }, 500);
    }
  }

  // 只允许更新真实存在的 DB 列，避免传入 content 等非法字段导致 SQL 错误
  const dbUpdates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.title === 'string') dbUpdates.title = body.title;
  if (typeof body.wordCount === 'number') dbUpdates.wordCount = body.wordCount;
  if (typeof body.status === 'string') {
    // 校验 status 取值，非法值忽略
    if ((CHAPTER_STATUSES as readonly string[]).includes(body.status)) {
      dbUpdates.status = body.status;
    }
  }

  const [updated] = await db.update(chapters)
    .set(dbUpdates)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);

  // 返回时附加最新正文
  let content = '';
  try {
    const novelDir = await resolveNovelDir(projectId);
    content = await readChapterContent(novelDir, num);
  } catch { /* ignore */ }

  return c.json({ chapter: { ...updated, content } });
});

chaptersRouter.delete('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const num = parseInt(c.req.param('num'), 10);
  if (Number.isNaN(num)) return c.json({ error: 'Invalid chapter number' }, 400);

  const [deleted] = await db.delete(chapters)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .returning();

  if (!deleted) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default chaptersRouter;
