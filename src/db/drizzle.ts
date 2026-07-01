import path from 'node:path';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import * as schema from './schema';

const isPglite = !process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('pglite://');

const globalKey = '__open_novel_db__';

type Database = ReturnType<typeof drizzlePglite<typeof schema>>;

function createDb(): Database {
  if (isPglite) {
    const dataDir = process.env.PGLITE_DATA_DIR || './data/pglite';
    const pglite = new PGlite(dataDir);
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
    const pglite = (db as any)._.session.client as PGlite;
    await pglite.waitReady;
    // PGlite runs the standard Drizzle migrations generated from schema.ts,
    // so schema.ts is the single source of truth for table definitions.
    const migrationsFolder =
      process.env.DRIZZLE_MIGRATIONS_FOLDER ?? path.resolve(process.cwd(), 'drizzle');
    await migrate(db, { migrationsFolder });
  }
  ready = true;
}
