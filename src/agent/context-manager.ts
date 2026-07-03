import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 章节滚动摘要 + 状态追踪表管理。
 *
 * 解决写作阶段 agent 对前文"失忆"的问题：通过分层注入
 * （核心设定 / 状态 / 滚动摘要 / 活跃伏笔），让写第 N 章时
 * agent 仍能掌握前面章节的情节、人物口吻与伏笔。
 *
 * 所有小说文件都在项目目录的 `.novel/` 下。
 */

// ===== 常量 =====

const NOVEL_DIR = '.novel';
const CHAPTERS_DIR = 'chapters';
const STATE_FILE = 'state.json';
const PROFILES_FILE = path.join('characters', 'profiles.md');

/** 滚动摘要：最近若干章使用详摘，其余压缩为简摘。 */
const RECENT_CHAPTER_COUNT = 3;
/** 最近若干章附加正文首尾句，避免 agent 重复使用相同的开头/收尾。 */
const RECENT_FIRST_LAST_COUNT = 2;
/** 简摘每章压缩到的字数上限。 */
const BRIEF_SUMMARY_MAX_CHARS = 50;
/** 有效摘要的 CJK 最少字数；过短视为无效。 */
const MIN_SUMMARY_CJK = 30;
/** 检测正文复制时的连续匹配片段长度。 */
const COPY_FRAGMENT_LEN = 30;

/** 章节摘要文件名，例如 `.novel/chapters/第3章.summary.md`。 */
const SUMMARY_FILE_RE = /^第(\d+)章\.summary\.md$/;

// ===== 类型定义 =====

export interface CharacterState {
  name: string;
  location: string; // 当前位置
  emotion: string; // 当前情绪状态
  knows: string[]; // 已知的关键信息
  relationships: Record<string, string>; // 与其他角色的关系变化
  lastAppearance: number; // 最后出现的章节号
}

export interface NovelState {
  characters: CharacterState[];
  timeline: string; // 当前故事时间线描述
  activeForeshadows: number[]; // 活跃伏笔 ID 列表
  lastUpdatedChapter: number;
  updatedAt: string;
}

/** 空状态（state.json 不存在或损坏时的兜底值）。 */
const EMPTY_STATE: NovelState = {
  characters: [],
  timeline: '',
  activeForeshadows: [],
  lastUpdatedChapter: 0,
  updatedAt: '',
};

// ===== 内部辅助 =====

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false;
  return Object.values(v).every((val) => typeof val === 'string');
}

/** 校验并归一化单个角色状态，数据不合法时返回 null。 */
function normalizeCharacter(input: unknown): CharacterState | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  if (typeof c.name !== 'string') return null;
  return {
    name: c.name,
    location: typeof c.location === 'string' ? c.location : '',
    emotion: typeof c.emotion === 'string' ? c.emotion : '',
    knows: Array.isArray(c.knows)
      ? c.knows.filter((k): k is string => typeof k === 'string')
      : [],
    relationships: isStringRecord(c.relationships) ? c.relationships : {},
    lastAppearance: typeof c.lastAppearance === 'number' ? c.lastAppearance : 0,
  };
}

/** 校验并归一化整份状态数据，保证结构完整。 */
function normalizeState(input: Partial<NovelState> | null | undefined): NovelState {
  if (!input || typeof input !== 'object') return { ...EMPTY_STATE };
  const characters = Array.isArray(input.characters)
    ? (input.characters
        .map(normalizeCharacter)
        .filter((c): c is CharacterState => c !== null) as CharacterState[])
    : [];
  return {
    characters,
    timeline: typeof input.timeline === 'string' ? input.timeline : '',
    activeForeshadows: Array.isArray(input.activeForeshadows)
      ? input.activeForeshadows.filter((n) => typeof n === 'number')
      : [],
    lastUpdatedChapter:
      typeof input.lastUpdatedChapter === 'number' ? input.lastUpdatedChapter : 0,
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : '',
  };
}

/**
 * 将摘要压缩到指定字数（按字符截断，末尾补省略号）。
 * 这里无法调用 AI，故采用确定性截断作为压缩策略。
 */
function compressSummary(summary: string, maxChars: number): string {
  const text = summary.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

/** 读取 `.novel/` 下指定相对路径的文本文件，失败返回空串。 */
async function readNovelFile(projectDir: string, relativePath: string): Promise<string> {
  try {
    const full = path.join(projectDir, NOVEL_DIR, relativePath);
    return (await fs.readFile(full, 'utf-8')).trim();
  } catch {
    return '';
  }
}

/** 从角色档案（characters/profiles.md）解析角色名列表。 */
async function readCharacterNames(projectDir: string): Promise<string[]> {
  const raw = await readNovelFile(projectDir, PROFILES_FILE);
  if (!raw) return [];
  const names: string[] = [];
  // 匹配模板中的 `- 姓名：xxx` / `* 姓名: xxx` 字段
  const fieldRe = /^[-*]\s*姓名\s*[:：]\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(raw)) !== null) {
    const name = m[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// ===== 章节摘要 =====

/**
 * 计算章节摘要文件路径（`.novel/chapters/第N章.summary.md`）。
 * 同时确保 chapters 目录存在，使返回路径可立即写入。
 */
export async function generateChapterSummaryPath(
  projectDir: string,
  chapterNum: number,
): Promise<string> {
  const chaptersDir = path.join(projectDir, NOVEL_DIR, CHAPTERS_DIR);
  await fs.mkdir(chaptersDir, { recursive: true });
  return path.join(chaptersDir, `第${chapterNum}章.summary.md`);
}

/**
 * 读取所有已有章节摘要，按章节号升序返回。
 * 摘要文件名需匹配 `第N章.summary.md`。
 */
export async function getChapterSummaries(
  projectDir: string,
): Promise<Array<{ chapter: number; summary: string }>> {
  const chaptersDir = path.join(projectDir, NOVEL_DIR, CHAPTERS_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(chaptersDir);
  } catch {
    return []; // 目录不存在或无法读取
  }

  const summaries: Array<{ chapter: number; summary: string }> = [];
  for (const name of entries) {
    const match = name.match(SUMMARY_FILE_RE);
    if (!match) continue;
    const chapter = parseInt(match[1], 10);
    const content = await readNovelFile(projectDir, path.join(CHAPTERS_DIR, name));
    if (!content) continue; // 单个文件读取失败则跳过
    summaries.push({ chapter, summary: content });
  }
  summaries.sort((a, b) => a.chapter - b.chapter);
  return summaries;
}

/**
 * 校验章节摘要质量。
 *
 * 三重检测：
 * 1. 禁止 `[自动生成]` 标记 —— 那是 buildPlaceholderSummary 的截取产物，非语义摘要；
 * 2. CJK 字数 ≥ MIN_SUMMARY_CJK —— 过短摘要么信息量不足；
 * 3. 不与正文连续 COPY_FRAGMENT_LEN 字重复 —— 防止 agent 把正文开头当摘要。
 *
 * 无效摘要在 buildRollingSummaryContext 中被跳过，不注入下游上下文，
 * 避免废稿摘要把“正文开头”当摘要污染后续章节。
 */
function isSummaryValid(summary: string, body: string): boolean {
  // 1. 模板标记
  if (summary.includes('[自动生成]')) return false;

  // 2. 字数
  const cjkCount = [...summary].filter((c) => c >= '\u4e00' && c <= '\u9fff').length;
  if (cjkCount < MIN_SUMMARY_CJK) return false;

  // 3. 正文复制检测：正文中是否存在与摘要连续 COPY_FRAGMENT_LEN 字相同的片段
  if (body) {
    const bodyClean = body.replace(/\s+/g, ' ').trim();
    const summaryClean = summary.replace(/\s+/g, ' ').trim();
    for (let i = 0; i <= summaryClean.length - COPY_FRAGMENT_LEN; i++) {
      const fragment = summaryClean.slice(i, i + COPY_FRAGMENT_LEN);
      if (bodyClean.includes(fragment)) return false;
    }
  }

  return true;
}

/**
 * 从章节正文提取首句和尾句（按中文句号/问号/叹号分割）。
 * 用于最近章节上下文，让 agent 看到自己刚用过的开头/收尾，避免重复。
 */
function extractFirstLastSentence(body: string): { first: string; last: string } {
  const lines = body.split(/\r?\n/);
  // 跳过首行 Markdown 标题
  const startIndex = lines.length > 0 && /^\s{0,3}#{1,6}\s/.test(lines[0]) ? 1 : 0;
  const prose = lines.slice(startIndex).join('\n').replace(/\s+/g, ' ').trim();

  // 按中文句末标点分割
  const sentences = prose
    .split(/[。！？!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 5);

  return {
    first: sentences[0] ?? '',
    last: sentences.length > 1 ? sentences[sentences.length - 1] : '',
  };
}

/**
 * 构建分层注入文本：最近 3 章详摘 + 更早章节简摘（每章压缩到 50 字）。
 * 最近 2 章附加正文首尾句，避免 agent 重复使用相同的开头/收尾。
 * 无效摘要（模板残留 / 正文复制 / 过短）被跳过，不注入下游上下文。
 * 无任何有效摘要时返回空串。
 */
export async function buildRollingSummaryContext(projectDir: string): Promise<string> {
  const summaries = await getChapterSummaries(projectDir);
  if (summaries.length === 0) return '';

  // 读取每章正文，用于摘要校验 + 首尾句提取
  const withBodies = await Promise.all(
    summaries.map(async (s) => ({
      chapter: s.chapter,
      summary: s.summary,
      body: await readNovelFile(projectDir, path.join(CHAPTERS_DIR, `第${s.chapter}章.md`)),
    })),
  );

  // 校验摘要，过滤无效的（模板残留 / 正文复制 / 过短）
  const valid = withBodies.filter((s) => isSummaryValid(s.summary, s.body));

  const splitIdx = Math.max(0, valid.length - RECENT_CHAPTER_COUNT);
  const earlier = valid.slice(0, splitIdx);
  const recent = valid.slice(splitIdx);

  const lines: string[] = [];

  if (earlier.length > 0) {
    lines.push('#### 更早章节（简摘，每章 ≤50 字）');
    for (const s of earlier) {
      lines.push(`- 第${s.chapter}章：${compressSummary(s.summary, BRIEF_SUMMARY_MAX_CHARS)}`);
    }
  }

  if (recent.length > 0) {
    lines.push('#### 最近章节（详摘）');
    // 最近 RECENT_FIRST_LAST_COUNT 章附加首尾句
    const withEnds = new Set(
      recent.slice(-RECENT_FIRST_LAST_COUNT).map((s) => s.chapter),
    );
    for (const s of recent) {
      lines.push(`##### 第${s.chapter}章`);
      lines.push(s.summary);
      if (withEnds.has(s.chapter) && s.body) {
        const { first, last } = extractFirstLastSentence(s.body);
        if (first) lines.push(`> [首句] ${first}`);
        if (last) lines.push(`> [尾句] ${last}`);
      }
    }
  }

  return lines.join('\n');
}

// ===== 状态追踪表 =====

/**
 * 读取状态表（`.novel/state.json`）。文件不存在或损坏时返回空状态。
 */
export async function getStateTable(projectDir: string): Promise<NovelState> {
  const raw = await readNovelFile(projectDir, STATE_FILE);
  if (!raw) return { ...EMPTY_STATE };
  try {
    return normalizeState(JSON.parse(raw) as Partial<NovelState>);
  } catch {
    return { ...EMPTY_STATE }; // JSON 解析失败，兜底空状态
  }
}

/**
 * 更新状态表：浅合并 `updates` 到现有状态后写回 `.novel/state.json`。
 * 同时刷新 `updatedAt` 时间戳。
 */
export async function updateStateTable(
  projectDir: string,
  updates: Partial<NovelState>,
): Promise<void> {
  const current = await getStateTable(projectDir);
  const merged: NovelState = {
    ...current,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  const novelDir = path.join(projectDir, NOVEL_DIR);
  await fs.mkdir(novelDir, { recursive: true });
  await fs.writeFile(
    path.join(novelDir, STATE_FILE),
    JSON.stringify(merged, null, 2),
    'utf-8',
  );
}

/**
 * 初始化状态表：从角色档案读取角色名，生成各角色初始状态。
 * 若 state.json 已存在则不覆盖，避免丢失已有状态。
 */
export async function initStateTable(projectDir: string): Promise<void> {
  const statePath = path.join(projectDir, NOVEL_DIR, STATE_FILE);
  try {
    await fs.access(statePath);
    return; // 已存在，跳过初始化
  } catch {
    // 文件不存在，继续创建
  }

  const names = await readCharacterNames(projectDir);
  const state: NovelState = {
    characters: names.map((name) => ({
      name,
      location: '',
      emotion: '',
      knows: [],
      relationships: {},
      lastAppearance: 0,
    })),
    timeline: '',
    activeForeshadows: [],
    lastUpdatedChapter: 0,
    updatedAt: new Date().toISOString(),
  };

  const novelDir = path.join(projectDir, NOVEL_DIR);
  await fs.mkdir(novelDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ===== 兜底补全 =====

/** 占位摘要：从正文截取的字数上限。 */
const PLACEHOLDER_SUMMARY_MAX_CHARS = 200;
/** 章节正文文件名（英文命名）：chapter-N.md。 */
const CHAPTER_BODY_NUM_RE = /chapter-(\d+)\.md$/;
/** 章节正文文件名（中文命名）：第N章.md。 */
const CHAPTER_BODY_CN_RE = /第(\d+)章\.md$/;
/** 摘要文件后缀，用于在提取章节号时排除摘要文件。 */
const SUMMARY_MD_SUFFIX_RE = /\.summary\.md$/;

/** 将 writtenPath 解析为绝对路径（兼容相对路径与绝对路径）。 */
function resolveWrittenPath(projectDir: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(projectDir, p);
}

/**
 * 从章节正文生成占位摘要：去掉首行标题（Markdown 标题），
 * 截取前 maxChars 字，以 `[自动生成]` 开头标注，便于区分 agent 手写的语义摘要。
 */
function buildPlaceholderSummary(body: string, maxChars: number): string {
  const lines = body.split(/\r?\n/);
  const startIndex = lines.length > 0 && /^\s{0,3}#{1,6}\s/.test(lines[0]) ? 1 : 0;
  const content = lines
    .slice(startIndex)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated =
    content.length > maxChars ? content.slice(0, maxChars) + '…' : content;
  return `[自动生成] ${truncated}`;
}

/**
 * 兜底补全缺失的上下文产物。
 *
 * prompt 指令要求 agent 每写完一章后写章节摘要并更新 state.json，但 LLM 不保证遵守。
 * 本函数在 run 结束时补全漏写的产物，保证后续章节的滚动摘要上下文不至落空：
 * 1. 从 writtenPaths 提取本次写入的章节正文（排除摘要文件），得到章节号；
 * 2. 对每个缺失 `第N章.summary.md` 的章节，截取正文生成占位摘要；
 * 3. 若 state.json 不存在，初始化状态表。
 *
 * 关键约束：只补不覆盖——已存在的摘要永不重写。
 * 全程容错：任意 IO 失败均被吞掉，绝不影响 run 主流程。
 */
export async function ensureContextArtifacts(
  projectDir: string,
  writtenPaths: Set<string>,
): Promise<void> {
  // 1. 从 writtenPaths 提取章节正文 -> 章节号映射
  const chapterBodies = new Map<number, string>();
  for (const p of writtenPaths) {
    if (!p.endsWith('.md')) continue;
    if (SUMMARY_MD_SUFFIX_RE.test(p)) continue; // 跳过摘要文件
    const basename = path.basename(p);
    const match = basename.match(CHAPTER_BODY_NUM_RE) || basename.match(CHAPTER_BODY_CN_RE);
    if (!match) continue;
    chapterBodies.set(parseInt(match[1], 10), resolveWrittenPath(projectDir, p));
  }

  // 2. 为缺失摘要的章节生成占位摘要（只补不覆盖）
  for (const [num, bodyPath] of chapterBodies) {
    try {
      const summaryPath = await generateChapterSummaryPath(projectDir, num);
      try {
        await fs.access(summaryPath);
        continue; // 摘要已存在，跳过
      } catch {
        // 摘要不存在，继续生成
      }
      const body = await fs.readFile(bodyPath, 'utf-8');
      await fs.writeFile(
        summaryPath,
        buildPlaceholderSummary(body, PLACEHOLDER_SUMMARY_MAX_CHARS),
        'utf-8',
      );
    } catch {
      // 单章失败不影响其他章节与主流程
    }
  }

  // 3. state.json 校验：损坏时尝试修复，无法修复则初始化
  await repairOrInitState(projectDir).catch(() => {});

  // 4. P3: 清理异常文件（.degraded.md、过大正文移入 _discarded/）
  await cleanupAbnormalFiles(projectDir).catch(() => {});
}

/**
 * 转义 JSON 字符串值内的原始控制字符。
 * LLM 常将多行文本直接嵌入 JSON 字符串值中（含裸换行符/制表符），
 * 导致 JSON.parse 失败。本函数逐字符遍历，跟踪是否在字符串内部，
 * 将字符串值内的裸控制字符（U+0000–U+001F，排除已正确转义的）转为 \n / \t 等。
 */
function escapeRawControlChars(text: string): string {
  let result = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && inString) {
      // 反斜杠转义：连同下一个字符一并保留
      result += ch + (text[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && ch !== undefined) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        // 裸控制字符在字符串值内部 → 转义
        if (code === 0x0a) result += '\\n';
        else if (code === 0x0d) result += '\\r';
        else if (code === 0x09) result += '\\t';
        else result += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
    }
    result += ch ?? '';
  }
  return result;
}

/**
 * 校验 state.json：若 JSON 解析失败，尝试常见修复（键中冒号未转义、时间戳格式错误等）；
 * 修复后仍无法解析则用已有角色档案重新初始化。
 */
async function repairOrInitState(projectDir: string): Promise<void> {
  const statePath = path.join(projectDir, NOVEL_DIR, STATE_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(statePath, 'utf-8');
  } catch {
    await initStateTable(projectDir);
    return;
  }

  // JSON 有效则无需处理
  try {
    JSON.parse(raw);
    return;
  } catch {
    // 继续修复
  }

  let fixed = raw;
  // 修复1：键值对中键含冒号 —— "林冲:text" → "林冲": "text"
  // 约束：键不含引号/数字串（避免跨引号边界误匹配），值不含引号
  fixed = fixed.replace(
    /"([^"\n\d:]+?):([^"\n]+?)"(?=,|\s*\n|\s*})/g,
    '"$1": "$2"',
  );
  // 修复2：时间戳被拆成 key:value 对（两种变体）
  // "2026-07-03T00:00": "00Z" → "2026-07-03T00:00:00Z"
  fixed = fixed.replace(
    /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})"\s*:\s*"(\d{2}Z)"/g,
    '"$1:$2"',
  );
  // "2026-07-03T18": "00:00Z" → "2026-07-03T18:00:00Z"
  fixed = fixed.replace(
    /"(\d{4}-\d{2}-\d{2}T\d{2})"\s*:\s*"(\d{2}:\d{2}Z)"/g,
    '"$1:$2"',
  );
  // 修复3：JSON 字符串值内的原始控制字符（换行符、制表符等）未转义
  // LLM 常将多行文本直接嵌入 JSON 字符串值，导致解析失败。
  // 策略：逐字符遍历，在字符串值内部将裸控制字符转义。
  fixed = escapeRawControlChars(fixed);

  try {
    const parsed = JSON.parse(fixed);
    await fs.writeFile(statePath, JSON.stringify(parsed, null, 2), 'utf-8');
    return;
  } catch {
    // 修复失败，备份损坏文件后重新初始化
  }

  // 兜底：将损坏的 state.json 备份为 .corrupted.bak，再强制重新初始化。
  // initStateTable 本身“不覆盖已有文件”，所以需要先移走损坏文件。
  try {
    const bakPath = `${statePath}.corrupted.bak`;
    await fs.rename(statePath, bakPath);
  } catch {
    // 重命名也失败（权限/磁盘），尝试直接删除
    try { await fs.unlink(statePath); } catch {}
  }
  await initStateTable(projectDir);
}

/** 单章正文文件大小上限（30KB）。超过此值的视为异常输出。 */
const MAX_CHAPTER_FILE_SIZE = 30 * 1024;
/** 异常文件归档子目录名。 */
const DISCARDED_DIR = '_discarded';

/**
 * 清理异常文件：将 .degraded.md（质检门禁拒收的退化输出）
 * 和过大的正文文件移入 `chapters/_discarded/` 子目录。
 * 正常文件和摘要文件不受影响。
 */
async function cleanupAbnormalFiles(projectDir: string): Promise<void> {
  const chaptersDir = path.join(projectDir, NOVEL_DIR, CHAPTERS_DIR);
  let files: string[];
  try {
    files = await fs.readdir(chaptersDir);
  } catch {
    return;
  }

  const discardedDir = path.join(chaptersDir, DISCARDED_DIR);

  for (const file of files) {
    // .degraded.md 文件直接归档
    if (file.endsWith('.degraded.md')) {
      try {
        await fs.mkdir(discardedDir, { recursive: true });
        await fs.rename(path.join(chaptersDir, file), path.join(discardedDir, file));
      } catch {
        // 单文件失败不影响其他文件
      }
      continue;
    }

    // 过大的正文文件归档（排除摘要文件）
    if (file.endsWith('.md') && !file.endsWith('.summary.md')) {
      try {
        const stat = await fs.stat(path.join(chaptersDir, file));
        if (stat.size > MAX_CHAPTER_FILE_SIZE) {
          await fs.mkdir(discardedDir, { recursive: true });
          await fs.rename(
            path.join(chaptersDir, file),
            path.join(discardedDir, `${file}.oversized`),
          );
        }
      } catch {
        // 单文件失败不影响其他文件
      }
    }
  }
}
