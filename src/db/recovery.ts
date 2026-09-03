import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * Data-directory repair helpers for PGlite.
 *
 * Postgres itself recovers from a crash by replaying the WAL, but PGlite
 * runs single-user with fsync off and relies on host-level filesystem syncs
 * (see src/db/backup.ts header). Several upstream bugs leave the data
 * directory unrecoverable after a crash or an ungraceful shutdown:
 *   - SIGTERM/shutdown-checkpoint race tears the WAL: #994 (closed
 *     unmerged — "should be a separate tool")
 *   - stale postmaster.pid aborts startup with RuntimeError: Aborted(): #884
 *   - missing data-dir locking corrupts the dir with two processes: #892
 *   - transaction COMMIT skips the host-level sync: #1065 / #1066
 *
 * The helpers here support the application-level recovery implemented in
 * drizzle.ts: extract a consistent dumpDataDir() backup over the corrupt
 * directory, after moving the corrupt one aside for forensics.
 *
 * TODO(upstream): revisit when electric-sql/pglite ships WAL repair (#994)
 * or directory locking (#892) — parts of this module may become redundant.
 */

/**
 * Remove a stale PostgreSQL `postmaster.pid` from a data directory.
 *
 * When PGlite is killed without graceful shutdown, the pid file persists.
 * On next startup PGlite may see the stale pid and abort initialisation
 * with `RuntimeError: Aborted()` — upstream issue #884, observed in v0.4.x
 * and still open. We check whether the recorded pid is alive; if not, the
 * file is safe to remove.
 *
 * TODO(upstream): remove once electric-sql/pglite#884 is fixed.
 */
export function cleanStaleLock(dataDir: string): void {
  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (!fs.existsSync(pidFile)) return;

  const raw = fs.readFileSync(pidFile, 'utf8').trim();
  const pid = parseInt(raw.split('\n')[0], 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    // Corrupt pid file — remove it.
    fs.unlinkSync(pidFile);
    console.warn(`[db] removed corrupt postmaster.pid in ${dataDir}`);
    return;
  }

  try {
    process.kill(pid, 0); // signal 0 = existence check, throws if not alive
    // Process is alive — but is it US? If our own pid matches, the file
    // was created by a previous run of this process (e.g. hot reload).
    if (pid === process.pid) {
      fs.unlinkSync(pidFile);
      return;
    }
    // A different live process holds the pid — do NOT remove.
    console.warn(`[db] postmaster.pid in ${dataDir} belongs to live pid ${pid}, leaving it`);
    return;
  } catch {
    // ESRCH — process not alive. Safe to remove the stale lock.
    fs.unlinkSync(pidFile);
    console.warn(`[db] removed stale postmaster.pid (dead pid ${pid}) in ${dataDir}`);
  }
}

/**
 * Decide whether a backup can be restored into a data directory, by PG
 * major version. Either side unknown (unreadable PG_VERSION) is treated as
 * compatible — the restore attempt itself is the authoritative check.
 */
export function isBackupVersionCompatible(
  backupVersion: string | null,
  currentVersion: string | null,
): boolean {
  if (backupVersion === null || currentVersion === null) return true;
  return backupVersion === currentVersion;
}

/**
 * Preflight a data directory before PGlite touches it.
 *
 * PGlite decides between "resume existing database" and "run initdb" by
 * checking whether <dataDir>/PG_VERSION exists (see pglite.ts: `found DB,
 * resuming` vs `no db in filesystem, running initdb`). A data directory
 * that lost or corrupted PG_VERSION — while still containing data files —
 * is therefore silently re-initialised, destroying the existing store
 * without any error. This guard turns that silent data loss into a loud
 * startup failure instead.
 *
 * TODO(upstream): track electric-sql/pglite#884 — the fix should make
 * PGlite itself refuse to initdb over a non-empty directory.
 */
export function preflightDataDir(dataDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return; // directory does not exist → PGlite will initdb normally
  }
  if (entries.length === 0) return; // empty dir → initdb normally

  let version: string | null;
  try {
    version = fs.readFileSync(path.join(dataDir, 'PG_VERSION'), 'utf8').trim();
  } catch {
    version = null;
  }
  if (version === null || !/^\d+/.test(version)) {
    throw new Error(
      `[db] data directory ${dataDir} is non-empty but has no readable PG_VERSION. ` +
        'PGlite would silently re-run initdb over the existing data and destroy it ' +
        '(https://github.com/electric-sql/pglite/issues/884). Refusing to start. ' +
        'Restore the directory from a backup, or move it aside and restart.',
    );
  }
}

/**
 * Read the PostgreSQL major version from a dumpDataDir() tarball's
 * PG_VERSION entry, or null when it cannot be read (corrupt archive,
 * missing `tar` binary, …). Backups from a different major version cannot
 * be restored into the current runtime, so callers skip them.
 */
export async function readPgVersionFromTar(backupPath: string): Promise<string | null> {
  // The tarball entries may carry a leading slash (/PG_VERSION, from
  // PGlite's dumpDataDir) or a dot-slash (./PG_VERSION, from plain tar
  // invocations); GNU tar strips neither when matching by name, so try all
  // three spellings.
  for (const member of ['/PG_VERSION', 'PG_VERSION', './PG_VERSION']) {
    try {
      const { stdout } = await execFileAsync('tar', ['-xOf', backupPath, member]);
      const version = stdout.toString().trim();
      return /^\d+/.test(version) ? version : null;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

/**
 * Read the PG_VERSION file of a data directory, or null if unreadable.
 */
export async function readDataDirPgVersion(dataDir: string): Promise<string | null> {
  try {
    const version = (await fsp.readFile(path.join(dataDir, 'PG_VERSION'), 'utf8')).trim();
    return /^\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Extract a dumpDataDir() tarball into targetDir using the system `tar`.
 * Throws a descriptive error when the tar binary is unavailable.
 */
export async function extractBackupTo(backupPath: string, targetDir: string): Promise<void> {
  await fsp.mkdir(targetDir, { recursive: true });
  try {
    await execFileAsync('tar', ['-xzf', backupPath, '-C', targetDir]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new Error(
        `[db] system tar binary not found — cannot restore backup ${backupPath}. ` +
          'Install tar (available by default on Linux, macOS and Windows 10+) and retry.',
        { cause: err },
      );
    }
    throw err;
  }
}
