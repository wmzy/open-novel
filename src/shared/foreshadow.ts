/**
 * 伏笔债务系统（共享纯函数层）。
 *
 * 伏笔不再只是一份静态清单，而是一组带类型/权重/期限/依赖的「叙事债务」：
 * - 每条伏笔有严格章号（plantedIn）与最晚回收章号（resolveDeadline）；
 * - 未回收的伏笔按权重累计债务分（major=2 / light=1），逾期与孤儿章号实时报警；
 * - 密度预算约束新埋节奏（默认「每 3 章新埋不超过 2 条」），防止伏笔堆叠。
 *
 * 本文件不依赖任何 Node API，便于在服务端、前端与测试中直接复用。
 * 数据只存文件层 .novel/foreshadow.json，不进 DB。
 */

// ── 类型定义 ──

/** 伏笔类型：契诃夫之枪（具体道具/细节）/ 身份之谜 / 情感线 / 世界观揭示。 */
export type ForeshadowType = 'chekhov' | 'identity' | 'emotional' | 'world';

/** 伏笔状态：待埋 → 已埋 → 已收；主动放弃的进入 dropped（不再计入债务）。 */
export type ForeshadowStatus = 'pending' | 'planted' | 'resolved' | 'dropped';

/** 伏笔权重：轻量（债务 1 分）/ 重磅（债务 2 分）。 */
export type ForeshadowWeight = 'light' | 'major';

export interface Foreshadow {
  id: number;
  content: string;
  type: ForeshadowType;            // 缺省 'chekhov'
  status: ForeshadowStatus;
  plantedIn: number | null;        // 严格章号；不再允许自由文本
  resolveDeadline: number | null;  // 最晚回收章号
  resolvedIn: number | null;
  dependsOn: number[];             // 前置伏笔 id 列表
  weight: ForeshadowWeight;        // 缺省 'light'
  rawPlantedIn?: string | null;    // 迁移时保留的原始自由文本
}

// ── 常量与文案 ──

export const FORESHADOW_TYPES: readonly ForeshadowType[] = ['chekhov', 'identity', 'emotional', 'world'];
export const FORESHADOW_STATUSES: readonly ForeshadowStatus[] = ['pending', 'planted', 'resolved', 'dropped'];
export const FORESHADOW_WEIGHTS: readonly ForeshadowWeight[] = ['light', 'major'];

/** 类型 → 中文标签（用于注入层与 UI 徽章）。 */
export const FORESHADOW_TYPE_LABELS: Record<ForeshadowType, string> = {
  chekhov: '契诃夫之枪',
  identity: '身份之谜',
  emotional: '情感线',
  world: '世界观',
};

/** 权重 → 中文标签。 */
export const FORESHADOW_WEIGHT_LABELS: Record<ForeshadowWeight, string> = {
  light: '轻量',
  major: '重磅',
};

/** 债务分权重：重磅伏笔占双倍预算。 */
export const FORESHADOW_WEIGHT_SCORE: Record<ForeshadowWeight, number> = {
  light: 1,
  major: 2,
};

/** 「即将到期」窗口：期限落在 (currentChapter, currentChapter+10] 视为临近。 */
export const DUE_SOON_WINDOW = 10;

/** 密度预算默认规则：每 3 章新埋不超过 2 条。 */
export const DENSITY_WINDOW = 3;
export const DENSITY_MAX_PER_WINDOW = 2;

// ── 解析与迁移 ──

/**
 * 从任意值提取章号：数字直接采用；字符串取首个连续数字（"第64-66章"→64）。
 * 提取失败返回 null。
 */
export function extractChapterNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const m = value.match(/\d+/);
    if (m) {
      const n = parseInt(m[0], 10);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/** 章号字段解析：null/undefined → null；可提取 → 章号；否则 null（调用方决定是否保留原文）。 */
function parseChapterField(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return extractChapterNumber(value);
}

/** 旧格式探测：条目缺失新 schema 任一字段，或章号字段是自由文本。 */
function isLegacyEntry(entry: Record<string, unknown>): boolean {
  const newKeys: Array<keyof Foreshadow> = ['type', 'resolveDeadline', 'dependsOn', 'weight'];
  if (newKeys.some((k) => !(k in entry))) return true;
  if ('plantedIn' in entry && typeof entry.plantedIn === 'string') return true;
  return false;
}

/**
 * 宽容解析 foreshadow.json 文本并完成旧格式迁移：
 * - plantedIn 为字符串时提取首个数字（"第64-66章"→64）；提取失败 → null 并把原文存入 rawPlantedIn；
 * - 未知 status 丢弃并记 warning；content 缺失的条目同样丢弃；
 * - 字段缺失给默认值（type='chekhov'，weight='light'，dependsOn=[]）；
 * - 任一条目命中旧格式时 migrated=true，供路由层提示「已自动迁移」。
 * 永不抛错：JSON 损坏返回空清单 + warning。
 */
export function parseForeshadowFile(text: string): {
  foreshadows: Foreshadow[];
  migrated: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (!text || !text.trim()) {
    return { foreshadows: [], migrated: false, warnings: ['伏笔文件为空，已按空清单处理'] };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { foreshadows: [], migrated: false, warnings: ['伏笔文件不是合法 JSON，已按空清单处理'] };
  }
  if (!data || typeof data !== 'object' || !Array.isArray((data as { foreshadows?: unknown }).foreshadows)) {
    return { foreshadows: [], migrated: false, warnings: ['伏笔文件缺少顶层 foreshadows 数组，已按空清单处理'] };
  }

  const rawList = (data as { foreshadows: unknown[] }).foreshadows;
  const validStatus = new Set<string>(FORESHADOW_STATUSES);
  const validType = new Set<string>(FORESHADOW_TYPES);
  const validWeight = new Set<string>(FORESHADOW_WEIGHTS);
  const foreshadows: Foreshadow[] = [];
  let migrated = false;

  rawList.forEach((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      warnings.push(`第 ${idx + 1} 条伏笔不是对象，已跳过`);
      return;
    }
    const entry = raw as Record<string, unknown>;

    if (typeof entry.content !== 'string' || entry.content.trim() === '') {
      warnings.push(`第 ${idx + 1} 条伏笔缺少 content，已跳过`);
      return;
    }
    if (typeof entry.status !== 'string' || !validStatus.has(entry.status)) {
      warnings.push(`第 ${idx + 1} 条伏笔 status 非法（${JSON.stringify(entry.status) ?? 'undefined'}），已丢弃`);
      return;
    }

    const isLegacy = isLegacyEntry(entry);
    if (isLegacy) migrated = true;

    // id：数字直接采用；字符串提取数字；缺失回退为序号。
    let id: number;
    if (typeof entry.id === 'number' && Number.isFinite(entry.id)) {
      id = entry.id;
    } else {
      const extracted = extractChapterNumber(entry.id);
      id = extracted ?? idx + 1;
    }

    // plantedIn：旧格式自由文本 → 提取章号；失败保留原文于 rawPlantedIn。
    let rawPlantedIn: string | null = null;
    let plantedIn: number | null;
    if (typeof entry.plantedIn === 'string') {
      plantedIn = extractChapterNumber(entry.plantedIn);
      if (plantedIn === null) rawPlantedIn = entry.plantedIn;
    } else {
      plantedIn = parseChapterField(entry.plantedIn);
      // 已迁移文件会把原文存在 rawPlantedIn 字段——再次解析时原样保留，避免往返丢失
      if (typeof entry.rawPlantedIn === 'string') rawPlantedIn = entry.rawPlantedIn;
    }

    const type = typeof entry.type === 'string' && validType.has(entry.type)
      ? entry.type as ForeshadowType
      : 'chekhov';
    const weight = typeof entry.weight === 'string' && validWeight.has(entry.weight)
      ? entry.weight as ForeshadowWeight
      : 'light';
    const dependsOn = Array.isArray(entry.dependsOn)
      ? entry.dependsOn
          .map((d) => extractChapterNumber(d))
          .filter((d): d is number => d !== null)
      : [];

    foreshadows.push({
      id,
      content: entry.content,
      type,
      status: entry.status as ForeshadowStatus,
      plantedIn,
      resolveDeadline: parseChapterField(entry.resolveDeadline),
      resolvedIn: parseChapterField(entry.resolvedIn),
      dependsOn,
      weight,
      ...(rawPlantedIn !== null ? { rawPlantedIn } : {}),
    });
  });

  return { foreshadows, migrated, warnings };
}

/** 序列化伏笔清单为 foreshadow.json 文本（保留 rawPlantedIn 等迁移痕迹，不丢数据）。 */
export function serializeForeshadows(list: Foreshadow[]): string {
  return JSON.stringify({ foreshadows: list }, null, 2);
}

// ── 统计（债务视角） ──

/** 未结清的债务状态：pending（未埋）与 planted（已埋未收）。dropped 视为主动核销，resolved 视为已清偿。 */
export function isUnsettled(f: Foreshadow): boolean {
  return f.status === 'pending' || f.status === 'planted';
}

export interface ForeshadowDensityPoint {
  chapter: number;
  planted: number;
  resolved: number;
}

export interface ForeshadowStats {
  total: number;
  byStatus: Record<ForeshadowStatus, number>;
  /** 逾期未收：期限已过（resolveDeadline < currentChapter）且仍未结清。 */
  overdue: Foreshadow[];
  /** 即将到期：期限落在 (currentChapter, currentChapter+10] 且未结清。 */
  dueSoon: Foreshadow[];
  /** 孤儿章号：plantedIn 超出全书章数（chapterCount<=0 视为未知，不判定）。 */
  orphaned: Foreshadow[];
  /** 逐章密度：每章实际新埋/回收条数。 */
  density: ForeshadowDensityPoint[];
  /** 债务分：Σ 未结清条目权重（major=2 / light=1）。 */
  debtScore: number;
}

/** 该章「实际新埋」条数：已埋或已收（planted/resolved）且 plantedIn === chapter。dropped 不计。 */
function plantedCountAt(list: Foreshadow[], chapter: number): number {
  return list.filter(
    (f) => f.plantedIn === chapter && (f.status === 'planted' || f.status === 'resolved'),
  ).length;
}

/** 该章「实际回收」条数：status === resolved 且 resolvedIn === chapter。 */
function resolvedCountAt(list: Foreshadow[], chapter: number): number {
  return list.filter((f) => f.status === 'resolved' && f.resolvedIn === chapter).length;
}

/**
 * 计算伏笔债务统计。
 * 密度横轴：优先 1..chapterCount；chapterCount 未知（<=0）时退化为数据中出现的最大章号。
 */
export function computeForeshadowStats(
  list: Foreshadow[],
  currentChapter: number,
  chapterCount: number,
): ForeshadowStats {
  const byStatus: Record<ForeshadowStatus, number> = { pending: 0, planted: 0, resolved: 0, dropped: 0 };
  let debtScore = 0;
  for (const f of list) {
    if (byStatus[f.status] !== undefined) byStatus[f.status] += 1;
    if (isUnsettled(f)) debtScore += FORESHADOW_WEIGHT_SCORE[f.weight] ?? 1;
  }

  const overdue = list.filter(
    (f) => isUnsettled(f) && f.resolveDeadline !== null && f.resolveDeadline < currentChapter,
  );
  const dueSoon = list.filter(
    (f) => isUnsettled(f)
      && f.resolveDeadline !== null
      && f.resolveDeadline > currentChapter
      && f.resolveDeadline <= currentChapter + DUE_SOON_WINDOW,
  );
  const orphaned = list.filter(
    (f) => chapterCount > 0 && f.plantedIn !== null && f.plantedIn > chapterCount,
  );

  const maxDataChapter = list.reduce(
    (m, f) => Math.max(m, f.plantedIn ?? 0, f.resolvedIn ?? 0, f.resolveDeadline ?? 0),
    0,
  );
  const span = chapterCount > 0 ? chapterCount : maxDataChapter;
  const density: ForeshadowDensityPoint[] = [];
  for (let c = 1; c <= span; c++) {
    density.push({ chapter: c, planted: plantedCountAt(list, c), resolved: resolvedCountAt(list, c) });
  }

  return { total: list.length, byStatus, overdue, dueSoon, orphaned, density, debtScore };
}

// ── 密度预算 ──

export interface DensityBudget {
  /** 预算窗口（章）。 */
  windowSize: number;
  /** 窗口内新埋上限。 */
  limit: number;
  /** 窗口起始章（含）。 */
  windowStart: number;
  /** 窗口内已实际新埋条数。 */
  plantedInWindow: number;
  /** 本章还可新埋条数（0 = 已达/超预算）。 */
  canPlantNow: number;
  /** 是否已超支。 */
  overBudget: boolean;
  /** 本章（含已逾期）到期应回收条数。 */
  dueForResolve: number;
}

/**
 * 密度预算：默认规则「每 3 章新埋不超过 2 条」。
 * 窗口取 [currentChapter-2, currentChapter]，统计实际新埋量（planted/resolved 的 plantedIn 落入窗口）；
 * 可新埋 = max(0, limit - plantedInWindow)。到期应回收 = 未结清且期限 ≤ 当前章的条数。
 */
export function computeDensityBudget(
  list: Foreshadow[],
  currentChapter: number,
  opts: { windowSize?: number; limit?: number } = {},
): DensityBudget {
  const windowSize = Math.max(1, opts.windowSize ?? DENSITY_WINDOW);
  const limit = Math.max(0, opts.limit ?? DENSITY_MAX_PER_WINDOW);
  const windowStart = Math.max(1, currentChapter - windowSize + 1);
  let plantedInWindow = 0;
  for (let c = windowStart; c <= currentChapter; c++) {
    plantedInWindow += plantedCountAt(list, c);
  }
  const dueForResolve = list.filter(
    (f) => isUnsettled(f) && f.resolveDeadline !== null && f.resolveDeadline <= currentChapter,
  ).length;
  return {
    windowSize,
    limit,
    windowStart,
    plantedInWindow,
    canPlantNow: Math.max(0, limit - plantedInWindow),
    overBudget: plantedInWindow > limit,
    dueForResolve,
  };
}

// ── 章号推断 ──

/**
 * 推断当前章号：max(state.json lastUpdatedChapter, 全部 plantedIn, 0)。
 * state 落后于大纲规划时以规划的最大埋设章为准。
 */
export function resolveCurrentChapter(foreshadows: Foreshadow[], lastUpdatedChapter: number): number {
  const maxPlanted = foreshadows.reduce((m, f) => Math.max(m, f.plantedIn ?? 0), 0);
  return Math.max(0, lastUpdatedChapter || 0, maxPlanted);
}
