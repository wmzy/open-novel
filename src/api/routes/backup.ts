import { Hono } from 'hono';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { backupDataDir, listBackups } from '../../db/backup';
import { restoreFromBackup } from '../../db/drizzle';
import { getAnyActiveRun } from '../../agent/run';

const backupRouter = new Hono();

/**
 * POST /api/backup
 * Trigger an immediate database backup.
 * When nothing changed since the last backup, no new copy is created and
 * the response reports the existing backup with `skipped: true`.
 */
backupRouter.post('/', async (c) => {
  try {
    const result = await backupDataDir();
    if (result.filepath === null) {
      return c.json({ ok: false, error: 'Backup is only available when using PGlite' }, 400);
    }
    const st = await stat(result.filepath);
    return c.json({
      ok: true,
      skipped: !result.created,
      filename: basename(result.filepath),
      size: st.size,
      createdAt: st.mtime.toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, error: msg }, 500);
  }
});

/**
 * GET /api/backup
 * List available backups, newest first.
 */
backupRouter.get('/', async (c) => {
  const backups = await listBackups();
  return c.json({ backups });
});

/**
 * POST /api/backup/restore
 * Restore the database from a specific backup file (manual restore).
 * body: { filename: string } — must exactly match a listed backup filename.
 *
 * 注意：恢复会关闭并重建当前数据库实例，执行期间其他请求可能失败；
 * 建议在所有写作任务结束后调用。
 */
backupRouter.post('/restore', async (c) => {
  // 全局排他：恢复会关闭并重建当前 PGlite 实例，任何活跃 run 的收尾写库都会
  // 撞上已关闭的 DB——存在活跃 run 时直接拒绝（不能只靠文档提示）。
  const active = getAnyActiveRun();
  if (active) {
    return c.json({
      ok: false,
      error: `有正在运行的写作任务（runId: ${active.id}），请先等待完成或停止后再恢复备份`,
    }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';
  if (!filename) return c.json({ ok: false, error: 'filename is required' }, 400);

  // 文件名白名单校验：只允许恢复 listBackups 返回的文件（防路径穿越）
  const backups = await listBackups();
  if (!backups.some((b) => b.filename === filename)) {
    return c.json({ ok: false, error: '备份文件不存在' }, 404);
  }

  const result = await restoreFromBackup(filename);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 500);
  return c.json({ ok: true, filename });
});

export default backupRouter;
