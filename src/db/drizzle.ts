import path from 'node:path';
import fsp from 'node:fs/promises';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import * as schema from './schema';
import { acquireDataDirLock, releaseDataDirLock } from './data-dir-lock';
import {
  cleanStaleLock,
  extractBackupTo,
  isBackupVersionCompatible,
  preflightDataDir,
  readDataDirPgVersion,
  readPgVersionFromTar,
} from './recovery';

export const isPglite =
  !process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('pglite://');

const globalKey = '__open_novel_db__';
const globalPgliteKey = '__open_novel_pglite__';

type Database = ReturnType<typeof drizzlePglite<typeof schema>>;

// The canonical development data directory. Tests must NEVER touch this —
// tests/setup.ts redirects PGLITE_DATA_DIR to an isolated temp directory
// before any module import. This constant lets us assert that at runtime.
const DEV_DATA_DIR = path.resolve('./data/pglite');

// Re-exported for callers of the historical location (tests/unit/db).
export { cleanStaleLock } from './recovery';

/**
 * Resolve the PGlite data directory (env-overridable, used by tests).
 */
export function getPgliteDataDir(): string {
  return path.resolve(process.env.PGLITE_DATA_DIR || './data/pglite');
}

/**
 * Detect whether we are running inside vitest.
 *
 * vitest injects several globals and env vars. We check the most reliable
 * signal: the `VITEST` env var that vitest sets automatically.
 */
function isVitest(): boolean {
  return !!process.env.VITEST;
}

/**
 * Create a drizzle instance backed by a fresh PGlite on the data directory.
 *
 * Durability notes (this is where "db should never corrupt" breaks down):
 *   - PGlite runs Postgres single-user with `-F` (fsync off) and relies on
 *     host-level `syncToFs()` after each top-level query. We pin
 *     `relaxedDurability: false` explicitly so a future default flip cannot
 *     silently weaken this. Known upstream gaps: transaction COMMIT skips
 *     the sync (electric-sql/pglite#1065, open); close() can race in-flight
 *     statements (electric-sql/pglite#1084, open).
 *   - There is no data-directory locking upstream (electric-sql/pglite#892,
 *     open): two processes sharing the directory corrupt it. We enforce a
 *     single-instance lock in data-dir-lock.ts.
 *   - Concurrent PGlite initialisation across processes can SIGSEGV Node
 *     itself (electric-sql/pglite#1053, open; nodejs/node#64500).
 */
function createDb(): Database {
  if (isPglite) {
    const dataDir = getPgliteDataDir();

    // CRITICAL: In a vitest context, the data dir MUST NOT be the development
    // store. If it is, tests would concurrently write to the live database,
    // corrupting it. tests/setup.ts sets PGLITE_DATA_DIR to a temp dir, but
    // this assertion is the last line of defence.
    if (isVitest() && dataDir === DEV_DATA_DIR) {
      throw new Error(
        `[db] FATAL: vitest is using the development data directory (${DEV_DATA_DIR}). ` +
          'This will corrupt the live database. Ensure tests/setup.ts runs before any ' +
          'module that imports drizzle.ts.',
      );
    }

    // Clean stale lock files before initialisation (non-test only — test
    // dirs are fresh temp dirs that never have stale locks).
    if (!isVitest()) {
      cleanStaleLock(dataDir);
    }

    const pglite = new PGlite(dataDir, { relaxedDurability: false });
    // Stash the raw PGlite instance on globalThis so closeDb / backup can
    // access it without relying on fragile drizzle internals.
    (globalThis as Record<string, unknown>)[globalPgliteKey] = pglite;
    return drizzlePglite(pglite, { schema, casing: 'snake_case' });
  }
  const client = postgres(process.env.DATABASE_URL!);
  return drizzlePostgres(client, { schema, casing: 'snake_case' }) as unknown as Database;
}

const g = globalThis as Record<string, unknown>;
if (!g[globalKey]) {
  // Single-instance guard, acquired BEFORE PGlite opens the data directory.
  // See src/db/data-dir-lock.ts for the upstream issue (#892) and the
  // TODO that tracks its removal.
  if (isPglite) {
    acquireDataDirLock(getPgliteDataDir());
    // Refuse to let PGlite silently re-initdb over a data dir that lost its
    // PG_VERSION (upstream #884) — loud failure instead of silent data loss.
    preflightDataDir(getPgliteDataDir());
  }
  g[globalKey] = createDb();
}

/**
 * The shared drizzle instance.
 *
 * `let` (not `const`) so the auto-recovery path can rebind it to a fresh
 * instance after restoring the data directory from a backup. ESM live
 * bindings propagate the reassignment to every importer.
 */
export let db = g[globalKey] as Database;

let ready = false;

/**
 * Startup has already been attempted once in this process (guards against
 * retry loops when the backup itself fails to boot).
 */
let recoveryAttempted = false;

/**
 * Bring the database up and verify its health.
 *
 * For PGlite this waits for initdb/WAL replay, runs a `SELECT 1` health
 * check, and applies drizzle migrations. If the store fails to boot (corrupt
 * WAL, stale pid, torn shutdown — upstream #884 / #994), we restore the
 * newest compatible backup from data/backups/ automatically and retry once.
 */
export async function ensureDbReady() {
  if (ready) return;

  if (isPglite) {
    try {
      await initPgliteCore();
    } catch (err) {
      console.error('[db] database startup failed:', err);
      if (recoveryAttempted || !(await recoverWithBackup())) {
        throw err;
      }
      // recoverWithBackup() already ran initPgliteCore() on the restored
      // instance — nothing left to do.
    }
  } else {
    // postgres-js mode: health check only, no backup recovery.
    await db.execute(sql`select 1`);
  }
  ready = true;
}

/**
 * waitReady + health check + migrations, on the CURRENT instance.
 */
async function initPgliteCore(): Promise<void> {
  const pglite = getPglite();
  await pglite.waitReady;
  // Health check: a store with corrupt WAL/control file fails here (or in
  // waitReady) instead of booting a half-working instance.
  await pglite.query('SELECT 1');
  // PGlite runs the standard Drizzle migrations generated from schema.ts,
  // so schema.ts is the single source of truth for table definitions.
  const migrationsFolder =
    process.env.DRIZZLE_MIGRATIONS_FOLDER ?? path.resolve(process.cwd(), 'drizzle');
  await migrate(db, { migrationsFolder });
}

/**
 * Restore the data directory from the newest compatible backup.
 *
 * Backups are dumpDataDir() tarballs (data/backups/). Each candidate is
 * extracted over the corrupt directory (which is first moved aside, e.g.
 * data/pglite.corrupted.<ts>, for forensics) and booted; the first one that
 * passes the health check wins. Backups from a different PG major version
 * (e.g. PG17 leftovers after the 0.5.x upgrade) are skipped.
 *
 * TODO(upstream): the maintainers closed electric-sql/pglite#994 ("should
 * be a separate tool"), so application-level restore stays necessary until
 * upstream ships WAL repair or we move off PGlite.
 */
async function recoverWithBackup(): Promise<boolean> {
  recoveryAttempted = true;

  const dataDir = getPgliteDataDir();
  // Dynamic import to avoid a static import cycle (backup.ts imports
  // getPglite from this module).
  const { listBackups, getBackupDir, resetBackupChangeTracking } = await import('./backup');
  const backups = await listBackups();
  if (backups.length === 0) {
    console.error('[db] no backups available to restore from');
    return false;
  }

  const currentVersion = await readDataDirPgVersion(dataDir);

  for (const backup of backups) {
    const backupPath = path.join(getBackupDir(), backup.filename);
    const backupVersion = await readPgVersionFromTar(backupPath);
    if (!isBackupVersionCompatible(backupVersion, currentVersion)) {
      console.warn(
        `[db] skipping backup ${backup.filename}: PG major ${backupVersion} ` +
          `does not match the data dir (${currentVersion}) — restore would not boot`,
      );
      continue;
    }

    // Best-effort close of the broken instance, then move the corrupt dir
    // aside (kept for forensics, matching the historical pglite.corrupted.*
    // convention).
    await closeBrokenInstance();
    const aside = `${dataDir}.corrupted.${Date.now()}`;
    await fsp.rename(dataDir, aside).catch(() => {});

    try {
      await extractBackupTo(backupPath, dataDir);
      cleanStaleLock(dataDir);
      rebindInstance();
      await initPgliteCore();
      resetBackupChangeTracking();
      console.info(
        `[db] recovered from backup ${backup.filename} (corrupt dir kept at ${aside})`,
      );
      return true;
    } catch (restoreErr) {
      console.error(`[db] restore from ${backup.filename} failed:`, restoreErr);
      // Move the failed attempt aside so the next backup starts clean.
      await fsp.rename(dataDir, `${dataDir}.corrupted.${Date.now()}`).catch(() => {});
    }
  }
  return false;
}

/**
 * Close the broken instance without letting a hang block recovery.
 *
 * TODO(upstream): electric-sql/pglite#1084 — close() can wedge permanently
 * when racing an in-flight statement; the timeout below is a workaround.
 */
async function closeBrokenInstance(): Promise<void> {
  const pglite = (globalThis as Record<string, unknown>)[globalPgliteKey] as PGlite | undefined;
  if (!pglite) return;
  (globalThis as Record<string, unknown>)[globalPgliteKey] = undefined;
  (globalThis as Record<string, unknown>)[globalKey] = undefined;
  try {
    await Promise.race([
      pglite.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('[db] close() timed out after 2s')), 2000),
      ),
    ]);
  } catch (err) {
    console.error('[db] closing broken instance failed (ignored):', err);
  }
}

/**
 * Recreate the PGlite + drizzle instances on the (restored) data directory
 * and rebind the shared `db` export. The lock is still held by this
 * process, so no re-acquisition is needed.
 */
function rebindInstance(): void {
  const newDb = createDb();
  (globalThis as Record<string, unknown>)[globalKey] = newDb;
  db = newDb;
}

/**
 * Get the underlying PGlite instance (for backup, close, etc.).
 * Throws if using postgres-js instead of PGlite.
 */
export function getPglite(): PGlite {
  if (!isPglite) {
    throw new Error('[db] getPglite() is only available when using PGlite');
  }
  const pglite = (globalThis as Record<string, unknown>)[globalPgliteKey] as PGlite | undefined;
  if (!pglite) {
    throw new Error('[db] PGlite instance not initialised — call ensureDbReady() first');
  }
  return pglite;
}

/**
 * Gracefully close the database connection.
 *
 * MUST be called on process shutdown (SIGTERM/SIGINT) to let PGlite flush its
 * WAL and write a consistent data directory. Without this, the next startup
 * may find a corrupted store and abort with `RuntimeError: Aborted()`
 * (upstream #884; the torn-shutdown race is #994). Since the backup-based
 * recovery above, startup self-heals when that happens anyway.
 *
 * Also releases the single-instance data directory lock.
 *
 * Idempotent — safe to call multiple times.
 */
export async function closeDb(): Promise<void> {
  if (!isPglite) return; // postgres-js connections are pooled; no explicit close needed here
  const pglite = (globalThis as Record<string, unknown>)[globalPgliteKey] as PGlite | undefined;
  if (!pglite) return;
  try {
    await pglite.close();
    console.info('[db] PGlite closed gracefully');
  } catch (err) {
    console.error('[db] Error closing PGlite:', err);
  } finally {
    (globalThis as Record<string, unknown>)[globalPgliteKey] = undefined;
    (globalThis as Record<string, unknown>)[globalKey] = undefined;
    releaseDataDirLock(getPgliteDataDir());
    ready = false;
  }
}
