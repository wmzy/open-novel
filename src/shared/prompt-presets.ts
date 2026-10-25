/**
 * 项目级提示词预设库（P2，docs/改进计划-内置Pi-SDK.md §7）。
 *
 * 目录结构（projectDir/.novel/prompt-presets/）：
 *   bindings.json           阶段绑定：{ [stage]: presetId | null }（7 主阶段）
 *   <presetId>/manifest.json  { id, name, stage, description, current, versions[] }
 *   <presetId>/v<N>.md         第 N 版提示词内容——append-only：旧版本文件永不改写/删除。
 *
 * 语义要点：
 * - addVersion 只追加新 vN.md 并把 current 指向新版；setCurrentVersion 仅改 current。
 * - manifest.json 落盘在版本文件之后写入（listPresets 以 manifest 为识别标记，半成品目录不会被列出）。
 * - 本模块只做「存储 + 取数」；composePrompt 消费链路（真正注入 prompt）由父任务评估接线，
 *   预览端点用 resolveActivePresetPrompt 组装。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pinyin } from 'pinyin-pro';
import { STAGES } from './stages';

export interface PresetVersionMeta {
  version: number;
  /** 版本说明（如「加强文风约束」）。 */
  note: string;
  /** ISO 创建时间。 */
  createdAt: string;
  /** 版本内容文件名（v1.md、v2.md…，位于预设目录内）。 */
  file: string;
}

export interface PresetManifest {
  id: string;
  name: string;
  /** 该预设设计用于的阶段（元信息，供 UI 徽标展示；绑定校验看 bindings）。 */
  stage: string;
  description: string;
  /** 当前启用版本号（必须能在 versions 中找到）。 */
  current: number;
  /** append-only 版本列表（按 version 升序）。 */
  versions: PresetVersionMeta[];
}

export interface PresetSummary {
  id: string;
  name: string;
  stage: string;
  description: string;
  current: number;
  versionCount: number;
}

export interface PresetVersionDetail extends PresetVersionMeta {
  content: string;
}

export interface PresetDetail {
  manifest: PresetManifest;
  versions: PresetVersionDetail[];
}

/** 阶段绑定表：key 为 7 主阶段 id，value 为预设 id 或 null（未绑定）。 */
export type StageBindings = Record<string, string | null>;

/** resolveActivePresetPrompt 的结果：当前启用预设的定位信息与内容。 */
export interface ActivePresetPrompt {
  presetId: string;
  name: string;
  version: number;
  content: string;
}

export interface CreatePresetOptions {
  id?: string;
  name: string;
  /** 缺省 ''（不限定阶段）。 */
  stage?: string;
  content: string;
  description?: string;
  /** 首版版本说明，缺省「初始版本」。 */
  note?: string;
}

export interface AddVersionOptions {
  content: string;
  /** 缺省「第 N 版」。 */
  note?: string;
}

/** 预设目录名约束：小写字母数字 + 连字符，防路径穿越。 */
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** slug 长度上限：中文转拼音后控制目录名长度。 */
const SLUG_MAX_LENGTH = 64;

/** 自动 id 撞名时的最大序号尝试次数（-2、-3…）。 */
const AUTO_ID_MAX_SEQ = 100;

function presetsRoot(projectDir: string): string {
  return path.join(projectDir, '.novel', 'prompt-presets');
}

function bindingsFile(projectDir: string): string {
  return path.join(presetsRoot(projectDir), 'bindings.json');
}

/** 临时文件 + rename 原子写（与 novel-config.ts 同一模式，避免并发读到半个 JSON）。 */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  await fs.rename(tmp, file);
}

/** 名称 → 预设目录名 slug：中文转无调拼音，非字母数字折叠为连字符（与 projects.ts 的目录派生一致）。 */
function slugifyPresetName(name: string): string {
  const py = pinyin(name, { toneType: 'none', type: 'array' }).join('');
  const slug = py
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug || 'preset';
}

function validatePresetId(id: string): void {
  if (!PRESET_ID_RE.test(id)) {
    throw new Error('预设 id 只能包含小写字母、数字与连字符');
  }
}

/** 读 manifest；目录/文件缺失或 JSON 损坏返回 null（损坏目录视为不存在，listPresets 也会跳过）。 */
async function readManifest(projectDir: string, id: string): Promise<PresetManifest | null> {
  validatePresetId(id);
  try {
    const raw = await fs.readFile(path.join(presetsRoot(projectDir), id, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(raw) as PresetManifest;
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.versions)) return null;
    return manifest;
  } catch {
    return null;
  }
}

/** 读某版本内容文件；文件缺失属于库损坏（append-only 下不该发生），显式抛错而非静默降级。 */
async function readVersionContent(projectDir: string, id: string, file: string): Promise<string> {
  const content = await fs.readFile(path.join(presetsRoot(projectDir), id, file), 'utf-8');
  return content;
}

export async function listPresets(projectDir: string): Promise<PresetSummary[]> {
  let entries;
  try {
    entries = await fs.readdir(presetsRoot(projectDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: PresetSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readManifest(projectDir, entry.name);
    if (!manifest || manifest.id !== entry.name) continue;
    summaries.push({
      id: manifest.id,
      name: manifest.name,
      stage: manifest.stage ?? '',
      description: manifest.description ?? '',
      current: manifest.current,
      versionCount: manifest.versions.length,
    });
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return summaries;
}

export async function getPreset(projectDir: string, id: string): Promise<PresetManifest | null> {
  return readManifest(projectDir, id);
}

/** 详情：manifest + 各版本全文（预设体量小，全量返回供版本历史展示）。 */
export async function getPresetDetail(projectDir: string, id: string): Promise<PresetDetail | null> {
  const manifest = await readManifest(projectDir, id);
  if (!manifest) return null;
  const versions: PresetVersionDetail[] = [];
  for (const meta of manifest.versions) {
    let content: string;
    try {
      content = await readVersionContent(projectDir, id, meta.file);
    } catch {
      // 版本文件缺失（append-only 被外部破坏）：仍列出元信息，内容置空并标注
      content = `（版本文件 ${meta.file} 缺失）`;
    }
    versions.push({ ...meta, content });
  }
  return { manifest, versions };
}

/** 自动 id 撞名时追加 -2/-3…（与项目默认目录派生同一策略）。 */
async function resolveAutoId(projectDir: string, base: string): Promise<string> {
  for (let seq = 1; seq <= AUTO_ID_MAX_SEQ; seq++) {
    const candidate = seq === 1 ? base : `${base}-${seq}`;
    if (!(await readManifest(projectDir, candidate))) return candidate;
  }
  throw new Error('同名预设过多，请换一个名称');
}

export async function createPreset(
  projectDir: string,
  opts: CreatePresetOptions,
): Promise<PresetManifest> {
  const name = (opts.name ?? '').trim();
  if (!name) throw new Error('预设名称不能为空');
  const content = (opts.content ?? '').trim();
  if (!content) throw new Error('预设内容不能为空');

  const id = opts.id ? opts.id.trim() : '';
  if (opts.id) {
    validatePresetId(id);
    if (await readManifest(projectDir, id)) throw new Error(`预设 id 已存在：${id}`);
  }
  const finalId = id || (await resolveAutoId(projectDir, slugifyPresetName(name)));

  const dir = path.join(presetsRoot(projectDir), finalId);
  const now = new Date().toISOString();
  const manifest: PresetManifest = {
    id: finalId,
    name,
    stage: (opts.stage ?? '').trim(),
    description: (opts.description ?? '').trim(),
    current: 1,
    versions: [{ version: 1, note: opts.note?.trim() || '初始版本', createdAt: now, file: 'v1.md' }],
  };
  // 先写版本文件再写 manifest：listPresets 只认 manifest，避免半成品目录被列出
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'v1.md'), `${content}\n`, 'utf-8');
  await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest);
  return manifest;
}

export async function addVersion(
  projectDir: string,
  id: string,
  opts: AddVersionOptions,
): Promise<PresetVersionMeta> {
  const manifest = await readManifest(projectDir, id);
  if (!manifest) throw new Error(`预设不存在：${id}`);
  const content = (opts.content ?? '').trim();
  if (!content) throw new Error('版本内容不能为空');

  const next = manifest.versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
  const file = `v${next}.md`;
  const meta: PresetVersionMeta = {
    version: next,
    note: opts.note?.trim() || `第 ${next} 版`,
    createdAt: new Date().toISOString(),
    file,
  };
  // append-only：只新增 vN.md，旧版本文件不动
  await fs.writeFile(path.join(presetsRoot(projectDir), id, file), `${content}\n`, 'utf-8');
  const updated: PresetManifest = { ...manifest, current: next, versions: [...manifest.versions, meta] };
  await writeJsonAtomic(path.join(presetsRoot(projectDir), id, 'manifest.json'), updated);
  return meta;
}

export async function setCurrentVersion(
  projectDir: string,
  id: string,
  version: number,
): Promise<PresetManifest> {
  const manifest = await readManifest(projectDir, id);
  if (!manifest) throw new Error(`预设不存在：${id}`);
  if (!manifest.versions.some((v) => v.version === version)) {
    throw new Error(`版本不存在：v${version}（可用：${manifest.versions.map((v) => `v${v.version}`).join('、')}）`);
  }
  // 只改 current 指针；版本文件 append-only，不迁移不删除
  const updated: PresetManifest = { ...manifest, current: version };
  await writeJsonAtomic(path.join(presetsRoot(projectDir), id, 'manifest.json'), updated);
  return updated;
}

export async function renamePreset(projectDir: string, id: string, name: string): Promise<PresetManifest> {
  const manifest = await readManifest(projectDir, id);
  if (!manifest) throw new Error(`预设不存在：${id}`);
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('预设名称不能为空');
  const updated: PresetManifest = { ...manifest, name: trimmed };
  await writeJsonAtomic(path.join(presetsRoot(projectDir), id, 'manifest.json'), updated);
  return updated;
}

export async function deletePreset(projectDir: string, id: string): Promise<void> {
  const manifest = await readManifest(projectDir, id);
  if (!manifest) throw new Error(`预设不存在：${id}`);
  await fs.rm(path.join(presetsRoot(projectDir), id), { recursive: true, force: true });
  // 清理指向该预设的绑定，避免悬空引用（绑定表里该阶段回退为 null）
  const bindings = await getStageBindings(projectDir);
  let changed = false;
  for (const stage of Object.keys(bindings)) {
    if (bindings[stage] === id) {
      bindings[stage] = null;
      changed = true;
    }
  }
  if (changed) await writeJsonAtomic(bindingsFile(projectDir), bindings);
}

export async function getStageBindings(projectDir: string): Promise<StageBindings> {
  try {
    const raw = JSON.parse(await fs.readFile(bindingsFile(projectDir), 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as StageBindings;
  } catch {
    return {};
  }
}

export async function setStageBinding(
  projectDir: string,
  stage: string,
  presetId: string | null,
): Promise<StageBindings> {
  if (!STAGES.some((s) => s.id === stage)) {
    throw new Error(`未知阶段：${stage}（可用：${STAGES.map((s) => s.id).join('、')}）`);
  }
  if (presetId !== null) {
    if (!(await readManifest(projectDir, presetId))) throw new Error(`预设不存在：${presetId}`);
  }
  const bindings = await getStageBindings(projectDir);
  bindings[stage] = presetId;
  await writeJsonAtomic(bindingsFile(projectDir), bindings);
  return bindings;
}

/**
 * 取某阶段当前绑定预设的 current 版本内容。
 * 未绑定 / 绑定指向已删除预设 → null（不阻断调用方）；版本文件缺失则抛错（库损坏应显式暴露）。
 */
export async function resolveActivePresetPrompt(
  projectDir: string,
  stage: string,
): Promise<ActivePresetPrompt | null> {
  const bindings = await getStageBindings(projectDir);
  const presetId = bindings[stage];
  if (!presetId) return null;
  const manifest = await readManifest(projectDir, presetId);
  if (!manifest) return null;
  const meta = manifest.versions.find((v) => v.version === manifest.current);
  if (!meta) throw new Error(`预设 ${presetId} 的 current 版本号无效：v${manifest.current}`);
  const content = (await readVersionContent(projectDir, presetId, meta.file)).trim();
  return { presetId, name: manifest.name, version: meta.version, content };
}

/** SKILL.md 的 YAML frontmatter（开头 `---` … `---` 块）剥离；无 frontmatter 原样返回。 */
export function stripSkillFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/** 从 frontmatter 提取 `name:` 字段值（导入预设的缺省名）。 */
function frontmatterName(raw: string): string {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const nameLine = m[1].split(/\r?\n/).find((l) => /^name:\s*.+$/.test(l.trim()));
  return nameLine ? nameLine.replace(/^\s*name:\s*/, '').trim() : '';
}

export interface ImportSkillOptions {
  /** SKILL.md 绝对路径（只读一次，不写源文件）。 */
  skillPath: string;
  name?: string;
  stage?: string;
}

/**
 * 从任意绝对路径的 SKILL.md 导入为预设 v1：剥掉 YAML frontmatter，正文入库；
 * 同目录 open-novel.json 的 stages 仅作阶段佐证（未显式给 stage 时取交集第一个），不强制校验。
 */
export async function importFromSkillFile(
  projectDir: string,
  opts: ImportSkillOptions,
): Promise<PresetManifest> {
  const skillPath = (opts.skillPath ?? '').trim();
  // 仅允许绝对路径读一次：不接受相对路径（语义不明）也不做任何写入
  if (!path.isAbsolute(skillPath)) throw new Error('skillPath 必须是绝对路径');
  if (path.extname(skillPath).toLowerCase() !== '.md') throw new Error('skillPath 必须指向 .md 文件');

  let stat;
  try {
    stat = await fs.stat(skillPath);
  } catch {
    throw new Error(`文件不存在：${skillPath}`);
  }
  if (!stat.isFile()) throw new Error(`不是普通文件：${skillPath}`);

  const raw = await fs.readFile(skillPath, 'utf-8');
  const content = stripSkillFrontmatter(raw);
  if (!content) throw new Error('SKILL.md 正文为空');

  // 同目录 open-novel.json 的 stages 佐证：未显式指定 stage 时取与主阶段的交集第一个
  let stage = (opts.stage ?? '').trim();
  if (!stage) {
    try {
      const sibling = JSON.parse(
        await fs.readFile(path.join(path.dirname(skillPath), 'open-novel.json'), 'utf-8'),
      ) as { stages?: string[] };
      const valid = Array.isArray(sibling.stages)
        ? sibling.stages.find((s) => STAGES.some((t) => t.id === s))
        : undefined;
      if (valid) stage = valid;
    } catch {
      // 无 manifest 或解析失败：不强制，stage 留空
    }
  }

  const name = (opts.name ?? '').trim() || frontmatterName(raw) || path.basename(skillPath, '.md');
  return createPreset(projectDir, {
    name,
    stage,
    content,
    description: `导入自 ${skillPath}`,
    note: '导入 SKILL.md',
  });
}
