import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 章节状态落盘（.novel/chapter-status.json）。
 *
 * chapters.status（draft/review/revised/finalized）是用户逐章维护的工作流
 * 状态，此前只存 DB 缓存——PGlite 损坏后从备份恢复时全部重置为 draft，
 * 且无法重建。此处把状态随正文一起落盘：磁盘是事实源，resync 从该文件
 * 恢复状态（DB 行缺失时），git 快照自动覆盖该文件（.novel/ 下 git add -A）。
 *
 * 文件格式：{ "<章节号>": "<status>", ... }。缺失/损坏按空处理。
 */

export const CHAPTER_STATUSES = ['draft', 'review', 'revised', 'finalized'] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

const STATUS_FILE = 'chapter-status.json';

export function isChapterStatus(v: unknown): v is ChapterStatus {
  return typeof v === 'string' && (CHAPTER_STATUSES as readonly string[]).includes(v);
}

function statusFilePath(novelDir: string): string {
  return path.join(novelDir, STATUS_FILE);
}

/** 读取章节状态文件（缺失/损坏返回空 Map）。 */
export async function readChapterStatuses(novelDir: string): Promise<Map<number, ChapterStatus>> {
  const result = new Map<number, ChapterStatus>();
  try {
    const raw = await fs.readFile(statusFilePath(novelDir), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const num = Number(key);
        if (Number.isInteger(num) && num >= 1 && isChapterStatus(value)) {
          result.set(num, value);
        }
      }
    }
  } catch {
    /* 文件缺失/损坏：按无状态处理 */
  }
  return result;
}

/** 读取-修改-写回：设置单章状态。失败静默（状态落盘是冗余层，DB 仍为当前事实）。 */
export async function setChapterStatus(novelDir: string, num: number, status: ChapterStatus): Promise<void> {
  try {
    const statuses = await readChapterStatuses(novelDir);
    statuses.set(num, status);
    await writeChapterStatuses(novelDir, statuses);
  } catch {
    /* 写入失败不阻断主流程 */
  }
}

/** 删除单章状态（章节被删除时调用）。 */
export async function removeChapterStatus(novelDir: string, num: number): Promise<void> {
  try {
    const statuses = await readChapterStatuses(novelDir);
    if (!statuses.delete(num)) return;
    await writeChapterStatuses(novelDir, statuses);
  } catch {
    /* noop */
  }
}

/**
 * 重编号平移：删除第 deletedNum 章后，> deletedNum 的章号前移一位；
 * 恰好等于 deletedNum 的条目移除（章节已删）。
 */
export async function shiftChapterStatuses(novelDir: string, deletedNum: number): Promise<void> {
  try {
    const statuses = await readChapterStatuses(novelDir);
    const shifted = new Map<number, ChapterStatus>();
    for (const [num, status] of statuses) {
      if (num === deletedNum) continue;
      shifted.set(num > deletedNum ? num - 1 : num, status);
    }
    await writeChapterStatuses(novelDir, shifted);
  } catch {
    /* noop */
  }
}

async function writeChapterStatuses(novelDir: string, statuses: Map<number, ChapterStatus>): Promise<void> {
  const obj: Record<string, ChapterStatus> = {};
  for (const [num, status] of [...statuses.entries()].sort((a, b) => a[0] - b[0])) {
    obj[String(num)] = status;
  }
  const filePath = statusFilePath(novelDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // 先写临时文件再 rename，避免半写状态文件被 resync 读到损坏内容
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(obj, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}
