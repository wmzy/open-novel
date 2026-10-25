import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import { buildContextSectionReport, findNextUnwrittenChapter } from '../../agent/prompt-composer';

/**
 * 上下文检查器（只读）：
 * GET /api/projects/:projectId/context/preview?chapter=N
 * 返回写作上下文各层的 name/priority/tokens/kept 报告 + 总量/预算 + 组装后完整 prompt。
 * chapter 缺省时取下一章（与 composePrompt 的「继续写」章号推断一致）。
 */
const contextRouter = new Hono();

contextRouter.get('/preview', async (c) => {
  const projectId = c.req.param('projectId')!;

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const raw = c.req.query('chapter');
  let chapter: number;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return c.json({ error: 'chapter must be a positive integer' }, 400);
    }
    chapter = parsed;
  } else {
    chapter = await findNextUnwrittenChapter(projectDir);
  }

  const result = await buildContextSectionReport(projectDir, chapter, projectId);
  return c.json({ ...result, chapter });
});

export default contextRouter;
