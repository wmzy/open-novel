import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-instance lock for the PGlite data directory.
 *
 * Postgres assumes exclusive control over its data directory. PGlite's
 * NodeFS does not lock it, so two processes (e.g. two `pnpm dev` terminals,
 * or a dev server plus a script) writing the same directory will silently
 * corrupt it:
 *   https://github.com/electric-sql/pglite/pull/892 (open, unmerged)
 *
 * This module emulates that missing lock: a sidecar `<dataDir>.lock` file
 * next to (not inside) the data directory records the owning PID. A stale
 * lock — one whose PID is dead — is removed and re-acquired on startup, so
 * crashes do not wedge future launches.
 *
 * TODO(upstream): remove this module once
 * https://github.com/electric-sql/pglite/pull/892 lands and rely on PGlite's
 * built-in data directory locking instead.
 */

export function lockPathFor(dataDir: string): string {
  return `${path.resolve(dataDir)}.lock`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM and friends mean the process exists
    // but belongs to someone else — treat as alive.
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

/**
 * Acquire the lock for `dataDir`, throwing if another live process holds it.
 * Idempotent: acquiring a lock already held by this process is a no-op
 * (hot-reload re-imports re-run module initialisation in the same process).
 */
export function acquireDataDirLock(dataDir: string): void {
  const lockPath = lockPathFor(dataDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      fs.closeSync(fd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      let existing: { pid?: unknown } = {};
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        // Unreadable lock file — treat as stale and retry.
      }

      if (typeof existing.pid === 'number' && existing.pid === process.pid) {
        return; // already held by this process (hot reload)
      }
      if (typeof existing.pid === 'number' && pidAlive(existing.pid)) {
        throw new Error(
          `[db] data directory ${dataDir} is locked by another running instance (pid ${existing.pid}). ` +
            'PGlite assumes exclusive control over its data directory ' +
            '(https://github.com/electric-sql/pglite/pull/892), and two ' +
            'instances sharing it will corrupt the database. ' +
            `If you are sure no other instance is running, delete ${lockPath} and restart.`,
          { cause: err },
        );
      }

      // Stale lock (dead pid) — remove and retry.
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error(`[db] could not acquire data directory lock at ${lockPath}`);
}

/**
 * Release the lock if (and only if) it is held by this process.
 */
export function releaseDataDirLock(dataDir: string): void {
  const lockPath = lockPathFor(dataDir);
  try {
    const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (existing.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Missing or unreadable lock — nothing to release.
  }
}
