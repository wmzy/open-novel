/**
 * 批量写作状态机（纯函数，可 JSON 序列化）。
 *
 * 批量写作不是「一个隐藏的后台任务」，而是把「写第 N 章」拆成一串真实的
 * run：前端逐章 POST /api/runs（走项目串行锁、样章门、DB 注册），每章结束
 * 后调用 /batch/advance 推进状态机。本模块只负责纯状态转换，持久化见
 * src/agent/batch.ts。
 *
 * 状态流转：
 *   running --(成功且未到末尾)--> running
 *   running --(最后一章成功)----> completed
 *   running --(失败)------------> failed（resumeChapter = 失败章，可从此重试）
 *   running --(pauseRequested 且当前章结束)--> paused
 *   paused  --(resume)----------> running（从 resumeChapter / currentChapter 继续）
 *   running/paused/failed --(cancel)--> canceled
 */

/** 单批最多章节数：一次批量写作最多 10 章，避免无人值守烧穿额度/上下文。 */
export const BATCH_MAX_CHAPTERS = 10;

export type BatchStatus = 'running' | 'paused' | 'failed' | 'completed' | 'canceled';

export interface BatchState {
  /** 批量 id（batch_xxx）。 */
  id: string;
  projectId: string;
  /** 起始章号（含）。 */
  from: number;
  /** 结束章号（含）。 */
  to: number;
  /** 当前章（正在写或下一章待写）。失败时等于 resumeChapter。 */
  currentChapter: number;
  status: BatchStatus;
  /** 暂停请求：当前章写完后停在下一章，不打断正在进行的工作。 */
  pauseRequested: boolean;
  /** 失败/取消后从这里继续；成功后清空。 */
  resumeChapter: number | null;
  /** 失败原因 / 备注（展示用）。 */
  reason: string | null;
  /** 最近一次关联的 runId（前端启动章节后回填，排查/展示用）。 */
  lastRunId: string | null;
  /** lastRunId 对应的章节号（服务端收尾推进用，避免前端已推进后误跳章）。 */
  lastRunChapter: number | null;
  /** 创建批量的 agent / skill（批量完成时用同一配置触发里程碑回顾）。 */
  agentId?: string | null;
  skillId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 批量章节范围。 */
export interface BatchRange {
  from: number;
  to: number;
}

/** 规范化章号：正整数才有效。 */
function positiveInt(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.trim()) : Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * 解析批量写作指令。
 *
 * 支持（整句匹配，避免把正文里的「第 3 到 12 章」误判为命令）：
 *   - 「写第3到12章」「请批量写第 3 至 12 章」「写第3章到第12章」
 *   - 「/batch 3-12」「/batch 第3到12章」
 *   - 「write chapters 3..12」「write chapters 3-12」
 *
 * 是否超过单批上限由调用方校验（返回范围本身）。
 */
export function parseBatchCommand(input: string): BatchRange | null {
  const text = input.trim();
  if (!text) return null;

  // /batch 前缀：允许 /batch 3-12、/batch 写第3到12章
  const prefixed = text.match(/^\/batch\s+(.+)$/i);
  const body = (prefixed ? prefixed[1] : text).trim();

  // 中文：写第N到M章 / 写第N章到第M章 / 批量写第N至M章
  const zh = body.match(
    /^(?:请|帮我)?\s*(?:批量)?\s*写\s*第?\s*(\d+)\s*章?\s*(?:到|至|~|～|—|–|-|\.\.)\s*第?\s*(\d+)\s*章[。.!！]?$/,
  );
  if (zh) {
    const from = positiveInt(zh[1]);
    const to = positiveInt(zh[2]);
    return from !== null && to !== null && to >= from ? { from, to } : null;
  }

  // /batch 后只给范围：3-12 / 3..12 / 3 到 12 / 第3到12章
  if (prefixed) {
    const range = body.match(
      // 结尾的「章」可省略：/batch 10-20 与 /batch 第3到12章 都接受。
      /^第?\s*(\d+)\s*章?\s*(?:到|至|~|～|—|–|-|\.\.)\s*第?\s*(\d+)\s*章?$/,
    );
    if (range) {
      const from = positiveInt(range[1]);
      const to = positiveInt(range[2]);
      return from !== null && to !== null && to >= from ? { from, to } : null;
    }
  }

  // 英文：write chapters 3..12
  const en = body.match(/^(?:write|batch)\s+chapters?\s+(\d+)\s*(?:to|through|\.\.|—|–|-)\s*(\d+)$/i);
  if (en) {
    const from = positiveInt(en[1]);
    const to = positiveInt(en[2]);
    return from !== null && to !== null && to >= from ? { from, to } : null;
  }

  return null;
}

/** 每一章的写作请求（真实 run 的 user message）。 */
export function batchChapterMessage(chapter: number): string {
  return `请写第${chapter}章正文。`;
}

/** 批量进度：currentChapter / 总章数 / 剩余章数（含失败待重试章）。 */
export function batchProgress(state: BatchState): {
  total: number;
  done: number;
  remaining: number;
} {
  const total = state.to - state.from + 1;
  if (state.status === 'completed') return { total, done: total, remaining: 0 };
  const done = Math.max(0, state.currentChapter - state.from);
  const remaining = Math.max(0, state.to - state.currentChapter + 1);
  return { total, done, remaining };
}

/** 状态是否仍在推进/可恢复（UI 显示批量横幅）。 */
export function isBatchActive(state: BatchState | null | undefined): boolean {
  return !!state && (state.status === 'running' || state.status === 'paused' || state.status === 'failed');
}

/** 新建批量状态（running，从 from 开始）。 */
export function startBatchState(args: {
  id: string;
  projectId: string;
  from: number;
  to: number;
  agentId?: string;
  skillId?: string;
  now?: string;
}): BatchState {
  const now = args.now ?? new Date().toISOString();
  return {
    id: args.id,
    projectId: args.projectId,
    from: args.from,
    to: args.to,
    currentChapter: args.from,
    status: 'running',
    pauseRequested: false,
    resumeChapter: null,
    reason: null,
    lastRunId: null,
    lastRunChapter: null,
    agentId: args.agentId ?? null,
    skillId: args.skillId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 一章结束后推进状态机。
 *
 * - `chapter` 必须等于 currentChapter，否则视为过期/重复回报（刷新后重放），
 *   原样返回——保证接口幂等，重复调用不会跳章。
 * - 成功且还有下一章：running（若已请求暂停则 paused，currentChapter 指向下一章）。
 * - 最后一章成功：completed。
 * - 失败：failed，resumeChapter=该章，不跳过失败章节。
 */
export function advanceBatchState(
  state: BatchState,
  args: { chapter: number; succeeded: boolean; reason?: string | null; now?: string },
): BatchState {
  if (state.status !== 'running') return state;
  if (args.chapter !== state.currentChapter) return state;

  const now = args.now ?? new Date().toISOString();

  if (!args.succeeded) {
    return {
      ...state,
      status: 'failed',
      pauseRequested: false,
      resumeChapter: args.chapter,
      reason: args.reason?.trim() || '章节写作失败',
      updatedAt: now,
    };
  }

  if (args.chapter >= state.to) {
    return {
      ...state,
      status: 'completed',
      currentChapter: state.to,
      pauseRequested: false,
      resumeChapter: null,
      reason: null,
      updatedAt: now,
    };
  }

  const next = args.chapter + 1;
  const paused = state.pauseRequested;
  return {
    ...state,
    status: paused ? 'paused' : 'running',
    currentChapter: next,
    pauseRequested: false,
    resumeChapter: paused ? next : null,
    reason: null,
    updatedAt: now,
  };
}

/**
 * 请求暂停。
 *
 * - 有 run 在途：只置 pauseRequested，当前章继续写完后由 advance 落到 paused。
 * - 当前无 run 在途（两章之间）：直接 paused。
 * - 非 running 状态：不变。
 */
export function pauseBatchState(
  state: BatchState,
  args: { runActive: boolean; now?: string },
): BatchState {
  if (state.status !== 'running') return state;
  const now = args.now ?? new Date().toISOString();
  if (args.runActive) {
    if (state.pauseRequested) return state;
    return { ...state, pauseRequested: true, updatedAt: now };
  }
  return {
    ...state,
    status: 'paused',
    pauseRequested: false,
    resumeChapter: state.currentChapter,
    updatedAt: now,
  };
}

/** 从暂停/失败恢复：回到失败章或当前章，清除暂停请求。 */
export function resumeBatchState(state: BatchState, now?: string): BatchState {
  if (state.status !== 'paused' && state.status !== 'failed') return state;
  return {
    ...state,
    status: 'running',
    currentChapter: state.resumeChapter ?? state.currentChapter,
    pauseRequested: false,
    resumeChapter: null,
    reason: null,
    updatedAt: now ?? new Date().toISOString(),
  };
}

/** 取消批量：终态，不再恢复。 */
export function cancelBatchState(state: BatchState, now?: string): BatchState {
  if (state.status === 'completed' || state.status === 'canceled') return state;
  return {
    ...state,
    status: 'canceled',
    pauseRequested: false,
    resumeChapter: null,
    updatedAt: now ?? new Date().toISOString(),
  };
}
