import { Hono } from 'hono';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { getActiveRunForProject } from '../../agent/run';
import {
  parseForeshadowFile,
  serializeForeshadows,
  computeForeshadowStats,
  resolveCurrentChapter,
  extractChapterNumber,
  transitionForeshadow,
  FORESHADOW_TYPES,
  FORESHADOW_STATUSES,
  FORESHADOW_WEIGHTS,
  type Foreshadow,
  type ForeshadowType,
  type ForeshadowStatus,
  type ForeshadowWeight,
} from '../../shared/foreshadow';

/**
 * 伏笔债务系统路由（挂载于 /api/projects/:projectId/foreshadows）。
 * 数据只存文件层 .novel/foreshadow.json（不进 DB）：
 * - GET    /          → 清单 + 债务统计（含旧格式迁移标记与警告、顶层 overdue/dueSoon）
 * - POST   /          → 新建伏笔（服务端补默认值与自增 id）
 * - PATCH  /:fid      → 更新单条伏笔（status 走状态机：pending→planted→progressing→resolved，
 *                        planted 可直接 resolved；回退/重新打开须 body.reopen=true；进入 progressing
 *                        时把当前章号/body.chapter 追加到 progressedIn）
 * - DELETE /:fid      → 删除单条（并清理其余条目的 dependsOn 引用）
 */
const foreshadowRouter = new Hono();

const FORESHADOW_FILE = path.join('.novel', 'foreshadow.json');

/** 项目串行锁：写 foreshadow.json 与 agent 写盘互斥（此前漏锁，run 中编辑会互相覆盖）。
 * 命中锁时返回 409 Response，未命中返回 null——Hono 处理器必须 return 该 Response，
 * 只调 c.json 后 return undefined 会被当作「未处理」落到 404。 */
function rejectIfRunActive(c: { json: (body: Record<string, unknown>, status?: number) => Response }, projectId: string): Response | null {
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再修改伏笔',
      runId: activeRun.id,
    }, 409);
  }
  return null;
}

/** 读取项目根目录与章节数；项目不存在时抛出（由调用方转 404）。 */
async function loadProject(projectId: string): Promise<{ projectDir: string; chapterCount: number }> {
  const [project] = await db
    .select({ path: projects.path, chapterCount: projects.chapterCount })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return { projectDir: project.path, chapterCount: project.chapterCount ?? 0 };
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

/** 读取并宽容解析 foreshadow.json；文件缺失返回空清单。 */
async function readForeshadows(projectDir: string): Promise<{
  foreshadows: Foreshadow[];
  migrated: boolean;
  warnings: string[];
}> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectDir, FORESHADOW_FILE), 'utf-8');
  } catch {
    return { foreshadows: [], migrated: false, warnings: [] };
  }
  return parseForeshadowFile(raw);
}

/** 写回 foreshadow.json（确保 .novel 目录存在）。 */
async function writeForeshadows(projectDir: string, list: Foreshadow[]): Promise<void> {
  const novelDir = path.join(projectDir, '.novel');
  await mkdir(novelDir, { recursive: true });
  await writeFile(path.join(novelDir, 'foreshadow.json'), serializeForeshadows(list), 'utf-8');
}

/** 解析请求 body（空 body / 非 JSON 返回空对象）。 */
async function readBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** 枚举字段校验：值非法时返回 null（调用方转 400）。 */
function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
}

/** 章号字段校验：number 直收；含数字字符串提取；null 显式清空；其余视为非法。 */
function pickChapterField(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null) return { ok: true, value: null };
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: value };
  if (typeof value === 'string') {
    const extracted = extractChapterNumber(value);
    return extracted !== null ? { ok: true, value: extracted } : { ok: false };
  }
  return { ok: false };
}

/** 章号/ id 数组校验：数字或含数字字符串列表；非法返回 null。 */
function pickNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids: number[] = [];
  for (const v of value) {
    const n = extractChapterNumber(v);
    if (n === null) return null;
    ids.push(n);
  }
  return ids;
}

/** dependsOn 字段校验（复用章号数组校验）。 */
function pickDependsOn(value: unknown): number[] | null {
  return pickNumberArray(value);
}

/** 组装统计：currentChapter 取实际写作进度（未开写时回退最大规划埋设章）。 */
async function buildStatsPayload(projectDir: string, chapterCount: number, foreshadows: Foreshadow[]) {
  const lastUpdatedChapter = await readLastUpdatedChapter(projectDir);
  const currentChapter = resolveCurrentChapter(foreshadows, lastUpdatedChapter);
  return {
    currentChapter,
    chapterCount,
    stats: computeForeshadowStats(foreshadows, currentChapter, chapterCount),
  };
}

/** GET / → { foreshadows, stats, overdue, dueSoon, overdueIds, migrated, warnings, currentChapter, chapterCount }
 * overdue/dueSoon 与 stats 内同名数组一致，放在顶层便于前端直接消费；overdueIds 便于轻量标记列表。
 * 逾期边界：resolveDeadline < currentChapter（等于当前章为「本章到期」，不算逾期）。 */
foreshadowRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  let ctx: { projectDir: string; chapterCount: number };
  try {
    ctx = await loadProject(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }
  const { foreshadows, migrated, warnings } = await readForeshadows(ctx.projectDir);
  const { currentChapter, chapterCount, stats } = await buildStatsPayload(ctx.projectDir, ctx.chapterCount, foreshadows);
  return c.json({
    foreshadows,
    stats,
    overdue: stats.overdue,
    dueSoon: stats.dueSoon,
    overdueIds: stats.overdue.map((f) => f.id).sort((a, b) => a - b),
    migrated,
    warnings,
    currentChapter,
    chapterCount,
  });
});

/** POST / → 创建伏笔，服务端补默认值与自增 id。 */
foreshadowRouter.post('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    ({ projectDir } = await loadProject(projectId));
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const body = await readBody(c);
  if (typeof body.content !== 'string' || body.content.trim() === '') {
    return c.json({ error: 'content 必填且不能为空' }, 400);
  }

  const type = body.type === undefined ? 'chekhov' : pickEnum(body.type, FORESHADOW_TYPES);
  const status = body.status === undefined ? 'pending' : pickEnum(body.status, FORESHADOW_STATUSES);
  const weight = body.weight === undefined ? 'light' : pickEnum(body.weight, FORESHADOW_WEIGHTS);
  if (!type) return c.json({ error: `type 必须是 ${FORESHADOW_TYPES.join('/')}` }, 400);
  if (!status) return c.json({ error: `status 必须是 ${FORESHADOW_STATUSES.join('/')}` }, 400);
  if (!weight) return c.json({ error: `weight 必须是 ${FORESHADOW_WEIGHTS.join('/')}` }, 400);

  const plantedIn = pickChapterField(body.plantedIn ?? null);
  const resolveDeadline = pickChapterField(body.resolveDeadline ?? null);
  const resolvedIn = pickChapterField(body.resolvedIn ?? null);
  if (!plantedIn.ok) return c.json({ error: 'plantedIn 必须是章号（数字）或 null' }, 400);
  if (!resolveDeadline.ok) return c.json({ error: 'resolveDeadline 必须是章号（数字）或 null' }, 400);
  if (!resolvedIn.ok) return c.json({ error: 'resolvedIn 必须是章号（数字）或 null' }, 400);

  const dependsOn = body.dependsOn === undefined ? [] : pickDependsOn(body.dependsOn);
  if (dependsOn === null) return c.json({ error: 'dependsOn 必须是伏笔 id 数组' }, 400);

  const progressedInRaw = body.progressedIn === undefined ? [] : pickNumberArray(body.progressedIn);
  if (progressedInRaw === null) return c.json({ error: 'progressedIn 必须是章号数组' }, 400);
  const progressedIn = [...new Set(progressedInRaw)].sort((a, b) => a - b);

  const { foreshadows } = await readForeshadows(projectDir);
  const nextId = foreshadows.reduce((m, f) => Math.max(m, f.id), 0) + 1;
  const created: Foreshadow = {
    id: nextId,
    content: body.content.trim(),
    type: type as ForeshadowType,
    status: status as ForeshadowStatus,
    plantedIn: plantedIn.value,
    resolveDeadline: resolveDeadline.value,
    resolvedIn: resolvedIn.value,
    progressedIn,
    dependsOn,
    weight: weight as ForeshadowWeight,
  };
  await writeForeshadows(projectDir, [...foreshadows, created]);
  return c.json({ foreshadow: created }, 201);
});

/** PATCH /:fid → 更新单条伏笔的可变字段。 */
foreshadowRouter.patch('/:fid', async (c) => {
  const projectId = c.req.param('projectId')!;
  const fid = Number(c.req.param('fid'));
  if (!Number.isInteger(fid)) return c.json({ error: 'fid 必须是整数伏笔 id' }, 400);

  let projectDir: string;
  try {
    ({ projectDir } = await loadProject(projectId));
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const { foreshadows } = await readForeshadows(projectDir);
  const target = foreshadows.find((f) => f.id === fid);
  if (!target) return c.json({ error: `Foreshadow not found: ${fid}` }, 404);

  const body = await readBody(c);
  const updated: Foreshadow = { ...target, progressedIn: [...target.progressedIn] };

  if (body.content !== undefined) {
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      return c.json({ error: 'content 必须是非空字符串' }, 400);
    }
    updated.content = body.content.trim();
  }
  if (body.type !== undefined) {
    const v = pickEnum(body.type, FORESHADOW_TYPES);
    if (!v) return c.json({ error: `type 必须是 ${FORESHADOW_TYPES.join('/')}` }, 400);
    updated.type = v;
  }
  if (body.weight !== undefined) {
    const v = pickEnum(body.weight, FORESHADOW_WEIGHTS);
    if (!v) return c.json({ error: `weight 必须是 ${FORESHADOW_WEIGHTS.join('/')}` }, 400);
    updated.weight = v;
  }
  if (body.reopen !== undefined && typeof body.reopen !== 'boolean') {
    return c.json({ error: 'reopen 必须是布尔值' }, 400);
  }

  // 章号字段先暂存：状态迁移可能在 reopen 时清空 resolvedIn，
  // 调用方显式传入的值应覆盖迁移副作用。
  const chapterOverrides: Partial<Pick<Foreshadow, 'plantedIn' | 'resolveDeadline' | 'resolvedIn'>> = {};
  for (const key of ['plantedIn', 'resolveDeadline', 'resolvedIn'] as const) {
    if (body[key] !== undefined) {
      const picked = pickChapterField(body[key]);
      if (!picked.ok) return c.json({ error: `${key} 必须是章号（数字）或 null` }, 400);
      chapterOverrides[key] = picked.value;
      updated[key] = picked.value;
    }
  }
  if (body.dependsOn !== undefined) {
    const v = pickDependsOn(body.dependsOn);
    if (v === null) return c.json({ error: 'dependsOn 必须是伏笔 id 数组' }, 400);
    updated.dependsOn = v;
  }
  if (body.progressedIn !== undefined) {
    const v = pickNumberArray(body.progressedIn);
    if (v === null) return c.json({ error: 'progressedIn 必须是章号数组' }, 400);
    updated.progressedIn = [...new Set(v)].sort((a, b) => a - b);
  }

  // 状态迁移最后应用：非法迁移 400 且不落盘。
  const nextStatus: ForeshadowStatus | null = body.status === undefined
    ? null
    : pickEnum(body.status, FORESHADOW_STATUSES);
  if (body.status !== undefined && nextStatus === null) {
    return c.json({ error: `status 必须是 ${FORESHADOW_STATUSES.join('/')}` }, 400);
  }
  if (nextStatus !== null) {
    let transitionChapter: number | null = null;
    if (nextStatus === 'progressing') {
      if (body.chapter !== undefined) {
        const picked = pickChapterField(body.chapter);
        if (!picked.ok) return c.json({ error: 'chapter 必须是章号（数字）或 null' }, 400);
        transitionChapter = picked.value;
      } else if (nextStatus !== target.status) {
        // 仅在真正进入 progressing 的迁移时自动记录当前写作进度；
        // 已是 progressing 的重复 PATCH 需显式传 chapter，避免误追加。
        transitionChapter = resolveCurrentChapter(foreshadows, await readLastUpdatedChapter(projectDir));
      }
    }
    const transition = transitionForeshadow(updated, nextStatus, {
      reopen: body.reopen === true,
      chapter: transitionChapter,
    });
    if (!transition.ok) {
      return c.json({
        error: 'invalid-status-transition',
        message: transition.error,
        from: target.status,
        to: nextStatus,
        hint: '合法前向：pending→planted→progressing→resolved（planted 可直接 resolved）；回退/重新打开需 reopen=true 且目标为非终态',
      }, 400);
    }
    Object.assign(updated, transition.foreshadow);
    Object.assign(updated, chapterOverrides);
  }

  const list = foreshadows.map((f) => (f.id === fid ? updated : f));
  await writeForeshadows(projectDir, list);
  return c.json({ foreshadow: updated });
});

/** DELETE /:fid → 删除单条，并清理其余条目的 dependsOn 引用。 */
foreshadowRouter.delete('/:fid', async (c) => {
  const projectId = c.req.param('projectId')!;
  const fid = Number(c.req.param('fid'));
  if (!Number.isInteger(fid)) return c.json({ error: 'fid 必须是整数伏笔 id' }, 400);

  let projectDir: string;
  try {
    ({ projectDir } = await loadProject(projectId));
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const { foreshadows } = await readForeshadows(projectDir);
  if (!foreshadows.some((f) => f.id === fid)) {
    return c.json({ error: `Foreshadow not found: ${fid}` }, 404);
  }

  const list = foreshadows
    .filter((f) => f.id !== fid)
    .map((f) => ({ ...f, dependsOn: f.dependsOn.filter((d) => d !== fid) }));
  await writeForeshadows(projectDir, list);
  return c.json({ ok: true });
});

export default foreshadowRouter;
