import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { chapters } from '../../db/schema';
import { generateId } from '../../utils/id';
import { resolveNovelDir } from '../../shared/project-dir';
import { getActiveRunForProject } from '../../agent/run';
import { parseForeshadowFile, serializeForeshadows } from '../../shared/foreshadow';

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

/** resync 节流窗口（ms）：run 期间每个 file-changed 事件都会触发 GET /chapters 全量
 * 磁盘扫描，大书（100+ 章）性能随规模退化。窗口内重复调用直接跳过。 */
const RESYNC_COOLDOWN_MS = 2000;
/** 各项目最近一次 resync 时间戳（内存级节流，重启即清零，无副作用）。 */
const lastResyncAt = new Map<string, number>();

/**
 * 扫描 .novel/chapters/ 目录，将 chapters 表与磁盘全量对齐：
 * - 磁盘有、DB 缺失的章节补入
 * - 磁盘有、DB 已有的章节刷新 wordCount/title（不覆盖 status）
 * - DB 有、磁盘缺失的章节删除（幽灵章节：退化归档改名/回滚/手动删除文件后 DB 滞留）
 * 解决 DB 数据丢失（如 PGlite 重建）后写作视图为空的问题，
 * 也解决回滚后 DB 与磁盘脱节的问题。文件系统是事实来源，DB 仅缓存元数据。
 *
 * 节流：默认 2s 冷却，窗口内的重复调用跳过（GET /chapters 高频触发场景）；
 * force=true 绕过冷却（回滚/导入源等必须立即对齐的显式操作）。
 */
export async function resyncChaptersFromDisk(projectId: string, opts?: { force?: boolean }): Promise<void> {
  if (!opts?.force) {
    const now = Date.now();
    const last = lastResyncAt.get(projectId) ?? 0;
    if (now - last < RESYNC_COOLDOWN_MS) return;
    lastResyncAt.set(projectId, now);
  }
  const novelDir = await resolveNovelDir(projectId);
  const chaptersDir = path.join(novelDir, 'chapters');
  let files: string[];
  try {
    files = await fs.readdir(chaptersDir);
  } catch { return; }

  const diskChapters = new Map<number, { title: string; wordCount: number }>();
  for (const file of files) {
    if (!file.endsWith('.md') || file.endsWith('.summary.md')) continue;
    // 只认正文章节命名；.degraded.md 归档文件不算正文
    const cn = file.match(/^第(\d+)章\.md$/);
    const en = file.match(/^chapter-(\d+)\.md$/i);
    const match = cn ?? en;
    if (!match) continue;
    const num = parseInt(match[1], 10);
    try {
      const content = await fs.readFile(path.join(chaptersDir, file), 'utf-8');
      const stripped = content.replace(/^[#*>\-[\]()!|]+\s*/gm, '').trim();
      const cjk = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
      const wordCount = cjk > 0 ? cjk : stripped.split(/\s+/).filter(Boolean).length;
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : '';
      diskChapters.set(num, { title, wordCount });
    } catch { /* skip unreadable */ }
  }

  const existing = await db.select().from(chapters)
    .where(eq(chapters.projectId, projectId));
  const existingByNum = new Map(existing.map((row) => [row.number, row]));

  // 删除 DB 有而磁盘无的行
  for (const row of existing) {
    if (!diskChapters.has(row.number)) {
      await db.delete(chapters)
        .where(and(eq(chapters.projectId, projectId), eq(chapters.number, row.number)))
        .catch(() => {});
    }
  }

  // 插入缺失 / 刷新已有
  for (const [num, meta] of diskChapters) {
    const row = existingByNum.get(num);
    if (!row) {
      await db.insert(chapters).values({
        id: generateId('ch_'),
        projectId,
        number: num,
        title: meta.title,
        wordCount: meta.wordCount,
        status: 'draft',
      }).catch(() => {});
    } else if (row.wordCount !== meta.wordCount || (row.title ?? '') !== meta.title) {
      await db.update(chapters)
        .set({ wordCount: meta.wordCount, title: meta.title, updatedAt: new Date() })
        .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
        .catch(() => {});
    }
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

// 手动触发磁盘 → DB 全量对齐（GET 已自动执行，此端点供脚本/回滚后显式刷新）
chaptersRouter.post('/resync', async (c) => {
  const projectId = c.req.param('projectId')!;
  try {
    await resyncChaptersFromDisk(projectId, { force: true });
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }
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

  // 项目串行锁：POST 会同步创建磁盘空正文文件，与 agent 写盘互踩
  // （其余写路径均已锁，此端点此前漏锁）。
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再创建章节',
      runId: activeRun.id,
    }, 409);
  }

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

  // 磁盘是事实源：同步创建空正文文件（含标题行），否则下一次 resync 会删除本行
  // （POST 只写 DB 的幽灵章节）。文件已存在时不动，避免覆盖 agent 写好的正文。
  try {
    const novelDir = await resolveNovelDir(projectId);
    const chaptersDir = path.join(novelDir, 'chapters');
    await fs.mkdir(chaptersDir, { recursive: true });
    const filePath = chapterFilePath(novelDir, body.number);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, `# ${chapter.title}\n`, 'utf-8');
    }
  } catch { /* 项目目录不可用时忽略 */ }

  return c.json({ chapter }, 201);
});

chaptersRouter.patch('/:num', async (c) => {
  const projectId = c.req.param('projectId')!;
  const num = parseInt(c.req.param('num'), 10);
  if (Number.isNaN(num)) return c.json({ error: 'Invalid chapter number' }, 400);
  const body = await c.req.json();

  // 正文落盘到 .novel/chapters/第{N}章.md（DB 不存正文列）
  if (typeof body.content === 'string') {
    // 项目串行锁：run 正在写该章时，编辑器覆盖落盘会与 agent 写盘互踩
    const activeRun = getActiveRunForProject(projectId);
    if (activeRun) {
      return c.json({
        error: 'run-in-progress',
        message: '该项目有正在运行的写作任务，请先等待完成或停止后再保存正文',
        runId: activeRun.id,
      }, 409);
    }
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

  // 项目串行锁：run 写入途中删文件会让 agent 后续写入与上下文状态错位
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再删除章节',
      runId: activeRun.id,
    }, 409);
  }

  const [deleted] = await db.delete(chapters)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .returning();

  if (!deleted) return c.json({ error: 'Not found' }, 404);

  // 磁盘是事实来源：删除 DB 行后同步删除正文与摘要文件，避免 resync 把它加回来
  let foreshadowRefsCleared = 0;
  try {
    const novelDir = await resolveNovelDir(projectId);
    await fs.unlink(chapterFilePath(novelDir, num)).catch(() => {});
    await fs.unlink(legacyChapterFilePath(novelDir, num)).catch(() => {});
    await fs.unlink(path.join(novelDir, 'chapters', `第${num}章.summary.md`)).catch(() => {});

    // 清理伏笔悬挂引用：plantedIn/resolvedIn 指向被删章节的置空，避免债务视图误报
    try {
      const fp = path.join(novelDir, 'foreshadow.json');
      const raw = await fs.readFile(fp, 'utf-8');
      const parsed = parseForeshadowFile(raw);
      for (const f of parsed.foreshadows) {
        if (f.plantedIn === num) { f.plantedIn = null; foreshadowRefsCleared++; }
        if (f.resolvedIn === num) { f.resolvedIn = null; foreshadowRefsCleared++; }
      }
      if (foreshadowRefsCleared > 0) {
        await fs.writeFile(fp, serializeForeshadows(parsed.foreshadows), 'utf-8');
      }
    } catch { /* 无伏笔文件或解析失败，忽略 */ }
  } catch { /* 目录不可用时忽略 */ }

  return c.json({ ok: true, foreshadowRefsCleared });
});

export default chaptersRouter;
