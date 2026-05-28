import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
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
  return drizzlePostgres(client, { schema, casing: 'snake_case' }) as Database;
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
    await pglite.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id VARCHAR(25) PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        path VARCHAR(500) NOT NULL,
        genre VARCHAR(50) NOT NULL DEFAULT 'general',
        target_words INTEGER NOT NULL DEFAULT 100000,
        chapter_count INTEGER NOT NULL DEFAULT 20,
        theme VARCHAR(500),
        perspective VARCHAR(50) NOT NULL DEFAULT 'third-person',
        current_stage VARCHAR(50) NOT NULL DEFAULT 'concept',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id VARCHAR(25) PRIMARY KEY,
        project_id VARCHAR(25) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        title VARCHAR(200),
        word_count INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(project_id, number)
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(25) PRIMARY KEY,
        project_id VARCHAR(25) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id VARCHAR(50) NOT NULL,
        stage VARCHAR(50),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(25) PRIMARY KEY,
        conversation_id VARCHAR(25) NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role VARCHAR(20) NOT NULL,
        content VARCHAR(100000) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS runs (
        id VARCHAR(50) PRIMARY KEY,
        conversation_id VARCHAR(25) REFERENCES conversations(id) ON DELETE SET NULL,
        agent VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'queued',
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS user_settings (
        id VARCHAR(25) PRIMARY KEY,
        key VARCHAR(100) NOT NULL UNIQUE,
        value VARCHAR(5000) NOT NULL
      );
    `);
  }
  ready = true;
}
