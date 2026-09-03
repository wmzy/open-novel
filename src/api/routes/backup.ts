import { Hono } from 'hono';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { backupDataDir, listBackups } from '../../db/backup';

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

export default backupRouter;
