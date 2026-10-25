import { Hono } from 'hono';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectDir } from '../../shared/project-dir';
import { getActiveRunForProject } from '../../agent/run';
import { extractCanonChanges } from '../../agent/canon-extractor';
import { parseChapterNumber, chapterFileName } from '../../shared/chapter-names';
import {
  appendCanonChanges,
  readCanon,
  writeCanon,
  type CanonChanges,
  type CanonLedger,
} from '../../shared/canon';

const canonRouter = new Hono();

/** 项目串行锁：canon 提取会 LLM 写盘（canon.json + changes.jsonl），与 run 写盘互斥。
 * 命中锁时返回 409 Response，未命中返回 null（处理器必须 return 该 Response，
 * 只调 c.json 后 return undefined 会被当作「未处理」落到 404）。 */
function rejectIfRunActive(c: { json: (body: Record<string, unknown>, status?: number) => Response }, projectId: string): Response | null {
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再提取 canon',
      runId: activeRun.id,
    }, 409);
  }
  return null;
}

async function projectDirOr404(projectId: string): Promise<{ dir: string } | { response: Response }> {
  try {
    return { dir: await resolveProjectDir(projectId) };
  } catch {
    return { response: Response.json({ error: 'Project not found' }, { status: 404 }) };
  }
}

/** 读取 canon 台账。 */
canonRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const canon = await readCanon(resolved.dir);
  return c.json({ canon });
});

/** 全量覆盖 canon 台账（人工编辑/迁移用）。 */
canonRouter.put('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const body = await c.req.json().catch(() => null) as { canon?: unknown } | null;
  if (!body || body.canon === undefined) {
    return c.json({ error: 'body.canon is required' }, 400);
  }
  const canon = await writeCanon(resolved.dir, body.canon as CanonLedger);
  return c.json({ canon });
});

/**
 * 追加变更（推荐入口）。
 * body: { chapter?: number, changes: CanonChanges }
 */
canonRouter.post('/changes', async (c) => {
  const projectId = c.req.param('projectId')!;
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const body = await c.req.json().catch(() => null) as { chapter?: unknown; changes?: unknown } | null;
  if (!body || !body.changes || typeof body.changes !== 'object') {
    return c.json({ error: 'body.changes is required' }, 400);
  }
  const chapter = typeof body.chapter === 'number' && Number.isFinite(body.chapter)
    ? Math.max(1, Math.trunc(body.chapter))
    : 1;
  const result = await appendCanonChanges(resolved.dir, body.changes as CanonChanges, chapter);
  return c.json({ canon: result.ledger, warnings: result.warnings });
});

/**
 * 以磁盘为准读取第 N 章正文（.novel/chapters/ 下匹配章节正文命名，
 * 优先规范名 第N章.md，兼容「第N章 标题.md」等近似命名；排除摘要/归档）。
 * 找不到返回 null。
 */
async function readChapterBodyFromDisk(projectDir: string, chapter: number): Promise<string | null> {
  const chaptersDir = path.join(projectDir, '.novel', 'chapters');
  let entries: string[];
  try {
    entries = await readdir(chaptersDir);
  } catch {
    return null;
  }
  const canonical = chapterFileName(chapter);
  const match = entries.includes(canonical)
    ? canonical
    : entries.find((f) => parseChapterNumber(f) === chapter);
  if (!match) return null;
  try {
    return await readFile(path.join(chaptersDir, match), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 手动补录 canon 提取（P1-a）：对指定章正文跑一次 LLM 提取并写回台账。
 * 适用于自动提取失败/关闭后补录、或导入旧章节的回填。
 * body: { chapter: number, model?: string }
 */
canonRouter.post('/extract', async (c) => {
  const projectId = c.req.param('projectId')!;
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;
  const resolved = await projectDirOr404(projectId);
  if ('response' in resolved) return resolved.response;
  const body = await c.req.json().catch(() => null) as { chapter?: unknown; model?: unknown } | null;
  if (!body || typeof body.chapter !== 'number' || !Number.isFinite(body.chapter) || body.chapter < 1) {
    return c.json({ error: 'body.chapter must be a positive number' }, 400);
  }
  const chapter = Math.trunc(body.chapter);
  const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;

  const content = await readChapterBodyFromDisk(resolved.dir, chapter);
  if (content === null) {
    return c.json({ error: `第${chapter}章正文不存在（.novel/chapters/ 下未找到章节文件）` }, 404);
  }
  const result = await extractCanonChanges({ projectDir: resolved.dir, chapter, content, model });
  return c.json(result);
});

export default canonRouter;
