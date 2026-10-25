/**
 * 审阅行内评论存储（P2：PR 式审阅，docs/改进计划-内置Pi-SDK.md §7）。
 *
 * 存储模型：.novel/review/comments.jsonl —— append-only 事件日志。
 * - 每行一条 JSON 记录；新增评论与 resolve/unresolve 都只「追加」新行，
 *   同 id 的记录读取时后写覆盖（最后一条即该评论当前状态），
 *   不改写旧行——保留完整操作历史，且每次变更天然是一次纯追加；
 * - 写入用 fs.appendFile（O_APPEND 单次 write）：POSIX 语义下单行追加是原子的，
 *   并发追加不会互相丢行。相比「整文件读改写 + 临时文件 rename」的原子写模式
 *   （prompt-presets.ts 的 writeJsonAtomic）更适合 append-only 日志：后者在
 *   read→rename 窗口内的并发写会整行丢失，而 O_APPEND 没有读-改-写窗口；
 * - 崩溃/磁盘满可能留下半行残迹：读取端容忍损坏行（JSON.parse 失败即跳过该行，
 *   只损失残迹行自身）；追加前检查文件尾是否缺换行并先补一个，
 *   保证新记录不会粘连在残迹行上而被迫陪葬；
 * - 评论是纯 .novel 元数据，不参与 git 双分支审阅门（main/draft 不变量不受影响）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 行内评论（file 为仓库相对路径，与 reviewDiff 返回的 files[].path 同一坐标系）。 */
export interface ReviewComment {
  id: string;
  file: string;
  /** 行号锚点：新增/上下文行取新文件行号，删除行取旧文件行号；省略 = 文件级评论。 */
  line?: number;
  body: string;
  author?: 'user';
  /** ISO 时间戳。 */
  createdAt: string;
  resolved: boolean;
  /** ISO 时间戳（仅 resolved=true 时存在）。 */
  resolvedAt?: string;
}

export interface AddReviewCommentInput {
  file: string;
  line?: number;
  body: string;
}

function commentsFile(projectDir: string): string {
  return path.join(projectDir, '.novel', 'review', 'comments.jsonl');
}

/** 短随机 id：8 个十六进制字符（单项目评论量级下碰撞概率可忽略）。 */
function newCommentId(): string {
  return randomBytes(4).toString('hex');
}

/** 追加一条记录。文件尾若无换行（崩溃残迹）先补一个，防新记录粘连到残迹行。 */
async function appendRecord(projectDir: string, record: ReviewComment): Promise<void> {
  const file = commentsFile(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let prefix = '';
  try {
    const stat = await fs.stat(file);
    if (stat.size > 0) {
      const fh = await fs.open(file, 'r');
      try {
        const tail = Buffer.alloc(1);
        await fh.read(tail, 0, 1, stat.size - 1);
        if (tail[0] !== 0x0a) prefix = '\n';
      } finally {
        await fh.close();
      }
    }
  } catch {
    /* 文件尚不存在：首行无需前缀 */
  }
  await fs.appendFile(file, `${prefix}${JSON.stringify(record)}\n`, 'utf-8');
}

/** 单行记录 → 领域对象；JSON 损坏或核心字段（id/file/body）类型不对返回 null（跳过）。 */
function parseCommentLine(raw: string): ReviewComment | null {
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof rec !== 'object' || rec === null) return null;
  const r = rec as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || typeof r.file !== 'string' || !r.file) return null;
  if (typeof r.body !== 'string') return null;
  const resolved = r.resolved === true;
  const line = typeof r.line === 'number' && Number.isInteger(r.line) && r.line >= 1 ? r.line : undefined;
  const resolvedAt = resolved && typeof r.resolvedAt === 'string' ? r.resolvedAt : undefined;
  const comment: ReviewComment = {
    id: r.id,
    file: r.file,
    body: r.body,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
    resolved,
    ...(line !== undefined ? { line } : {}),
    ...(r.author === 'user' ? { author: 'user' as const } : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  };
  return comment;
}

/** 读取全部评论（当前状态视图）：损坏行/空白行跳过；同 id 后写覆盖（保留首现次序）。 */
export async function listReviewComments(projectDir: string): Promise<ReviewComment[]> {
  let raw: string;
  try {
    raw = await fs.readFile(commentsFile(projectDir), 'utf-8');
  } catch {
    return []; // 文件不存在 = 无评论
  }
  const merged = new Map<string, ReviewComment>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const comment = parseCommentLine(trimmed);
    if (comment) merged.set(comment.id, comment);
  }
  return [...merged.values()];
}

/** 新增评论：追加一行新记录，返回完整评论对象。 */
export async function addReviewComment(
  projectDir: string,
  input: AddReviewCommentInput,
): Promise<ReviewComment> {
  const comment: ReviewComment = {
    id: newCommentId(),
    file: input.file,
    body: input.body,
    createdAt: new Date().toISOString(),
    resolved: false,
    ...(input.line !== undefined ? { line: input.line } : {}),
    author: 'user',
  };
  await appendRecord(projectDir, comment);
  return comment;
}

/**
 * 解决/取消解决评论：追加一条同 id 的覆盖记录（后写覆盖语义）。
 * 返回更新后的评论；id 不存在返回 null。
 */
export async function resolveReviewComment(
  projectDir: string,
  id: string,
  resolved: boolean,
): Promise<ReviewComment | null> {
  const current = (await listReviewComments(projectDir)).find((c) => c.id === id);
  if (!current) return null;
  // 覆盖行不保留旧的 resolvedAt：重开时由读取端按 resolved:false 视为无时间。
  const base = { ...current };
  delete base.resolvedAt;
  const updated: ReviewComment = resolved
    ? { ...base, resolved: true, resolvedAt: new Date().toISOString() }
    : { ...base, resolved: false };
  await appendRecord(projectDir, updated);
  return updated;
}

/** 按文件分组（纯函数）：组内按行号升序（无行号的靠后），同行号按创建时间升序。 */
export function commentsByFile(comments: ReviewComment[]): Record<string, ReviewComment[]> {
  const groups: Record<string, ReviewComment[]> = {};
  for (const c of comments) {
    if (!groups[c.file]) groups[c.file] = [];
    groups[c.file].push(c);
  }
  for (const file of Object.keys(groups)) {
    groups[file].sort((a, b) => {
      const la = a.line ?? Number.MAX_SAFE_INTEGER;
      const lb = b.line ?? Number.MAX_SAFE_INTEGER;
      if (la !== lb) return la - lb;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
  }
  return groups;
}
