import { Hono } from 'hono';
import { backupDataDir, listBackups } from '../../db/backup';

const backupRouter = new Hono();

/**
 * POST /api/backup
 * Trigger an immediate database backup.
 * Returns the backup filename and size.
 */
backupRouter.post('/', async (c) => {
  try {
    const filepath = await backupDataDir();
    if (!filepath) {
      return c.json({ ok: false, error: 'Backup is only available when using PGlite' }, 400);
    }
    const filename = filepath.split('/').pop();
    const stat = await import('node:fs/promises').then((fs) => fs.stat(filepath));
    return c.json({
      ok: true,
      filename,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
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
