/**
 * 提示词预设 API（P2）：/api/projects/:projectId/presets
 *
 * - CRUD + 版本（append-only）+ 阶段绑定 + SKILL.md 导入；
 * - GET /preview?stage=X 组装预览：绑定预设内容（preset:start/end 边界标记）+ 只读复用
 *   prompt-composer 的分层上下文（buildContextSectionReport，与 /context/preview 同一通道）。
 *   非 writing 族阶段上下文层退化为 concept/world 示意层（buildContextSectionReport 语义是写作章）。
 * - 写操作一律项目串行锁（与审阅/写作 run 互斥）；GET 只读放行。
 */
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectDir } from '../../shared/project-dir';
import { STAGES, isWritingStage } from '../../shared/stages';
import {
  listPresets,
  getPresetDetail,
  createPreset,
  addVersion,
  setCurrentVersion,
  renamePreset,
  deletePreset,
  importFromSkillFile,
  getStageBindings,
  setStageBinding,
  resolveActivePresetPrompt,
} from '../../shared/prompt-presets';
import { getActiveRunForProject } from '../../agent/run';
import { estimateTokens } from '../../agent/context-budget';
import { buildContextSectionReport, findNextUnwrittenChapter } from '../../agent/prompt-composer';

const presetsRouter = new Hono();

/** 项目串行锁：预设写盘与 run 写盘互斥。
 * 命中锁返回 409 Response，未命中返回 null（处理器必须 return 该 Response，
 * 只调 c.json 后 return undefined 会被当作「未处理」落到 404——见 review.ts 同款注释）。 */
function rejectIfRunActive(
  c: { json: (body: Record<string, unknown>, status?: number) => Response },
  projectId: string,
): Response | null {
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再修改提示词预设',
      runId: activeRun.id,
    }, 409);
  }
  return null;
}

/** 解析 body 为 JSON 对象；非 JSON 返回 null（处理器回 400）。 */
async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 预览边界标记：前端/测试据此识别 prompt 中预设部分的起止。 */
export const PRESET_START_MARK = '<!-- preset:start -->';
export const PRESET_END_MARK = '<!-- preset:end -->';

/** 非 writing 阶段示意层单文件与总量字符上限（示意用途，避免预览爆炸）。 */
const SUGGESTIVE_FILE_CHAR_CAP = 4000;
const SUGGESTIVE_TOTAL_CHAR_CAP = 16_000;

/**
 * 非 writing 阶段的退化上下文：读 .novel/concept、.novel/world 的 .md 拼示意层。
 * buildContextSectionReport 的分层（状态/伏笔/滚动摘要）语义是「正在写的这一章」，
 * 规划阶段不适用，这里只给核心设定的示意并在预览中注明。
 */
async function buildSuggestiveContextLayer(projectDir: string): Promise<string> {
  const blocks: string[] = [];
  let total = 0;
  for (const dir of ['concept', 'world']) {
    let files: string[];
    try {
      files = (await fs.readdir(path.join(projectDir, '.novel', dir), { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort();
    } catch {
      continue; // 目录不存在 → 该层为空
    }
    for (const file of files) {
      if (total >= SUGGESTIVE_TOTAL_CHAR_CAP) break;
      let content = await fs.readFile(path.join(projectDir, '.novel', dir, file), 'utf-8');
      if (content.length > SUGGESTIVE_FILE_CHAR_CAP) {
        content = `${content.slice(0, SUGGESTIVE_FILE_CHAR_CAP)}\n……（示意层已截断）`;
      }
      blocks.push(`### ${dir}/${file}\n\n${content.trim()}`);
      total += content.length;
    }
  }
  if (blocks.length === 0) return '';
  return `## Novel Context Layers（示意：上下文层仅写作阶段完整，此处只列出 concept/world 核心设定）\n\n${blocks.join('\n\n')}`;
}

/** GET / — 预设列表（含 current/版本数/绑定阶段）+ 绑定表 */
presetsRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const [presets, bindings] = await Promise.all([
    listPresets(projectDir),
    getStageBindings(projectDir),
  ]);
  return c.json({
    presets: presets.map((p) => ({
      ...p,
      boundStages: STAGES.filter((s) => bindings[s.id] === p.id).map((s) => s.id),
    })),
    bindings,
  });
});

/** GET /preview?stage=X — 组装预览（只读，不加 run 锁）。注意先于 GET /:id 注册。 */
presetsRouter.get('/preview', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const stage = c.req.query('stage') ?? '';
  if (!STAGES.some((s) => s.id === stage)) {
    return c.json({ error: `未知阶段：${stage || '(空)'}` }, 400);
  }

  // 预设部分：无绑定 → null（预览只剩上下文层）；库损坏（版本文件缺失）会抛错 → 500 显式暴露
  const active = await resolveActivePresetPrompt(projectDir, stage);
  const parts: string[] = [];
  if (active) {
    parts.push(`${PRESET_START_MARK}\n## 提示词预设：${active.name}（v${active.version}）\n\n${active.content}\n${PRESET_END_MARK}`);
  }

  // 上下文部分：writing 族复用与 /context/preview 相同的只读通道；其余阶段给示意层
  let note: string | null = null;
  if (isWritingStage(stage)) {
    const chapter = await findNextUnwrittenChapter(projectDir);
    const ctx = await buildContextSectionReport(projectDir, chapter, projectId);
    parts.push(ctx.prompt);
  } else {
    note = '上下文层仅写作阶段完整，此处为示意';
    const layer = await buildSuggestiveContextLayer(projectDir);
    if (layer) parts.push(layer);
  }

  const prompt = parts.filter((p) => p.trim() !== '').join('\n\n');
  return c.json({
    prompt,
    presetId: active?.presetId ?? null,
    version: active?.version ?? null,
    tokensApprox: estimateTokens(prompt),
    ...(note ? { note } : {}),
  });
});

/** GET /:id — 预设详情（含各版本全文，供版本历史展示） */
presetsRouter.get('/:id', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  try {
    const detail = await getPresetDetail(projectDir, c.req.param('id')!);
    if (!detail) return c.json({ error: '预设不存在' }, 404);
    return c.json(detail);
  } catch {
    // id 不合法（目录名约束）与不存在同视：404
    return c.json({ error: '预设不存在' }, 404);
  }
});

/** POST / — 新建预设（body: name/stage?/content/description?/id?） */
presetsRouter.post('/', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const body = await readJsonBody(c);
  if (!body) return c.json({ error: '请求体必须是 JSON 对象' }, 400);
  try {
    const preset = await createPreset(projectDir, {
      id: typeof body.id === 'string' ? body.id : undefined,
      name: typeof body.name === 'string' ? body.name : '',
      stage: typeof body.stage === 'string' ? body.stage : '',
      content: typeof body.content === 'string' ? body.content : '',
      description: typeof body.description === 'string' ? body.description : undefined,
    });
    return c.json({ preset }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '创建预设失败' }, 400);
  }
});

/** POST /:id/versions — 追加新版本（append-only，current 自动指向新版） */
presetsRouter.post('/:id/versions', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const id = c.req.param('id')!;
  if (!(await getPresetDetail(projectDir, id))) return c.json({ error: '预设不存在' }, 404);
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: '请求体必须是 JSON 对象' }, 400);
  try {
    const version = await addVersion(projectDir, id, {
      content: typeof body.content === 'string' ? body.content : '',
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    return c.json({ version }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '追加版本失败' }, 400);
  }
});

/** PATCH /:id — 切换 current 版本或改名 */
presetsRouter.patch('/:id', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const id = c.req.param('id')!;
  if (!(await getPresetDetail(projectDir, id))) return c.json({ error: '预设不存在' }, 404);
  const body = await readJsonBody(c);
  if (!body) return c.json({ error: '请求体必须是 JSON 对象' }, 400);
  if (body.current === undefined && body.name === undefined) {
    return c.json({ error: '至少提供 current 或 name 之一' }, 400);
  }
  try {
    if (body.current !== undefined) {
      if (typeof body.current !== 'number' || !Number.isInteger(body.current)) {
        return c.json({ error: 'current 必须是整数版本号' }, 400);
      }
      await setCurrentVersion(projectDir, id, body.current);
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') return c.json({ error: 'name 必须是字符串' }, 400);
      await renamePreset(projectDir, id, body.name);
    }
    const detail = await getPresetDetail(projectDir, id);
    return c.json({ preset: detail?.manifest ?? null });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '更新预设失败' }, 400);
  }
});

/** DELETE /:id — 删除预设（目录整体删除，绑定自动清理） */
presetsRouter.delete('/:id', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  try {
    await deletePreset(projectDir, c.req.param('id')!);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '删除预设失败' }, 404);
  }
});

/** POST /import-skill — 从绝对路径 SKILL.md 导入（只读源文件一次，剥 frontmatter） */
presetsRouter.post('/import-skill', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const body = await readJsonBody(c);
  if (!body) return c.json({ error: '请求体必须是 JSON 对象' }, 400);
  if (typeof body.skillPath !== 'string' || !body.skillPath.trim()) {
    return c.json({ error: 'skillPath 不能为空' }, 400);
  }
  try {
    const preset = await importFromSkillFile(projectDir, {
      skillPath: body.skillPath,
      name: typeof body.name === 'string' ? body.name : undefined,
      stage: typeof body.stage === 'string' ? body.stage : undefined,
    });
    return c.json({ preset }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '导入失败' }, 400);
  }
});

/** PUT /bindings — 设置/清空阶段绑定（body: { stage, presetId: string | null }） */
presetsRouter.put('/bindings', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: '项目不存在' }, 404);
  }
  const locked = rejectIfRunActive(c, projectId);
  if (locked) return locked;

  const body = await readJsonBody(c);
  if (!body) return c.json({ error: '请求体必须是 JSON 对象' }, 400);
  if (typeof body.stage !== 'string') return c.json({ error: 'stage 不能为空' }, 400);
  const presetId = body.presetId === null ? null : body.presetId;
  if (presetId !== null && typeof presetId !== 'string') {
    return c.json({ error: 'presetId 必须是字符串或 null' }, 400);
  }
  try {
    const bindings = await setStageBinding(projectDir, body.stage, presetId);
    return c.json({ bindings });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : '设置绑定失败' }, 400);
  }
});

export default presetsRouter;
