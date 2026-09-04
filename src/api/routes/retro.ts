/**
 * 回溯影响分析路由。
 *
 * 挂载方式（由 api-app.ts 主控统一接线）：
 *   app.route('/api/projects/:projectId', retroRouter)
 *
 * 端点：
 *   POST /retro          —— 回溯影响分析：设定文件修订后扫描受影响面（正文/大纲/伏笔），
 *                            产物落盘 `.novel/retro/<yyyyMMdd-HHmmss>.md` 并返回同构 JSON。
 *   GET  /state-hygiene  —— 状态卫生：只读检测 state.json 中的规划期污染（不执行分离）。
 */
import { Hono } from 'hono';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectDir } from '../../shared/project-dir';
import { getActiveRunForProject } from '../../agent/run';
import { buildEntityDict, type EntityRef } from '../../shared/entity-dict';
import { splitTextByEntities } from '../../shared/entity-linker';
import {
  getStateTable,
  readIntentTable,
  readCharacterNames,
  isPlanningPolluted,
  type NovelState,
  type NovelIntent,
} from '../../agent/context-manager';

const retroRouter = new Hono();

// ===== 类型定义 =====

/** 受影响正文章节。 */
export interface RetroChapterHit {
  chapter: number;
  /** 相对 .novel/ 的文件路径。 */
  file: string;
  /** 该文件中命中的实体名。 */
  entities: string[];
}

/** 受影响大纲章节卡片。 */
export interface RetroOutlineHit {
  chapter: number;
  file: string;
  entities: string[];
}

/** 受影响伏笔条目。 */
export interface RetroForeshadowHit {
  id: string;
  /** 伏笔内容（超长截断到 60 字）。 */
  content: string;
  entities: string[];
}

/** 回溯影响分析报告（JSON 与 markdown 产物同构）。 */
export interface RetroReport {
  /** 本次修订的设定文件（相对 .novel/）。 */
  file: string;
  /** 修订备注（可选）。 */
  note?: string;
  /** 生成时间（ISO 字符串）。 */
  generatedAt: string;
  /** 从修订文件中识别出的实体名（首次出现顺序）。 */
  entities: string[];
  chapters: RetroChapterHit[];
  outlines: RetroOutlineHit[];
  foreshadows: RetroForeshadowHit[];
  /** 建议动作清单。 */
  actions: string[];
  /** 报告文件相对 .novel/ 的路径。 */
  reportPath: string;
}

// ===== 常量 =====

/** 实体档案目录：与前端 useEntityDict 的候选范围保持一致。 */
const ARCHIVE_DIRS = ['characters', 'world', 'concept', 'wuxia'];
/** 档案目录中排除的索引元文件。 */
const ARCHIVE_INDEX_FILES = new Set(['world/index.md', 'concept/index.md']);
/** 正文目录。 */
const CHAPTERS_DIR = 'chapters';
/** 大纲章节卡片目录。 */
const OUTLINE_CHAPTERS_DIR = path.join('outline', 'chapters');
/** 伏笔登记文件。 */
const FORESHADOW_FILE = 'foreshadow.json';
/** 报告产物目录（相对 .novel/）。 */
const RETRO_DIR = 'retro';
/** 伏笔内容摘要截断长度。 */
const FORESHADOW_CONTENT_MAX = 60;

// ===== 内部辅助 =====

/** 本地时间戳文件名：yyyyMMdd-HHmmss。 */
function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 从文本中按词典提取命中的实体名（保持首次出现顺序，去重）。 */
function collectMentions(text: string, dict: Map<string, EntityRef>): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const seg of splitTextByEntities(text, dict)) {
    if (seg.ref && !seen.has(seg.ref.name)) {
      seen.add(seg.ref.name);
      ordered.push(seg.ref.name);
    }
  }
  return ordered;
}

/** 读取目录下全部 .md 文本（排除摘要/退化文件），返回相对路径 + 内容。 */
async function readMarkdownDir(
  novelDir: string,
  relDir: string,
): Promise<Array<{ file: string; content: string }>> {
  const absDir = path.join(novelDir, relDir);
  let entries: string[];
  try {
    entries = await fs.readdir(absDir);
  } catch {
    return []; // 目录不存在
  }
  const result: Array<{ file: string; content: string }> = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    if (name.endsWith('.summary.md') || name.endsWith('.degraded.md')) continue;
    try {
      const content = await fs.readFile(path.join(absDir, name), 'utf-8');
      result.push({ file: path.posix.join(relDir, name).replace(/\\/g, '/'), content });
    } catch {
      // 单个文件读取失败则跳过
    }
  }
  return result;
}

/** 从文件名提取章节号（第N章.md / chapter-N.md / 任意数字），失败返回 0。 */
function chapterNumberFrom(file: string): number {
  const m = file.match(/第(\d+)章/) || file.match(/chapter-(\d+)/) || file.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 宽容解析 .novel/foreshadow.json：接受数组或 { foreshadows: [...] } 两种形态。 */
async function readForeshadowEntries(
  novelDir: string,
): Promise<Array<{ id: string; content: string }>> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(novelDir, FORESHADOW_FILE), 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { foreshadows?: unknown[] }).foreshadows)
      ? (parsed as { foreshadows: unknown[] }).foreshadows
      : [];
  return list
    .filter(
      (item): item is { id: unknown; content: string } =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { content?: unknown }).content === 'string',
    )
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      content: item.content,
    }));
}

/** 构建实体词典：档案目录（characters/world/concept/wuxia）+ 修订文件本身。 */
async function buildArchiveDict(
  projectDir: string,
  novelDir: string,
  file: string,
  fileContent: string,
): Promise<Map<string, EntityRef>> {
  const sources: Array<{ path: string; content: string }> = [{ path: file, content: fileContent }];
  for (const dir of ARCHIVE_DIRS) {
    for (const doc of await readMarkdownDir(novelDir, dir)) {
      if (ARCHIVE_INDEX_FILES.has(doc.file)) continue;
      sources.push({ path: doc.file, content: doc.content });
    }
  }
  const dict = buildEntityDict(sources);
  if (dict.size > 0) return dict;

  // 降级：词典为空时用 characters/profiles.md 的角色名列表做子串识别
  const names = await readCharacterNames(projectDir);
  const fallback = new Map<string, EntityRef>();
  for (const name of names) {
    fallback.set(name, {
      name,
      type: 'character',
      file: '',
      sectionTitle: '',
      sectionRaw: '',
    });
  }
  return fallback;
}

/** 生成建议动作清单（确定性规则，非占位）。 */
function buildActions(report: Omit<RetroReport, 'actions' | 'reportPath'>): string[] {
  if (report.entities.length === 0) {
    return ['未在修订文件中识别到实体，未发现受影响面，可继续写作。'];
  }
  const actions: string[] = [];
  for (const ch of report.chapters) {
    actions.push(`复核第${ch.chapter}章正文：提及「${ch.entities.join('、')}」，核对设定修订后的描写一致性。`);
  }
  for (const ol of report.outlines) {
    actions.push(`同步大纲第${ol.chapter}章卡片：提及「${ol.entities.join('、')}」，更新对应设定描述。`);
  }
  for (const fo of report.foreshadows) {
    const label = fo.id ? `伏笔 ${fo.id}` : '伏笔';
    actions.push(`检查${label}：内容提及「${fo.entities.join('、')}」，确认埋设/回收计划是否需要调整。`);
  }
  if (actions.length === 0) {
    return ['识别到的实体未在正文/大纲/伏笔中被提及，暂无需要回溯的受影响面。'];
  }
  return actions;
}

/** 报告渲染为 markdown（变更来源/受影响章节表/受影响大纲表/受影响伏笔表/建议动作清单）。 */
function renderReportMarkdown(report: RetroReport): string {
  const lines: string[] = [];
  const localTime = new Date(report.generatedAt).toLocaleString('zh-CN');

  lines.push('# 回溯影响分析', '');
  lines.push('## 变更来源', '');
  lines.push(`- 文件：\`${report.file}\``);
  if (report.note) lines.push(`- 备注：${report.note}`);
  lines.push(`- 生成时间：${localTime}`);
  lines.push(`- 识别实体：${report.entities.length > 0 ? report.entities.join('、') : '（无）'}`, '');

  lines.push(`## 受影响章节（${report.chapters.length}）`, '');
  if (report.chapters.length === 0) {
    lines.push('（无）', '');
  } else {
    lines.push('| 章节 | 文件 | 提及实体 |', '| --- | --- | --- |');
    for (const ch of report.chapters) {
      lines.push(`| 第${ch.chapter}章 | \`${ch.file}\` | ${ch.entities.join('、')} |`);
    }
    lines.push('');
  }

  lines.push(`## 受影响大纲（${report.outlines.length}）`, '');
  if (report.outlines.length === 0) {
    lines.push('（无）', '');
  } else {
    lines.push('| 章节 | 文件 | 提及实体 |', '| --- | --- | --- |');
    for (const ol of report.outlines) {
      lines.push(`| 第${ol.chapter}章 | \`${ol.file}\` | ${ol.entities.join('、')} |`);
    }
    lines.push('');
  }

  lines.push(`## 受影响伏笔（${report.foreshadows.length}）`, '');
  if (report.foreshadows.length === 0) {
    lines.push('（无）', '');
  } else {
    lines.push('| 伏笔 | 内容摘要 | 提及实体 |', '| --- | --- | --- |');
    for (const fo of report.foreshadows) {
      lines.push(`| ${fo.id || '（无编号）'} | ${fo.content} | ${fo.entities.join('、')} |`);
    }
    lines.push('');
  }

  lines.push('## 建议动作清单', '');
  for (const a of report.actions) lines.push(`- [ ] ${a}`);
  return lines.join('\n') + '\n';
}

/**
 * 回溯影响扫描（导出供测试复用）。
 *
 * 步骤：
 * 1. 读取修订文件内容，用实体词典（entity-dict + entity-linker，降级为 profiles 角色名）识别其中的实体；
 * 2. 扫描 chapters/*.md 正文、outline/chapters/*.md 大纲卡片、foreshadow.json 伏笔 content；
 * 3. 生成报告写入 `.novel/retro/<yyyyMMdd-HHmmss>.md`，返回与 markdown 同构的 JSON 数据。
 *
 * 修订文件不存在时抛出异常，由路由层转为 404。
 */
export async function scanRetroImpact(
  projectDir: string,
  file: string,
  note?: string,
): Promise<RetroReport> {
  const novelDir = path.join(projectDir, '.novel');
  const fileContent = await fs.readFile(path.join(novelDir, file), 'utf-8');

  const dict = await buildArchiveDict(projectDir, novelDir, file, fileContent);
  const entities = collectMentions(fileContent, dict);
  // 只把命中的实体放进扫描词典，避免全词典误报
  const mentionDict = new Map<string, EntityRef>();
  for (const name of entities) mentionDict.set(name, dict.get(name)!);

  const base: Omit<RetroReport, 'actions' | 'reportPath'> = {
    file,
    note: note && note.trim() !== '' ? note.trim() : undefined,
    generatedAt: new Date().toISOString(),
    entities,
    chapters: [],
    outlines: [],
    foreshadows: [],
  };

  // 1. 正文章节
  for (const doc of await readMarkdownDir(novelDir, CHAPTERS_DIR)) {
    const hit = collectMentions(doc.content, mentionDict);
    if (hit.length > 0) {
      base.chapters.push({ chapter: chapterNumberFrom(doc.file), file: doc.file, entities: hit });
    }
  }
  base.chapters.sort((a, b) => a.chapter - b.chapter);

  // 2. 大纲章节卡片
  for (const doc of await readMarkdownDir(novelDir, OUTLINE_CHAPTERS_DIR)) {
    const hit = collectMentions(doc.content, mentionDict);
    if (hit.length > 0) {
      base.outlines.push({ chapter: chapterNumberFrom(doc.file), file: doc.file, entities: hit });
    }
  }
  base.outlines.sort((a, b) => a.chapter - b.chapter);

  // 3. 伏笔 content
  for (const fo of await readForeshadowEntries(novelDir)) {
    const hit = collectMentions(fo.content, mentionDict);
    if (hit.length > 0) {
      const clipped =
        fo.content.length > FORESHADOW_CONTENT_MAX
          ? fo.content.slice(0, FORESHADOW_CONTENT_MAX) + '…'
          : fo.content;
      base.foreshadows.push({ id: fo.id, content: clipped, entities: hit });
    }
  }

  const report: RetroReport = {
    ...base,
    actions: buildActions(base),
    reportPath: path.posix.join(RETRO_DIR, `${formatStamp(new Date())}.md`),
  };

  // 产物落盘 .novel/retro/
  const retroDir = path.join(novelDir, RETRO_DIR);
  await fs.mkdir(retroDir, { recursive: true });
  await fs.writeFile(
    path.join(retroDir, path.posix.basename(report.reportPath)),
    renderReportMarkdown(report),
    'utf-8',
  );

  return report;
}

/** 状态卫生报告（纯函数，导出供测试复用；不做任何写盘）。 */
export function buildHygieneReport(
  state: NovelState,
  intent: NovelIntent,
): { pollution: Array<{ name: string; fields: string[] }>; intentCount: number } {
  return {
    pollution: state.characters.filter(isPlanningPolluted).map((c) => ({
      name: c.name,
      fields: (['location', 'emotion'] as const).filter((f) => c[f] !== ''),
    })),
    intentCount: intent.characters.length,
  };
}

// ===== 路由 =====

/**
 * 回溯影响分析。
 * body: { file: string, note?: string }（file 为相对 .novel/ 的设定文件路径）
 */
retroRouter.post('/retro', async (c) => {
  const projectId = c.req.param('projectId')!;
  let body: { file?: string; note?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // 允许空 body，由下方校验兜底
  }

  if (typeof body.file !== 'string' || body.file.trim() === '') {
    return c.json({ error: 'file is required' }, 400);
  }

  // 项目串行锁：retro 会扫描全部正文并写 .novel/retro/ 报告，与 agent 写盘互斥
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再执行回溯分析',
      runId: activeRun.id,
    }, 409);
  }

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  // 路径安全：禁止绝对路径与 .. 逃逸；容忍 .novel/ 前缀
  const rel = body.file.trim().replace(/^\.novel\//, '');
  const normalized = path.normalize(rel).replace(/^([/\\])+/, '');
  if (normalized === '' || normalized === '.' || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return c.json({ error: 'invalid file path' }, 400);
  }

  let report: RetroReport;
  try {
    report = await scanRetroImpact(projectDir, normalized, body.note);
  } catch {
    return c.json({ error: '设定文件不存在或不可读' }, 404);
  }
  return c.json(report);
});

/**
 * 状态卫生（只读）：检测 state.json 中的规划期污染，不执行分离。
 * 返回 { pollution: [{ name, fields }], intentCount }。
 */
retroRouter.get('/state-hygiene', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const [state, intent] = await Promise.all([
    getStateTable(projectDir),
    readIntentTable(projectDir),
  ]);
  return c.json(buildHygieneReport(state, intent));
});

export default retroRouter;
