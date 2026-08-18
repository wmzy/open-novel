/**
 * 大纲元数据：结构化存储三幕分界、每章视点角色与承诺等级（滚动式大纲）。
 * 供 diagram-builders 派生三幕节奏图与视点轮换图；
 * regenerateOutlineIndex 依据 outline/chapters/ 卡片自愈 outline/index.md。
 *
 * 注意：本模块被 web 端（OutlineView）静态引入，禁止顶层 import node 内置模块；
 * 磁盘操作通过函数内动态加载 node:fs/promises 完成。
 */

/** 承诺等级：committed（已定，写作依据）/ tentative（倾向，可被推翻）/ open（待决策）。 */
export type CommitmentLevel = 'committed' | 'tentative' | 'open';

export interface ChapterPov {
  chapter: number;
  pov: string;
  /** 承诺等级。旧文件缺省按 tentative（安全中间态）。 */
  commitment: CommitmentLevel;
  /** 待决策问题列表（open 级应携带）。旧文件缺省为空。 */
  openQuestions: string[];
}

export interface OutlineMeta {
  /** [第一幕结束章, 第二幕结束章]；第三幕从 actBreaks[1]+1 到末尾。 */
  actBreaks: [number, number];
  chapters: ChapterPov[];
}

/** 承诺等级 → 中文短标签（索引徽标 / UI 徽标共用）。 */
export const COMMITMENT_LABELS: Record<CommitmentLevel, string> = {
  committed: '已定',
  tentative: '倾向',
  open: '待决',
};

/** 章节卡片引用行元数据的解析结果。 */
export interface ChapterCardMeta {
  /** 卡片标题（去掉「第N章」前缀与「｜」后的幕/字数标注）；无标题行为 null。 */
  title: string | null;
  /** 承诺等级；未声明或非法值一律按 tentative（安全中间态）。 */
  commitment: CommitmentLevel;
  /** 待决策问题列表；未声明为空数组。 */
  openQuestions: string[];
}

/** 章节标题行：`#{1,6} 第N章：标题 ｜ 幕 ｜ 字数`。 */
const CHAPTER_HEADING_RE = /^#{1,6}\s*第\s*\d+\s*章?\s*[：:]?\s*(.*)$/;
/** 引用行承诺等级：`> commitment: committed`。 */
const COMMITMENT_LINE_RE = /^>\s*commitment\s*[：:]\s*(\S+)/i;
/** 引用行待决策问题头：`> open-questions:`（可带单行值）。 */
const OPEN_QUESTIONS_LINE_RE = /^>\s*open-questions\s*[：:]?\s*(.*)$/i;
/** 引用行待决策问题列表项：`>   - 问题`。 */
const OPEN_QUESTIONS_ITEM_RE = /^>\s*[-*+]\s+(.+)$/;

/** 从章节标题行提取纯标题：截掉「｜」后的幕/字数标注。 */
function cleanCardTitle(raw: string): string | null {
  const title = raw.split('｜')[0].replace(/^#{1,6}\s*/, '').trim();
  return title || null;
}

/**
 * 解析章节卡片（outline/chapters/第N章.md）的引用行元数据：
 * 标题、承诺等级（> commitment）、待决策问题（> open-questions 及其列表项）。
 * 元数据缺失或非法时 commitment='tentative'、openQuestions=[]（安全中间态）。
 */
export function parseChapterCard(content: string): ChapterCardMeta {
  const meta: ChapterCardMeta = { title: null, commitment: 'tentative', openQuestions: [] };
  if (!content) return meta;

  const lines = content.split(/\r?\n/);
  let inOpenQuestions = false;
  for (const line of lines) {
    const heading = line.match(CHAPTER_HEADING_RE);
    if (heading && meta.title === null) {
      meta.title = cleanCardTitle(heading[1]);
      continue;
    }
    const commitment = line.match(COMMITMENT_LINE_RE);
    if (commitment) {
      const v = commitment[1].toLowerCase();
      if (v === 'committed' || v === 'tentative' || v === 'open') {
        meta.commitment = v;
      }
      inOpenQuestions = false;
      continue;
    }
    const openQ = line.match(OPEN_QUESTIONS_LINE_RE);
    if (openQ) {
      // 单行形式：> open-questions: 问题一；问题二
      const inline = openQ[1].trim();
      if (inline) {
        for (const part of inline.split(/[；;]/)) {
          const q = part.trim();
          if (q) meta.openQuestions.push(q);
        }
        inOpenQuestions = false;
      } else {
        inOpenQuestions = true;
      }
      continue;
    }
    if (inOpenQuestions) {
      const item = line.match(OPEN_QUESTIONS_ITEM_RE);
      if (item) {
        const q = item[1].trim();
        if (q) meta.openQuestions.push(q);
        continue;
      }
      // 非列表项的引用行或普通行：结束问题列表收集
      inOpenQuestions = false;
    }
  }
  return meta;
}

/** 解析未知来源的 outline-meta.json，校验失败返回 null。旧文件缺承诺字段时补默认值。 */
export function parseOutlineMeta(raw: unknown): OutlineMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const ab = obj.actBreaks;
  if (!Array.isArray(ab) || ab.length < 2 || typeof ab[0] !== 'number' || typeof ab[1] !== 'number') {
    return null;
  }
  const ch = obj.chapters;
  if (!Array.isArray(ch)) return null;
  const chapters: ChapterPov[] = [];
  for (const c of ch) {
    if (c && typeof c === 'object') {
      const co = c as Record<string, unknown>;
      if (typeof co.chapter === 'number' && typeof co.pov === 'string') {
        chapters.push({
          chapter: co.chapter,
          pov: co.pov,
          commitment: normalizeCommitment(co.commitment),
          openQuestions: normalizeOpenQuestions(co.openQuestions),
        });
      }
    }
  }
  if (chapters.length === 0) return null;
  return { actBreaks: [ab[0], ab[1]], chapters };
}

/** 承诺等级归一化：非法/缺省值回退 tentative。 */
function normalizeCommitment(v: unknown): CommitmentLevel {
  return v === 'committed' || v === 'tentative' || v === 'open' ? v : 'tentative';
}

/** 待决策问题归一化：只保留字符串项。 */
function normalizeOpenQuestions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((q): q is string => typeof q === 'string' && q.trim() !== '');
}

/** 按章节数生成默认大纲元数据骨架（与 template-generator planActs 一致）。 */
export function defaultOutlineMeta(chapterCount: number): OutlineMeta {
  const n = Math.max(1, chapterCount);
  const act1End = Math.max(1, Math.round(n * 0.25));
  const act3Start = n - Math.max(1, Math.round(n * 0.25)) + 1;
  return {
    actBreaks: [act1End, Math.max(act1End + 1, act3Start - 1)],
    chapters: Array.from({ length: n }, (_, i) => ({
      chapter: i + 1,
      pov: '',
      commitment: 'tentative',
      openQuestions: [],
    })),
  };
}

/** 动态加载 node:fs/promises（避免 web 打包静态引入 node 内置模块）。 */
async function loadFs(): Promise<typeof import('node:fs/promises')> {
  const spec = 'node:fs/promises';
  return await import(/* @vite-ignore */ spec);
}

/** POSIX 路径拼接（novelDir 仅为服务端调用，运行于 POSIX 环境）。 */
function joinDir(a: string, b: string): string {
  return `${a.replace(/\/+$/, '')}/${b}`;
}

/** 章节区间字符串：`第 1–5 章`；起止相同则 `第 3 章`。 */
function chapterRange(from: number, to: number): string {
  if (from >= to) return `第 ${to} 章`;
  return `第 ${from}–${to} 章`;
}

/**
 * 扫描 outline/chapters/*.md 重建 outline/index.md（自愈）：
 * - 章号从文件名解析（`第N章.md`），绝不出现 `?` 占位；
 * - 每章行：章号｜标题｜承诺等级徽标｜文件名（标题/承诺等级从卡片内容解析，缺失给默认值）；
 * - 三幕表：优先取 outline-meta.json 的 actBreaks，缺失/损坏时按最大章号比例推断；
 * - 附粒度说明：远期章节为 arc/skeleton 级是有意设计，非未完成。
 * 无章节卡片时不覆盖现有 index（返回其原文，无则空串）。
 *
 * @param novelDir 项目 .novel 目录（index 位于 novelDir/outline/index.md）。
 * @returns 生成的 index.md 内容。
 */
export async function regenerateOutlineIndex(novelDir: string): Promise<string> {
  const fs = await loadFs();
  const outlineDir = joinDir(novelDir, 'outline');
  const indexPath = joinDir(outlineDir, 'index.md');
  const chaptersDir = joinDir(outlineDir, 'chapters');

  // 1. 扫描章节卡片，章号从文件名解析
  let files: string[];
  try {
    files = (await fs.readdir(chaptersDir)).filter((f) => f.endsWith('.md'));
  } catch {
    // chapters/ 不存在：不覆盖现有 index
    try {
      return await fs.readFile(indexPath, 'utf-8');
    } catch {
      return '';
    }
  }

  interface Row {
    chapter: number;
    title: string | null;
    commitment: CommitmentLevel;
    fileName: string;
  }
  const rows: Row[] = [];
  const seen = new Set<number>();
  for (const f of files.sort()) {
    const m = f.match(/第\s*(\d+)\s*章/);
    if (!m) continue;
    const chapter = Number.parseInt(m[1], 10);
    if (!Number.isFinite(chapter) || seen.has(chapter)) continue;
    seen.add(chapter);
    let title: string | null = null;
    let commitment: CommitmentLevel = 'tentative';
    try {
      const content = await fs.readFile(joinDir(chaptersDir, f), 'utf-8');
      const card = parseChapterCard(content);
      title = card.title;
      commitment = card.commitment;
    } catch {
      // 单个卡片读取失败：仍保留该章行，用默认值
    }
    rows.push({ chapter, title, commitment, fileName: f });
  }

  if (rows.length === 0) {
    try {
      return await fs.readFile(indexPath, 'utf-8');
    } catch {
      return '';
    }
  }
  rows.sort((a, b) => a.chapter - b.chapter);
  const maxChapter = rows[rows.length - 1].chapter;

  // 2. 三幕分界：优先 outline-meta.json，缺失/损坏时按比例推断并截断到实际章数
  let actBreaks: [number, number] | null = null;
  try {
    const metaRaw = await fs.readFile(joinDir(novelDir, 'outline-meta.json'), 'utf-8');
    actBreaks = parseOutlineMeta(JSON.parse(metaRaw))?.actBreaks ?? null;
  } catch { /* 缺失或损坏，按比例推断 */ }
  if (!actBreaks) actBreaks = defaultOutlineMeta(maxChapter).actBreaks;
  const act1End = Math.min(Math.max(actBreaks[0], 1), maxChapter);
  const act2End = Math.min(Math.max(actBreaks[1], act1End), maxChapter);

  // 3. 生成 index.md（三幕表行按实际章数截断，空幕省略）
  const actRows = [`| 第一幕·设置 | ${chapterRange(1, act1End)} |`];
  if (act2End > act1End) {
    actRows.push(`| 第二幕·对抗 | ${chapterRange(act1End + 1, act2End)} |`);
  }
  if (act2End < maxChapter) {
    actRows.push(`| 第三幕·解决 | ${chapterRange(act2End + 1, maxChapter)} |`);
  }
  const lines: string[] = [
    '# 详细大纲索引（自动生成）',
    '',
    '> 本索引由 outline/chapters/ 卡片自动重建；如与卡片不一致，以卡片为准。',
    '> 粒度说明：近章为 beat 级（已定）、本幕为 arc 级（倾向）、远期为骨架级（待决）。远期章节粒度粗是滚动大纲的设计意图（近细远粗），并非未完成；写作推进到该章前会先精化。',
    '',
    '## 三幕结构',
    '',
    '| 幕 | 章节范围 |',
    '|---|---|',
    ...actRows,
    '',
    '## 章节索引',
    '',
    '> 承诺等级：已定（committed，beat 级，写作依据）｜倾向（tentative，arc 级，可被正文推翻）｜待决（open，骨架级，待决策）',
    '',
    '| 章 | 标题 | 承诺等级 | 文件 |',
    '|---|---|---|---|',
  ];
  for (const row of rows) {
    const title = row.title ?? '（未命名）';
    lines.push(`| ${row.chapter} | ${title.replace(/\|/g, '\\|')} | ${COMMITMENT_LABELS[row.commitment]} | chapters/${row.fileName} |`);
  }

  const content = `${lines.join('\n')}\n`;
  await fs.mkdir(outlineDir, { recursive: true });
  // 变更检测 + 原子写：内容未变化时跳过写入，避免 GET /document/outline 的自愈调用
  // 反复触碰文件 mtime → 文件监听发 file-changed → 前端 invalidate → 再 GET 的死循环
  // （该循环会耗尽接口限流配额，导致视图间歇性空态）。写入走 tmp+rename，杜绝并发读
  // 观察到截断内容。
  let unchanged = false;
  try {
    unchanged = (await fs.readFile(indexPath, 'utf-8')) === content;
  } catch { /* 尚不存在，需要写入 */ }
  if (!unchanged) {
    const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, indexPath);
  }
  return content;
}
