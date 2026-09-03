import fs from 'node:fs/promises';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { getPglite, isPglite } from './drizzle';

/**
 * Database backup utilities.
 *
 * PGlite stores all data in a single directory (./data/pglite by default).
 * If the WASM process crashes without graceful shutdown, the WAL may not be
 * flushed, leaving the data directory in an unrecoverable state. These
 * utilities provide two safety nets:
 *
 * 1. `backupDataDir()` — dumps the entire data directory to a compressed
 *    tarball using PGlite's native `dumpDataDir()` API. This is the most
 *    reliable backup because it coordinates with the running Postgres
 *    instance (ensuring WAL consistency).
 *
 * 2. `startPeriodicBackup()` — runs the dump on an interval, so even an
 *    ungraceful crash loses at most `intervalMs` of data.
 *
 * 3. `backupOnShutdown()` — called from the SIGTERM/SIGINT handler to
 *    create a final clean snapshot before the process exits.
 *
 * Backup files are stored in `./data/backups/` (overridable via
 * `BACKUP_DIR`, used by tests to keep out of the development store) as
 * `pglite-<ISO-timestamp>.tar.gz`, with a symlink `latest.tar.gz` pointing
 * to the most recent successful backup.
 *
 * Change detection: writes always advance the WAL insert LSN while reads
 * never do (verified against PGlite 0.4.6), so `backupDataDir()` records
 * the LSN at each successful dump and skips creating a new file when the
 * LSN is unchanged — an idle app no longer accumulates identical copies.
 * The recorded LSN lives in memory only: a restart advances the LSN during
 * startup, so the first backup after a restart always runs. If the LSN
 * cannot be read, the dump runs unconditionally (fail open — a redundant
 * backup is always safer than a skipped one).
 */

const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || './data/backups');
const MAX_BACKUPS = 10;

export type BackupResult =
  | { created: true; filepath: string }
  | { created: false; filepath: string; reason: 'no-change' }
  | { created: false; filepath: null; reason: 'not-pglite' };

/** WAL insert LSN and file of the last successful dump. */
let lastBackup: { lsn: string; filepath: string } | null = null;

/** In-flight dump — concurrent triggers (periodic + manual) share one run. */
let inflight: Promise<BackupResult> | null = null;

/**
 * Create a compressed tarball dump of the PGlite data directory.
 *
 * Skips the dump entirely when nothing changed since the last successful
 * backup, returning the existing file with `created: false`.
 *
 * @returns Result describing the created backup or why none was created.
 */
export function backupDataDir(): Promise<BackupResult> {
  if (!inflight) {
    inflight = doBackup().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function doBackup(): Promise<BackupResult> {
  if (!isPglite) return { created: false, filepath: null, reason: 'not-pglite' };

  const pglite = getPglite();
  const lsn = await readWalInsertLsn(pglite);

  // Skip when nothing changed since the last dump. Also requires the file to
  // still exist — it may have been pruned or deleted by hand.
  if (lsn !== null && lastBackup && lsn === lastBackup.lsn) {
    const exists = await fs
      .access(lastBackup.filepath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      console.info('[backup] no changes since last backup, skipped');
      return { created: false, filepath: lastBackup.filepath, reason: 'no-change' };
    }
    lastBackup = null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `pglite-${timestamp}.tar.gz`;
  const filepath = path.join(BACKUP_DIR, filename);

  await fs.mkdir(BACKUP_DIR, { recursive: true });

  // dumpDataDir returns a File/Blob containing the gzipped tarball.
  const dump = await pglite.dumpDataDir('gzip');
  const buffer = Buffer.from(await dump.arrayBuffer());
  await fs.writeFile(filepath, buffer);

  // Update the 'latest' symlink for easy recovery.
  const latestLink = path.join(BACKUP_DIR, 'latest.tar.gz');
  try {
    await fs.unlink(latestLink);
  } catch {
    // Symlink may not exist yet — fine.
  }
  await fs.symlink(filename, latestLink);

  // Prune old backups beyond MAX_BACKUPS.
  await pruneOldBackups();

  // Record the pre-dump LSN: a write landing mid-dump advances the LSN past
  // this value, so the next backup runs again — conservative, never skips
  // real changes.
  if (lsn !== null) {
    lastBackup = { lsn, filepath };
  }

  console.info(`[backup] created ${filepath} (${(buffer.length / 1024).toFixed(0)} KB)`);
  return { created: true, filepath };
}

/**
 * Read the current WAL insert LSN. Returns null on failure — change
 * detection is an optimisation, never a reason to skip a backup.
 */
async function readWalInsertLsn(pglite: PGlite): Promise<string | null> {
  try {
    const res = await pglite.query<{ lsn: string }>(
      'SELECT pg_current_wal_insert_lsn() AS lsn',
    );
    return res.rows[0]?.lsn ?? null;
  } catch (err) {
    console.error('[backup] failed to read WAL LSN, change detection disabled:', err);
    return null;
  }
}

/**
 * Start a periodic backup timer.
 *
 * @param intervalMs Backup interval in milliseconds (default: 5 minutes).
 * @returns A NodeJS.Timeout that can be passed to clearTimeout to stop.
 */
export function startPeriodicBackup(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      await backupDataDir();
    } catch (err) {
      console.error('[backup] periodic backup failed:', err);
    }
  }, intervalMs);

  // Don't keep the process alive just for backups.
  timer.unref();
  console.info(`[backup] periodic backup every ${intervalMs / 1000}s`);
  return timer;
}

/**
 * Create a final backup before process shutdown.
 * Called from the SIGTERM/SIGINT handler.
 */
export async function backupOnShutdown(): Promise<void> {
  try {
    await backupDataDir();
  } catch (err) {
    // Don't let backup failure block shutdown.
    console.error('[backup] shutdown backup failed:', err);
  }
}

/**
 * Remove old backups, keeping only the most recent MAX_BACKUPS.
 */
async function pruneOldBackups(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(BACKUP_DIR);
  } catch {
    return;
  }

  const backups = entries
    .filter((f) => f.startsWith('pglite-') && f.endsWith('.tar.gz'))
    .sort()
    .reverse(); // newest first

  for (const old of backups.slice(MAX_BACKUPS)) {
    await fs.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
  }
}

/**
 * List available backups, newest first.
 */
export async function listBackups(): Promise<
  Array<{ filename: string; size: number; mtime: Date }>
> {
  let entries: string[];
  try {
    entries = await fs.readdir(BACKUP_DIR);
  } catch {
    return [];
  }

  const result: Array<{ filename: string; size: number; mtime: Date }> = [];
  for (const filename of entries.filter((f) => f.startsWith('pglite-') && f.endsWith('.tar.gz'))) {
    const stat = await fs.stat(path.join(BACKUP_DIR, filename));
    result.push({ filename, size: stat.size, mtime: stat.mtime });
  }
  return result.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}
