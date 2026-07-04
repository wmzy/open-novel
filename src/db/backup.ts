import fs from 'node:fs/promises';
import path from 'node:path';
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
 * Backup files are stored in `./data/backups/` as
 * `pglite-<ISO-timestamp>.tar.gz`, with a symlink `latest.tar.gz` pointing
 * to the most recent successful backup.
 */

const BACKUP_DIR = path.resolve('./data/backups');
const MAX_BACKUPS = 10;

/**
 * Create a compressed tarball dump of the PGlite data directory.
 *
 * Uses PGlite's native `dumpDataDir('gzip')` which coordinates with the
 * running Postgres instance to ensure WAL consistency.
 *
 * @returns Path to the created backup file, or null if PGlite is not in use.
 */
export async function backupDataDir(): Promise<string | null> {
  if (!isPglite) return null;

  const pglite = getPglite();
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

  console.info(`[backup] created ${filepath} (${(buffer.length / 1024).toFixed(0)} KB)`);
  return filepath;
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
