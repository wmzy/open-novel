/**
 * 编辑器内联 AI 端点（P2）：对章节片段执行润色/扩写/续写。
 *
 * 与 rewrite（SSE run）不同，这是一次性同步 JSON 请求——片段级任务无需流式，
 * 失败直接 500 带错误消息；项目串行锁仍然生效（结果要写回章节文件，
 * callPiOnce 与 run 同时读写项目文件会互踩）。
 *
 * body: { chapter, action, selection?, selectionStart?, tailContext?, model? }
 * 返回 { result, plan }——plan 为段落级合并计划（shared/inline-edit），
 * 前端据此渲染 diff 预览，用户确认后才写入正文。
 */
import { Hono } from 'hono';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectDir } from '../../shared/project-dir';
import { getActiveRunForProject } from '../../agent/run';
import { callPiOnce } from '../../agent/pi/runtime';
import { parseChapterNumber, chapterFileName } from '../../shared/chapter-names';
import {
  buildInlineEditPrompt,
  splitParagraphs,
  planParagraphMerge,
  INLINE_ACTION_LABELS,
  type InlineAction,
} from '../../shared/inline-edit';
import { config } from '../../config';

const inlineRouter = new Hono();

/** 片段级任务上限 5 分钟，且不超过全局 run 超时。 */
const INLINE_TIMEOUT_MS = Math.min(config.agent.timeoutMs, 5 * 60 * 1000);

const INLINE_ACTIONS = new Set<InlineAction>(['polish', 'expand', 'continue']);

/** 项目串行锁（同 review/canon：命中返回 409 Response，处理器必须 return 该 Response，
 * 只调 c.json 后 return undefined 会被当作「未处理」落到 404）。 */
function rejectIfRunActive(c: { json: (body: Record<string, unknown>, status?: number) => Response }, projectId: string): Response | null {
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再使用内联 AI',
      runId: activeRun.id,
    }, 409);
  }
  return null;
}

/**
 * 以磁盘为准读取第 N 章正文（.novel/chapters/ 下匹配章节正文命名，
 * 优先规范名 第N章.md，兼容「第N章 标题.md」等近似命名；排除摘要/归档）。
 * 找不到返回 null。与 canon.ts 同策略。
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

inlineRouter.post('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }

  const body = await c.req.json().catch(() => null) as {
    chapter?: unknown;
    action?: unknown;
    selection?: unknown;
    selectionStart?: unknown;
    tailContext?: unknown;
    model?: unknown;
  } | null;
  if (!body || typeof body.chapter !== 'number' || !Number.isFinite(body.chapter) || body.chapter < 1) {
    return c.json({ error: 'body.chapter must be a positive number' }, 400);
  }
  if (typeof body.action !== 'string' || !INLINE_ACTIONS.has(body.action as InlineAction)) {
    return c.json({ error: "body.action must be one of 'polish' | 'expand' | 'continue'" }, 400);
  }
  const action = body.action as InlineAction;
  const selection = typeof body.selection === 'string' ? body.selection : '';
  if (action !== 'continue' && selection.trim().length === 0) {
    return c.json({ error: '润色/扩写需要非空选中文本（body.selection）' }, 400);
  }

  const chapter = Math.trunc(body.chapter);
  const content = await readChapterBodyFromDisk(projectDir, chapter);
  if (content === null) {
    return c.json({ error: `第${chapter}章正文不存在（.novel/chapters/ 下未找到章节文件）` }, 404);
  }

  // 定位选区/光标以取前后文：优先显式 selectionStart（选区需与 selection 吻合），
  // 选区不吻合时回退按内容定位；都失败则续写兜底 tailContext（上下文缺省 prompt 仍可用）。
  let cursor = -1;
  if (typeof body.selectionStart === 'number' && Number.isFinite(body.selectionStart)
    && body.selectionStart >= 0 && body.selectionStart <= content.length) {
    cursor = Math.trunc(body.selectionStart);
  }
  if (selection && (cursor < 0 || content.slice(cursor, cursor + selection.length) !== selection)) {
    cursor = content.indexOf(selection);
  }
  const before = cursor >= 0 ? content.slice(0, cursor) : String(body.tailContext ?? '');
  const after = cursor >= 0 && selection ? content.slice(cursor + selection.length) : '';

  const prompt = buildInlineEditPrompt(action, selection, { chapter, before, after });

  const model = typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : null;
  let result: string;
  try {
    result = (await callPiOnce(prompt, projectDir, INLINE_TIMEOUT_MS, { model })).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `内联${INLINE_ACTION_LABELS[action] ?? ''}调用失败：${msg}` }, 500);
  }
  if (!result) {
    return c.json({ error: 'AI 未返回内容，请重试或更换模型' }, 500);
  }

  // 段落合并计划：润色/扩写以选区为原文；续写无原文，全部是追加段落。
  const origParas = action === 'continue' ? [] : splitParagraphs(selection);
  const plan = planParagraphMerge(origParas, splitParagraphs(result));
  return c.json({ result, plan });
});

export default inlineRouter;
