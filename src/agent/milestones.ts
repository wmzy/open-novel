/**
 * 自动里程碑：每 K 章有效正文 / 卷末创建带标签快照，并按需触发回顾 run。
 *
 * 设计约束：
 * - 快照走 createMilestoneSnapshotSafe（inflightGitOps 互斥 + 确保 draft 分支），
 *   保持 main 是 draft 祖先的双分支不变量；
 * - 幂等键落盘 .novel/milestones.json（boundary -> 记录），重启后不会重复创建；
 * - 回顾生成是「正常 run」（POST /api/runs，stage=retro，写入 runs 表），
 *   不排队隐藏后台任务；若评估时仍有活跃 run，则跳过并记录 note，等下一次
 *   run 结束的评估再尝试；
 * - 有活跃 run 时整个评估直接返回（避免快照捕获半成品文件），由下一轮触发。
 *
 * 「已定稿章节」口径 = 磁盘上 CJK 字数 ≥ 100 的有效正文（与样章门一致）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { parseChapterNumber } from '../shared/chapter-names';
import { readMilestoneEvery } from '../shared/novel-config';
import { buildMilestoneRetrospectivePrompt } from '../shared/retrospective';
import { createMilestoneSnapshotSafe } from './snapshot';
import { getActiveRunForProject } from './run';
import { readBatchState } from './batch';

const MILESTONE_FILE = 'milestones.json';
const MILESTONE_MIN_CJK = 100;

export interface VolumeSpec {
  name?: string;
  startChapter?: number;
  endChapter: number;
}

export interface MilestoneRecord {
  /** 'chapter:<N>' 或 'volume:<卷末章>'。 */
  key: string;
  kind: 'chapter' | 'volume';
  /** 边界章号（K 的倍数或卷末章）。 */
  chapter: number;
  /** git 标签后缀：milestone-<label>。 */
  label: string;
  volumeName?: string;
  hash: string;
  createdAt: string;
  /** 触发的回顾 runId（未触发为 null）。 */
  retroRunId: string | null;
  /** 回顾跳过/失败原因（如 run-active / no-agent / http-409）。 */
  retroNote: string | null;
}

export interface MilestoneLedger {
  version: 1;
  boundaries: Record<string, MilestoneRecord>;
  updatedAt: string | null;
}

export interface MilestoneEvaluation {
  /** 本次使用的章间隔（0 = 关闭按章里程碑；卷末仍生效）。 */
  every: number;
  finalizedChapters: number;
  /** 本次新建的里程碑。 */
  created: MilestoneRecord[];
  /** 因 git 互斥/快照失败而跳过、需要下次重试的 boundary key。 */
  skipped: string[];
  notes: string[];
  /** 有活跃 run 时整体推迟（未写盘、未创建快照）。 */
  deferred: boolean;
  retro: { started: boolean; runId?: string; note?: string } | null;
}

export interface MilestoneOptions {
  /** 覆盖项目配置（测试/脚本用）。 */
  milestoneEvery?: number;
  /** 触发回顾 run 时使用的 agent / skill。 */
  agentId?: string;
  skillId?: string;
  /** false = 只创建快照，不触发回顾 run（单元测试）。 */
  triggerRetro?: boolean;
}

function milestoneFilePath(projectDir: string): string {
  return path.join(projectDir, '.novel', MILESTONE_FILE);
}

function emptyLedger(): MilestoneLedger {
  return { version: 1, boundaries: {}, updatedAt: null };
}

/** 读取里程碑账本（缺失/损坏返回空账本）。 */
export async function readMilestoneLedger(projectDir: string): Promise<MilestoneLedger> {
  try {
    const raw = await fs.readFile(milestoneFilePath(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyLedger();
    const boundariesRaw = (parsed as { boundaries?: unknown }).boundaries;
    const boundaries: Record<string, MilestoneRecord> = {};
    if (boundariesRaw && typeof boundariesRaw === 'object' && !Array.isArray(boundariesRaw)) {
      for (const [key, value] of Object.entries(boundariesRaw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') continue;
        const v = value as Partial<MilestoneRecord>;
        if (typeof v.hash !== 'string' || !Number.isInteger(v.chapter)) continue;
        boundaries[key] = {
          key,
          kind: v.kind === 'volume' ? 'volume' : 'chapter',
          chapter: v.chapter as number,
          label: typeof v.label === 'string' ? v.label : key,
          volumeName: typeof v.volumeName === 'string' ? v.volumeName : undefined,
          hash: v.hash,
          createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
          retroRunId: typeof v.retroRunId === 'string' ? v.retroRunId : null,
          retroNote: typeof v.retroNote === 'string' ? v.retroNote : null,
        };
      }
    }
    return {
      version: 1,
      boundaries,
      updatedAt: typeof (parsed as { updatedAt?: unknown }).updatedAt === 'string'
        ? (parsed as { updatedAt: string }).updatedAt
        : null,
    };
  } catch {
    return emptyLedger();
  }
}

/** 原子写入里程碑账本。 */
export async function writeMilestoneLedger(
  projectDir: string,
  ledger: MilestoneLedger,
): Promise<void> {
  const file = milestoneFilePath(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/** 列出磁盘上有效正文（CJK ≥ 100）的章节号；同名章号只计一次。 */
export async function listFinalizedChapterNumbers(projectDir: string): Promise<Set<number>> {
  const dir = path.join(projectDir, '.novel', 'chapters');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return new Set();
  }
  const numbers = new Set<number>();
  for (const name of files) {
    const num = parseChapterNumber(name);
    if (num === null) continue;
    try {
      const content = await fs.readFile(path.join(dir, name), 'utf-8');
      const stripped = content.replace(/^[#*>\-[\]()!|]+\s*/gm, '').trim();
      const cjk = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
      if (cjk >= MILESTONE_MIN_CJK) numbers.add(num);
    } catch {
      /* 单文件不可读则跳过 */
    }
  }
  return numbers;
}

/** 解析卷配置：支持数组或 { volumes: [...] }；字段兼容 endChapter/to/end。 */
export function normalizeVolumes(raw: unknown): VolumeSpec[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { volumes?: unknown[] }).volumes)
      ? (raw as { volumes: unknown[] }).volumes
      : [];
  const result: VolumeSpec[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const end = Number(obj.endChapter ?? obj.to ?? obj.end);
    if (!Number.isInteger(end) || end < 1) continue;
    const start = Number(obj.startChapter ?? obj.from ?? obj.start);
    const rawName = obj.name;
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined;
    result.push({
      name,
      startChapter: Number.isInteger(start) && start >= 1 ? start : undefined,
      endChapter: end,
    });
  }
  // 同一卷末章去重，按卷末章升序
  const byEnd = new Map<number, VolumeSpec>();
  for (const v of result) if (!byEnd.has(v.endChapter)) byEnd.set(v.endChapter, v);
  return [...byEnd.values()].sort((a, b) => a.endChapter - b.endChapter);
}

/** 读取卷配置：优先 .novel/volumes.json，回退 outline-meta.json 的 volumes 字段。 */
export async function readVolumes(projectDir: string): Promise<VolumeSpec[]> {
  for (const file of ['volumes.json', 'outline-meta.json']) {
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(projectDir, '.novel', file), 'utf-8'),
      ) as unknown;
      const volumes = normalizeVolumes(raw);
      if (volumes.length > 0) return volumes;
    } catch {
      /* 尝试下一个来源 */
    }
  }
  return [];
}

// 同项目评估串行化：并发触发（多个 run 同时收尾）时避免重复快照/重复回顾。
const queues = new Map<string, Promise<unknown>>();

function withEvalLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(projectDir) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(projectDir, run.then(() => undefined, () => undefined));
  return run;
}

/** 回顾未触发/可重试的 note（有活跃 run、批量在途、服务不可达、5xx）。 */
function isRetryableRetroNote(note: string | null): boolean {
  if (!note) return true;
  return note === 'skipped:run-active'
    || note === 'skipped:batch-active'
    || note.startsWith('skipped:unreachable')
    || note.startsWith('skipped:http-5')
    // 预检查后另一个 run 抢先拿到锁：下一次评估重试
    || note.startsWith('skipped:http-409');
}

/** 最近一个尚未成功触发回顾、且原因可重试的边界。 */
function latestRetryableRetroBoundary(ledger: MilestoneLedger): MilestoneRecord | null {
  const candidates = Object.values(ledger.boundaries)
    .filter((r) => !r.retroRunId && isRetryableRetroNote(r.retroNote))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.chapter - a.chapter);
  return candidates[0] ?? null;
}

function hostForInternalFetch(): string {
  const host = config.host;
  if (host === '0.0.0.0' || host === '::' || host === '[::]' || host === 'localhost') {
    return '127.0.0.1';
  }
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * 触发一次回顾生成 run（正常 POST /api/runs）。失败只记录 note，不抛错。
 */
async function triggerRetrospective(
  projectId: string,
  agentId: string | undefined,
  skillId: string | undefined,
  message: string,
  signalBoundary: string,
): Promise<{ started: boolean; runId?: string; note?: string }> {
  if (!agentId) return { started: false, note: 'skipped:no-agent' };

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.auth.token) headers.Authorization = `Bearer ${config.auth.token}`;
    const res = await fetch(`http://${hostForInternalFetch()}:${config.port}/api/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        projectId,
        agentId,
        skillId,
        stage: 'retro',
        message,
        autonomous: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        started: false,
        note: `skipped:http-${res.status}${detail ? `:${detail.slice(0, 160)}` : ''}`,
      };
    }
    const data = (await res.json().catch(() => ({}))) as { runId?: string };
    return { started: true, runId: data.runId, note: `started:${signalBoundary}` };
  } catch (err) {
    return {
      started: false,
      note: `skipped:unreachable:${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 评估并创建遗漏的里程碑（幂等）。
 *
 * 有活跃 run 时整体推迟：此时正文可能正在被写，快照会捕获半成品；
 * 下一次 run 结束会再次调用。返回 deferred=true，不写任何文件。
 */
export async function evaluateMilestones(
  projectDir: string,
  projectId: string,
  opts: MilestoneOptions = {},
): Promise<MilestoneEvaluation> {
  return withEvalLock(projectDir, async () => {
    const every = opts.milestoneEvery ?? await readMilestoneEvery(projectDir);
    const result: MilestoneEvaluation = {
      every,
      finalizedChapters: 0,
      created: [],
      skipped: [],
      notes: [],
      deferred: false,
      retro: null,
    };

    if (getActiveRunForProject(projectId)) {
      result.deferred = true;
      result.notes.push('项目有活跃 run，里程碑评估推迟到下一次 run 结束');
      // 已有待回顾边界时把「跳过」落盘，避免重启后丢失跳过原因。
      const deferredLedger = await readMilestoneLedger(projectDir);
      const pendingRetro = latestRetryableRetroBoundary(deferredLedger);
      if (pendingRetro) {
        pendingRetro.retroNote = 'skipped:run-active';
        deferredLedger.boundaries[pendingRetro.key] = pendingRetro;
        deferredLedger.updatedAt = new Date().toISOString();
        await writeMilestoneLedger(projectDir, deferredLedger);
        result.retro = { started: false, note: 'skipped:run-active' };
      }
      return result;
    }

    // 空闲时才扫描正文：run 写入过程中读取既浪费 I/O，也可能读到半成品。
    const finalizedNumbers = await listFinalizedChapterNumbers(projectDir);
    const finalized = finalizedNumbers.size;
    result.finalizedChapters = finalized;

    const ledger = await readMilestoneLedger(projectDir);

    interface PendingBoundary {
      key: string;
      kind: 'chapter' | 'volume';
      chapter: number;
      label: string;
      volumeName?: string;
    }
    const pending: PendingBoundary[] = [];

    if (every > 0) {
      for (let n = every; n <= finalized; n += every) {
        const key = `chapter:${n}`;
        if (ledger.boundaries[key]) continue;
        pending.push({ key, kind: 'chapter', chapter: n, label: `chapter-${n}` });
      }
    } else {
      result.notes.push('milestoneEvery=0：已关闭按章自动里程碑');
    }

    for (const volume of await readVolumes(projectDir)) {
      // 卷末章必须本身有效（而非仅总章数足够）——稀疏/断号项目不会误触发。
      if (!finalizedNumbers.has(volume.endChapter)) continue;
      const key = `volume:${volume.endChapter}`;
      if (ledger.boundaries[key]) continue;
      pending.push({
        key,
        kind: 'volume',
        chapter: volume.endChapter,
        label: `volume-${volume.endChapter}`,
        volumeName: volume.name,
      });
    }

    for (const boundary of pending) {
      // 评估开始后批量写作可能已启动下一章：立即停手，避免把半成品章节
      // 打进里程碑快照；剩余边界留待下一次 run 结束再评估。
      if (getActiveRunForProject(projectId)) {
        result.deferred = true;
        result.skipped.push(...pending.slice(pending.indexOf(boundary)).map((b) => b.key));
        result.notes.push('评估过程中出现活跃 run，剩余里程碑推迟');
        break;
      }
      const snapshot = await createMilestoneSnapshotSafe(projectDir, boundary.label);
      if (snapshot.skipped) {
        result.skipped.push(boundary.key);
        result.notes.push(`git 结构操作在途，跳过快照 ${boundary.key}（下次重试）`);
        continue;
      }
      if (!snapshot.hash) {
        result.skipped.push(boundary.key);
        result.notes.push(`快照创建失败 ${boundary.key}（下次重试）`);
        continue;
      }
      const record: MilestoneRecord = {
        key: boundary.key,
        kind: boundary.kind,
        chapter: boundary.chapter,
        label: boundary.label,
        volumeName: boundary.volumeName,
        hash: snapshot.hash,
        createdAt: new Date().toISOString(),
        retroRunId: null,
        retroNote: null,
      };
      // 每建一个就落盘：进程在多个边界之间崩溃也不会重复创建已完成的边界。
      ledger.boundaries[boundary.key] = record;
      ledger.updatedAt = record.createdAt;
      await writeMilestoneLedger(projectDir, ledger);
      result.created.push(record);
    }

    if (opts.triggerRetro === false) {
      return result;
    }

    // 只为最新边界触发一次回顾；若之前因 run/批量在途跳过，本次评估重试。
    const latest = result.created.length > 0
      ? result.created[result.created.length - 1]
      : latestRetryableRetroBoundary(ledger);
    if (!latest) return result;

    // 已有活跃 run（例如批量写作的下一章抢先启动）：按约定跳过并记录 note，
    // 不排队隐藏任务；下一次 run 结束或批量结束时再次评估。
    const active = getActiveRunForProject(projectId);
    if (active) {
      latest.retroNote = 'skipped:run-active';
      ledger.boundaries[latest.key] = latest;
      ledger.updatedAt = new Date().toISOString();
      await writeMilestoneLedger(projectDir, ledger);
      result.retro = { started: false, note: 'skipped:run-active' };
      result.notes.push('里程碑回顾跳过：评估时仍有活跃 run');
      return result;
    }

    // 批量写作进行中（两章之间也没有活跃 run）：不抢下一章的串行锁；
    // 批量完成/取消时会再评估一次。
    const batch = await readBatchState(projectDir).catch(() => null);
    if (batch?.status === 'running') {
      latest.retroNote = 'skipped:batch-active';
      ledger.boundaries[latest.key] = latest;
      ledger.updatedAt = new Date().toISOString();
      await writeMilestoneLedger(projectDir, ledger);
      result.retro = { started: false, note: 'skipped:batch-active' };
      result.notes.push('里程碑回顾跳过：批量写作进行中');
      return result;
    }

    const prompt = buildMilestoneRetrospectivePrompt({
      kind: latest.kind,
      chapter: latest.chapter,
      label: latest.label,
      volumeName: latest.volumeName,
      finalizedChapters: finalized,
    });
    const retro = await triggerRetrospective(
      projectId,
      opts.agentId,
      opts.skillId,
      prompt,
      latest.key,
    );
    latest.retroRunId = retro.runId ?? null;
    latest.retroNote = retro.started ? 'started' : retro.note ?? 'skipped';
    ledger.boundaries[latest.key] = latest;
    ledger.updatedAt = new Date().toISOString();
    await writeMilestoneLedger(projectDir, ledger);
    result.retro = retro;
    result.notes.push(
      retro.started
        ? `已触发里程碑回顾 run（${latest.key}）`
        : `里程碑回顾未触发（${latest.key}）：${retro.note ?? 'unknown'}`,
    );
    return result;
  });
}
