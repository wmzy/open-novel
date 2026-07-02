import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import {
  detectAiPatterns,
  checkForeshadows,
  detectOoc,
  readChapter,
} from '../../agent/quality-checker';

const checkRouter = new Hono();

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
 * 伏笔遗忘检测。
 * query: threshold（连续未提及章节数阈值，默认 5）
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
  return c.json(report);
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
