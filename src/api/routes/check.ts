import { Hono } from 'hono';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { resolveProjectDir } from '../../shared/project-dir';
import {
  parseForeshadowFile,
  computeForeshadowStats,
  resolveCurrentChapter,
  type Foreshadow,
} from '../../shared/foreshadow';
import {
  detectAiPatterns,
  checkForeshadows,
  detectOoc,
  readChapter,
} from '../../agent/quality-checker';

const checkRouter = new Hono();

/** 宽容读取 .novel/foreshadow.json（新 schema + 旧格式迁移）；文件缺失返回空清单。 */
async function readForeshadowFile(projectDir: string): Promise<{
  foreshadows: Foreshadow[];
  migrated: boolean;
  warnings: string[];
}> {
  try {
    const raw = await readFile(path.join(projectDir, '.novel', 'foreshadow.json'), 'utf-8');
    return parseForeshadowFile(raw);
  } catch {
    return { foreshadows: [], migrated: false, warnings: [] };
  }
}

/** 读取 state.json 的 lastUpdatedChapter，缺失/损坏返回 0。 */
async function readLastUpdatedChapter(projectDir: string): Promise<number> {
  try {
    const raw = await readFile(path.join(projectDir, '.novel', 'state.json'), 'utf-8');
    const state = JSON.parse(raw) as { lastUpdatedChapter?: unknown };
    return typeof state.lastUpdatedChapter === 'number' && Number.isFinite(state.lastUpdatedChapter)
      ? state.lastUpdatedChapter
      : 0;
  } catch {
    return 0;
  }
}

/**
 * 反 AI 味检测。
 * body: { content?: string, chapterNum?: number, threshold?: number }
 * 优先使用传入的 content；否则按 chapterNum 读取章节正文。
 */
checkRouter.post('/ai-patterns', async (c) => {
  const projectId = c.req.param('projectId')!;
  let body: { content?: string; chapterNum?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // 允许空 body
  }

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  let text = typeof body.content === 'string' ? body.content : '';
  if (!text && typeof body.chapterNum === 'number') {
    text = await readChapter(projectDir, body.chapterNum);
  }
  if (!text) return c.json({ error: 'content or chapterNum is required' }, 400);

  const report = detectAiPatterns(text);
  return c.json(report);
});

/**
 * 伏笔遗忘 + 债务检测。
 * - 遗忘/提及分析：quality-checker 关键词比对（forgotten/resolved/healthy）
 * - 逾期检测：改用新 schema 的 resolveDeadline（债务系统），不再依赖提及间隔启发
 * query: threshold（连续未提及章节数阈值，默认 5，仅作用于遗忘检测）
 */
checkRouter.post('/foreshadows', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const thresholdRaw = c.req.query('threshold');
  const threshold = thresholdRaw ? parseInt(thresholdRaw, 10) : undefined;
  const report = await checkForeshadows(
    projectDir,
    Number.isFinite(threshold) ? threshold : undefined,
  );

  // 债务视角：宽容解析（旧格式自动迁移），currentChapter = max(进度章, 最大埋设章, 0)
  const { foreshadows, migrated, warnings } = await readForeshadowFile(projectDir);
  const currentChapter = resolveCurrentChapter(foreshadows, await readLastUpdatedChapter(projectDir));
  let chapterCount = 0;
  try {
    const [project] = await db
      .select({ chapterCount: projects.chapterCount })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    chapterCount = project?.chapterCount ?? 0;
  } catch { /* 章节数未知：孤儿章号判定自动跳过 */ }
  const stats = computeForeshadowStats(foreshadows, currentChapter, chapterCount);

  return c.json({
    ...report,
    // 逾期（期限已过未回收）与临近到期：按 resolveDeadline 判定
    overdue: stats.overdue,
    dueSoon: stats.dueSoon,
    debtScore: stats.debtScore,
    currentChapter,
    migrated,
    warnings,
  });
});

/**
 * 人物 OOC 检测。
 * body: { chapterNum: number }
 */
checkRouter.post('/ooc', async (c) => {
  const projectId = c.req.param('projectId')!;
  let body: { chapterNum?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // 允许空 body
  }

  if (typeof body.chapterNum !== 'number') {
    return c.json({ error: 'chapterNum is required' }, 400);
  }

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const report = await detectOoc(projectDir, body.chapterNum);
  return c.json(report);
});

export default checkRouter;
