import path from 'node:path';
import fs from 'node:fs';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import * as schema from './schema';

export const isPglite =
  !process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('pglite://');

const globalKey = '__open_novel_db__';
const globalPgliteKey = '__open_novel_pglite__';

type Database = ReturnType<typeof drizzlePglite<typeof schema>>;

// The canonical development data directory. Tests must NEVER touch this —
// tests/setup.ts redirects PGLITE_DATA_DIR to an isolated temp directory
// before any module import. This constant lets us assert that at runtime.
const DEV_DATA_DIR = path.resolve('./data/pglite');

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
 * Remove a stale PostgreSQL `postmaster.pid` from the data directory.
 *
 * When a PGlite (WASM Postgres) process is killed without graceful shutdown
 * (SIGKILL, OOM, crash), the pid file persists. On next startup PGlite may
 * see the stale pid and abort initialisation. We check whether the pid is
 * still alive; if not, the file is safe to remove.
 *
 * This is a defensive measure — PGlite *should* handle this itself, but in
 * practice (v0.4.x) it sometimes does not, leading to `RuntimeError: Aborted()`.
 */
export function cleanStaleLock(dataDir: string): void {
  const pidFile = path.join(dataDir, 'postmaster.pid');
  if (!fs.existsSync(pidFile)) return;

  const raw = fs.readFileSync(pidFile, 'utf-8').trim();
  const pid = parseInt(raw.split('\n')[0], 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    // Corrupt pid file — remove it.
    fs.unlinkSync(pidFile);
    console.warn(`[db] removed corrupt postmaster.pid in ${dataDir}`);
    return;
  }

  // Check if the process is still alive.
  try {
    process.kill(pid, 0); // signal 0 = existence check, throws if not alive
    // Process is alive — but is it US? If our own pid matches, the file
    // was created by a previous run of this process (e.g. hot reload).
    if (pid === process.pid) {
      fs.unlinkSync(pidFile);
      return;
    }
    // A different live process holds the pid — do NOT remove; it may be a
    // legitimately running server instance. The caller will get an error
    // from PGlite if there is a real conflict.
    console.warn(`[db] postmaster.pid in ${dataDir} belongs to live pid ${pid}, leaving it`);
    return;
  } catch {
    // ESRCH — process not alive. Safe to remove the stale lock.
    fs.unlinkSync(pidFile);
    console.warn(`[db] removed stale postmaster.pid (dead pid ${pid}) in ${dataDir}`);
  }
}

function createDb(): Database {
  if (isPglite) {
    const dataDir = process.env.PGLITE_DATA_DIR || './data/pglite';
    const resolvedDir = path.resolve(dataDir);

    // CRITICAL: In a vitest context, the data dir MUST NOT be the development
    // store. If it is, tests would concurrently write to the live database,
    // corrupting it. tests/setup.ts sets PGLITE_DATA_DIR to a temp dir, but
    // this assertion is the last line of defence.
    if (isVitest() && resolvedDir === DEV_DATA_DIR) {
      throw new Error(
        `[db] FATAL: vitest is using the development data directory (${DEV_DATA_DIR}). ` +
          'This will corrupt the live database. Ensure tests/setup.ts runs before any ' +
          'module that imports drizzle.ts.',
      );
    }

    // Clean stale lock files before initialisation (non-test only — test
    // dirs are fresh temp dirs that never have stale locks).
    if (!isVitest()) {
      cleanStaleLock(resolvedDir);
    }

    const pglite = new PGlite(dataDir);
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
  g[globalKey] = createDb();
}

export const db = g[globalKey] as Database;

let ready = false;

export async function ensureDbReady() {
  if (ready) return;
  if (isPglite) {
    const pglite = getPglite();
    await pglite.waitReady;
    // PGlite runs the standard Drizzle migrations generated from schema.ts,
    // so schema.ts is the single source of truth for table definitions.
    const migrationsFolder =
      process.env.DRIZZLE_MIGRATIONS_FOLDER ?? path.resolve(process.cwd(), 'drizzle');
    await migrate(db, { migrationsFolder });
  }
  ready = true;
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
 * may find a corrupted store and abort with `RuntimeError: Aborted()`.
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
    ready = false;
  }
}
