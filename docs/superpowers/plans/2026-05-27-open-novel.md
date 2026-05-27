# Open Novel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone web application for AI-assisted novel writing that delegates to external agent CLIs, with rich visualization views for story elements.

**Architecture:** Single Vite app with Hono API middleware (anthology pattern). Agent spawning system delegates AI work to external CLIs (open-design pattern). Plugin system loads SKILL.md files for different writing genres. Database stores project metadata; file system stores novel content.

**Tech Stack:** React 19, Vite 8, Hono, Drizzle ORM + PGlite, TanStack React Query, React Router DOM v7, Linaria, haze-ui, TypeScript 5.9 strict, pnpm

---

## File Structure

```
open-novel/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  vitest.config.ts
  drizzle.config.ts
  eslint.config.mjs
  prettier.config.mjs
  src/
    main.tsx                          # React entry
    App.tsx                           # Router + providers
    api-app.ts                        # Hono API app
    styles/
      global.ts                       # Global Linaria styles
      shared.ts                       # Shared component styles
    db/
      schema.ts                       # Drizzle schema
      drizzle.ts                      # DB connection (PGlite/PostgreSQL)
    api/
      routes/
        projects.ts                   # Project CRUD
        chapters.ts                   # Chapter CRUD
        runs.ts                       # Agent run management
        agents.ts                     # Agent discovery
        plugins.ts                    # Plugin listing
        settings.ts                   # User settings
    agent/
      types.ts                        # Agent type definitions
      registry.ts                     # Agent definitions
      executables.ts                  # PATH resolution
      launch.ts                       # Agent spawn
      detection.ts                    # Agent probing
      stream-parser.ts                # Unified stream parser
      run.ts                          # Run lifecycle service
    plugins/
      types.ts                        # Plugin types
      loader.ts                       # SKILL.md + manifest parser
      registry.ts                     # Plugin registry
    web/
      pages/
        HomePage.tsx                  # Project list
        ProjectPage.tsx               # Project workspace
        SettingsPage.tsx              # Settings
      components/
        views/
          DashboardView.tsx
          ConceptView.tsx
          WorldView.tsx
          CharacterView.tsx
          OutlineView.tsx
          SceneView.tsx
          ForeshadowView.tsx
          WuxiaView.tsx
        ChatPanel.tsx
        EditorPanel.tsx
        Sidebar.tsx
        WorkflowProgress.tsx
        AgentMessage.tsx
        ToolCard.tsx
      hooks/
        useRun.ts
        useProject.ts
        useChapters.ts
      contexts/
        RunContext.tsx
    templates/                        # Document templates
    prompts/                          # RTCO prompt templates
    utils/
      id.ts                           # ID generation
      files.ts                        # File system helpers
      words.ts                        # Word counting
  plugins/                            # External plugin directory
    novel/
      SKILL.md
      open-novel.json
    wuxia/
      SKILL.md
      open-novel.json
    reality/
      SKILL.md
      open-novel.json
  data/                               # Runtime data
  tests/
    setup.ts
    unit/
    integration/
    e2e/
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `eslint.config.mjs`
- Create: `prettier.config.mjs`
- Create: `vitest.config.ts`
- Create: `tests/setup.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "open-novel",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "start": "node dist/server/api.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "db:generate": "drizzle-kit generate",
    "db:push": "drizzle-kit push",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "lint": "eslint src/",
    "format": "prettier --write src/"
  },
  "dependencies": {
    "@electric-sql/pglite": "^0.4.5",
    "@hono/node-server": "^2.0.2",
    "@linaria/core": "^7.0.0",
    "@linaria/react": "^7.0.1",
    "@tanstack/react-query": "^5.100.10",
    "drizzle-orm": "^0.45.2",
    "haze-ui": "^1.5.6",
    "hono": "^4.12.18",
    "pino": "^10.3.1",
    "pino-pretty": "^10.3.1",
    "postgres": "^3.4.9",
    "react": "^19.2.6",
    "react-dom": "^19.2.6",
    "react-markdown": "^9.0.0",
    "react-router-dom": "^7.15.0",
    "remark-gfm": "^4.0.0",
    "sonner": "^2.0.7",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@babel/plugin-transform-react-jsx": "^7.25.0",
    "@babel/preset-react": "^7.26.0",
    "@babel/preset-typescript": "^7.26.0",
    "@playwright/test": "^1.60.0",
    "@stylistic/eslint-plugin": "^4.0.0",
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^6.0.1",
    "@vitest/coverage-v8": "^4.1.6",
    "@wyw-in-js/babel-preset": "^0.6.0",
    "@wyw-in-js/vite": "^0.6.0",
    "drizzle-kit": "^0.31.10",
    "eslint": "^10.3.0",
    "eslint-plugin-react-hooks": "^5.2.0",
    "eslint-plugin-react-refresh": "^0.4.0",
    "prettier": "^3.8.1",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.0.0",
    "vite": "^8.0.12",
    "vitest": "^4.1.6"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "paths": {
      "@/*": ["./src/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts", "tests/**/*.tsx"],
  "exclude": ["node_modules", "dist", "build"]
}
```

- [ ] **Step 3: Create vite.config.ts**

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import wyw from '@wyw-in-js/vite';
import path from 'node:path';

function honoApiPlugin() {
  return {
    name: 'hono-api',
    configureServer(server: any) {
      server.middlewares.use('/api', async (req: any, res: any) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          });
          res.end();
          return;
        }
        const { default: app } = await import('./src/api-app.ts');
        const url = new URL(req.url || '/', `http://${req.headers.host}`);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const body = req.method !== 'GET' && req.method !== 'HEAD'
          ? await new Promise<Buffer>((resolve) => {
              const chunks: Buffer[] = [];
              req.on('data', (chunk: Buffer) => chunks.push(chunk));
              req.on('end', () => resolve(Buffer.concat(chunks)));
            })
          : undefined;
        const request = new Request(url.toString(), {
          method: req.method,
          headers,
          body,
        });
        const response = await app.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          const pump = async () => {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(value);
            await pump();
          };
          await pump();
        } else {
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), wyw(), honoApiPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: './dist/client',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          router: ['react-router-dom'],
        },
      },
    },
  },
  server: {
    port: 3000,
  },
  ssr: {
    noExternal: ['hono'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
});
```

- [ ] **Step 4: Create index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Open Novel</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create src/main.tsx**

```typescript
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 6: Create placeholder App.tsx**

```typescript
export default function App() {
  return <div>Open Novel</div>;
}
```

- [ ] **Step 7: Install dependencies**

Run: `pnpm install`

- [ ] **Step 8: Verify dev server starts**

Run: `pnpm dev`
Expected: Server starts on http://localhost:3000, page shows "Open Novel"

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: project scaffolding with Vite + React + TypeScript"
```

---

## Task 2: Hono API Setup

**Files:**
- Create: `src/api-app.ts`

- [ ] **Step 1: Create src/api-app.ts**

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ status: 'ok' }));

export default app;
```

- [ ] **Step 2: Verify API works**

Run: `pnpm dev`
Then: `curl http://localhost:3000/api/health`
Expected: `{"status":"ok"}`

- [ ] **Step 3: Commit**

```bash
git add src/api-app.ts
git commit -m "feat: basic Hono API with health endpoint"
```

---

## Task 3: Database Setup (Drizzle + PGlite)

**Files:**
- Create: `src/db/drizzle.ts`
- Create: `src/db/schema.ts`
- Create: `drizzle.config.ts`

- [ ] **Step 1: Create src/db/schema.ts**

```typescript
import { pgTable, varchar, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const projects = pgTable('projects', {
  id: varchar('id', { length: 25 }).primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  genre: varchar('genre', { length: 50 }).notNull().default('general'),
  targetWords: integer('target_words').notNull().default(100000),
  chapterCount: integer('chapter_count').notNull().default(20),
  theme: varchar('theme', { length: 500 }),
  perspective: varchar('perspective', { length: 50 }).notNull().default('third-person'),
  currentStage: varchar('current_stage', { length: 50 }).notNull().default('concept'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('projects_created_at_idx').on(table.createdAt),
]);

export const chapters = pgTable('chapters', {
  id: varchar('id', { length: 25 }).primaryKey(),
  projectId: varchar('project_id', { length: 25 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  title: varchar('title', { length: 200 }),
  wordCount: integer('word_count').notNull().default(0),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  uniqueIndex('chapters_project_number_idx').on(table.projectId, table.number),
]);

export const conversations = pgTable('conversations', {
  id: varchar('id', { length: 25 }).primaryKey(),
  projectId: varchar('project_id', { length: 25 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  agentId: varchar('agent_id', { length: 50 }).notNull(),
  stage: varchar('stage', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export const messages = pgTable('messages', {
  id: varchar('id', { length: 25 }).primaryKey(),
  conversationId: varchar('conversation_id', { length: 25 }).notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 20 }).notNull(),
  content: varchar('content', { length: 100000 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export const runs = pgTable('runs', {
  id: varchar('id', { length: 50 }).primaryKey(),
  conversationId: varchar('conversation_id', { length: 25 }).references(() => conversations.id, { onDelete: 'set null' }),
  agent: varchar('agent', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});

export const userSettings = pgTable('user_settings', {
  id: varchar('id', { length: 25 }).primaryKey(),
  key: varchar('key', { length: 100 }).notNull(),
  value: varchar('value', { length: 5000 }).notNull(),
}, (table) => [
  uniqueIndex('user_settings_key_idx').on(table.key),
]);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Chapter = typeof chapters.$inferSelect;
export type NewChapter = typeof chapters.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type UserSetting = typeof userSettings.$inferSelect;
```

- [ ] **Step 2: Create src/db/drizzle.ts**

```typescript
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
```

- [ ] **Step 3: Create drizzle.config.ts**

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
});
```

- [ ] **Step 4: Create src/utils/id.ts**

```typescript
let counter = 0;

export function generateId(prefix: string): string {
  counter = (counter + 1) % 10000;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}${ts}${rand}${counter.toString().padStart(4, '0')}`;
}
```

- [ ] **Step 5: Wire DB init into api-app.ts**

Update `src/api-app.ts`:
```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ensureDbReady } from './db/drizzle';

const app = new Hono();

let dbReady = false;
app.use('/api/*', async (c, next) => {
  if (!dbReady) {
    await ensureDbReady();
    dbReady = true;
  }
  return next();
});

app.use('/api/*', cors());

app.get('/api/health', (c) => c.json({ status: 'ok' }));

export default app;
```

- [ ] **Step 6: Verify DB initializes**

Run: `pnpm dev`
Then: `curl http://localhost:3000/api/health`
Expected: `{"status":"ok"}` and `data/pglite/` directory is created

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: database setup with Drizzle ORM and PGlite"
```

---

## Task 4: Project CRUD API

**Files:**
- Create: `src/api/routes/projects.ts`
- Modify: `src/api-app.ts`

- [ ] **Step 1: Create src/api/routes/projects.ts**

```typescript
import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { generateId } from '../../utils/id';

const projectsRouter = new Hono();

projectsRouter.get('/', async (c) => {
  const all = await db.select().from(projects).orderBy(desc(projects.createdAt));
  return c.json({ projects: all });
});

projectsRouter.post('/', async (c) => {
  const body = await c.req.json();
  const id = generateId('proj_');
  const [project] = await db.insert(projects).values({
    id,
    title: body.title || '未命名项目',
    genre: body.genre || 'general',
    targetWords: body.targetWords || 100000,
    chapterCount: body.chapterCount || 20,
    theme: body.theme || null,
    perspective: body.perspective || 'third-person',
  }).returning();
  return c.json({ project }, 201);
});

projectsRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);
  return c.json({ project });
});

projectsRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [updated] = await db.update(projects)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(projects.id, id))
    .returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ project: updated });
});

projectsRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(projects).where(eq(projects.id, id));
  return c.json({ ok: true });
});

export default projectsRouter;
```

- [ ] **Step 2: Mount route in api-app.ts**

Add to `src/api-app.ts`:
```typescript
import projectsRouter from './api/routes/projects';
app.route('/api/projects', projectsRouter);
```

- [ ] **Step 3: Test CRUD**

Run: `pnpm dev`
```bash
# Create
curl -X POST http://localhost:3000/api/projects -H 'Content-Type: application/json' -d '{"title":"测试小说"}'
# List
curl http://localhost:3000/api/projects
# Get
curl http://localhost:3000/api/projects/<id>
# Update
curl -X PATCH http://localhost:3000/api/projects/<id> -H 'Content-Type: application/json' -d '{"title":"新标题"}'
# Delete
curl -X DELETE http://localhost:3000/api/projects/<id>
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: project CRUD API"
```

---

## Task 5: Chapter & Settings API

**Files:**
- Create: `src/api/routes/chapters.ts`
- Create: `src/api/routes/settings.ts`
- Modify: `src/api-app.ts`

- [ ] **Step 1: Create src/api/routes/chapters.ts**

```typescript
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { chapters } from '../../db/schema';
import { generateId } from '../../utils/id';

const chaptersRouter = new Hono();

chaptersRouter.get('/', async (c) => {
  const projectId = c.req.param('projectId');
  const all = await db.select().from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(chapters.number);
  return c.json({ chapters: all });
});

chaptersRouter.get('/:num', async (c) => {
  const projectId = c.req.param('projectId');
  const num = parseInt(c.req.param('num'));
  const [chapter] = await db.select().from(chapters)
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .limit(1);
  if (!chapter) return c.json({ error: 'Not found' }, 404);
  return c.json({ chapter });
});

chaptersRouter.patch('/:num', async (c) => {
  const projectId = c.req.param('projectId');
  const num = parseInt(c.req.param('num'));
  const body = await c.req.json();
  const [updated] = await db.update(chapters)
    .set({ ...body, updatedAt: new Date() })
    .where(and(eq(chapters.projectId, projectId), eq(chapters.number, num)))
    .returning();
  if (!updated) return c.json({ error: 'Not found' }, 404);
  return c.json({ chapter: updated });
});

export default chaptersRouter;
```

- [ ] **Step 2: Create src/api/routes/settings.ts**

```typescript
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { userSettings } from '../../db/schema';
import { generateId } from '../../utils/id';

const settingsRouter = new Hono();

settingsRouter.get('/', async (c) => {
  const all = await db.select().from(userSettings);
  const settings: Record<string, string> = {};
  for (const s of all) settings[s.key] = s.value;
  return c.json({ settings });
});

settingsRouter.patch('/', async (c) => {
  const body = await c.req.json();
  for (const [key, value] of Object.entries(body)) {
    const existing = await db.select().from(userSettings).where(eq(userSettings.key, key)).limit(1);
    if (existing.length > 0) {
      await db.update(userSettings).set({ value: String(value) }).where(eq(userSettings.key, key));
    } else {
      await db.insert(userSettings).values({ id: generateId('set_'), key, value: String(value) });
    }
  }
  return c.json({ ok: true });
});

export default settingsRouter;
```

- [ ] **Step 3: Mount routes in api-app.ts**

```typescript
import chaptersRouter from './api/routes/chapters';
import settingsRouter from './api/routes/settings';
app.route('/api/projects/:projectId/chapters', chaptersRouter);
app.route('/api/settings', settingsRouter);
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: chapter and settings API routes"
```

---

## Task 6: Agent System — Types & Registry

**Files:**
- Create: `src/agent/types.ts`
- Create: `src/agent/registry.ts`

- [ ] **Step 1: Create src/agent/types.ts**

```typescript
export type RuntimeModelOption = { id: string; label: string };

export type RuntimeBuildOptions = {
  model?: string | null;
};

export type RuntimeAgentDef = {
  id: string;
  name: string;
  bin: string;
  versionArgs: string[];
  fallbackModels: RuntimeModelOption[];
  buildArgs: (prompt: string, extraAllowedDirs?: string[], options?: RuntimeBuildOptions) => string[];
  streamFormat: string;
  fallbackBins?: string[];
  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';
  installUrl?: string;
  docsUrl?: string;
};

export type DetectedAgent = Omit<RuntimeAgentDef, 'buildArgs' | 'fallbackModels' | 'fallbackBins'> & {
  models: RuntimeModelOption[];
  available: boolean;
  path?: string;
  version?: string | null;
};

export type StreamEvent = {
  type: 'status' | 'text_delta' | 'thinking_delta' | 'tool_use' | 'tool_result' | 'usage' | 'error' | 'raw';
  [key: string]: unknown;
};
```

- [ ] **Step 2: Create src/agent/registry.ts**

```typescript
import type { RuntimeAgentDef } from './types';

export const claudeAgentDef: RuntimeAgentDef = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  fallbackBins: ['openclaude'],
  versionArgs: ['--version'],
  fallbackModels: [
    { id: 'default', label: 'Default' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' },
  ],
  buildArgs: (prompt, extraAllowedDirs = [], options = {}) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    const dirs = extraAllowedDirs.filter((d) => typeof d === 'string' && d.length > 0);
    if (dirs.length > 0) args.push('--add-dir', ...dirs);
    args.push('--permission-mode', 'bypassPermissions');
    return args;
  },
  promptViaStdin: true,
  promptInputFormat: 'stream-json',
  streamFormat: 'claude-stream-json',
  installUrl: 'https://docs.anthropic.com/en/docs/claude-code',
};

export const opencodeAgentDef: RuntimeAgentDef = {
  id: 'opencode',
  name: 'OpenCode',
  bin: 'opencode',
  versionArgs: ['--version'],
  fallbackModels: [{ id: 'default', label: 'Default' }],
  buildArgs: (prompt, extraAllowedDirs = []) => {
    const args = ['--prompt', prompt, '--non-interactive'];
    const dirs = extraAllowedDirs.filter((d) => typeof d === 'string' && d.length > 0);
    if (dirs.length > 0) args.push('--add-dir', ...dirs);
    return args;
  },
  streamFormat: 'json-event-stream',
  installUrl: 'https://github.com/opencode-ai/opencode',
};

export const AGENT_DEFS: RuntimeAgentDef[] = [
  claudeAgentDef,
  opencodeAgentDef,
];

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((a) => a.id === id) || null;
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: agent types and registry with Claude + OpenCode definitions"
```

---

## Task 7: Agent Detection

**Files:**
- Create: `src/agent/executables.ts`
- Create: `src/agent/detection.ts`

- [ ] **Step 1: Create src/agent/executables.ts**

```typescript
import { existsSync, accessSync, constants } from 'node:fs';
import { delimiter } from 'node:path';
import path from 'node:path';
import type { RuntimeAgentDef } from './types';

export function resolveOnPath(bin: string): string | null {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      if (existsSync(full)) {
        try {
          accessSync(full, constants.X_OK);
          return full;
        } catch { /* not executable */ }
      }
    }
  }
  return null;
}

export function resolveAgentExecutable(def: RuntimeAgentDef): string | null {
  const candidates = [def.bin, ...(def.fallbackBins || [])];
  for (const bin of candidates) {
    const resolved = resolveOnPath(bin);
    if (resolved) return resolved;
  }
  return null;
}
```

- [ ] **Step 2: Create src/agent/detection.ts**

```typescript
import { execFile } from 'node:child_process';
import { AGENT_DEFS } from './registry';
import { resolveAgentExecutable } from './executables';
import type { DetectedAgent, RuntimeAgentDef } from './types';

function execProbe(bin: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

async function probe(def: RuntimeAgentDef): Promise<DetectedAgent> {
  const resolved = resolveAgentExecutable(def);
  if (!resolved) {
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      versionArgs: def.versionArgs,
      buildArgs: def.buildArgs,
      streamFormat: def.streamFormat,
      promptViaStdin: def.promptViaStdin,
      promptInputFormat: def.promptInputFormat,
      installUrl: def.installUrl,
      docsUrl: def.docsUrl,
      models: def.fallbackModels,
      available: false,
    };
  }
  try {
    const stdout = await execProbe(resolved, def.versionArgs);
    const version = stdout.trim().split('\n')[0] || null;
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      versionArgs: def.versionArgs,
      buildArgs: def.buildArgs,
      streamFormat: def.streamFormat,
      promptViaStdin: def.promptViaStdin,
      promptInputFormat: def.promptInputFormat,
      installUrl: def.installUrl,
      docsUrl: def.docsUrl,
      models: def.fallbackModels,
      available: true,
      path: resolved,
      version,
    };
  } catch {
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      versionArgs: def.versionArgs,
      buildArgs: def.buildArgs,
      streamFormat: def.streamFormat,
      promptViaStdin: def.promptViaStdin,
      promptInputFormat: def.promptInputFormat,
      installUrl: def.installUrl,
      docsUrl: def.docsUrl,
      models: def.fallbackModels,
      available: false,
      path: resolved,
    };
  }
}

export async function detectAgents(): Promise<DetectedAgent[]> {
  return Promise.all(AGENT_DEFS.map((def) => probe(def)));
}
```

- [ ] **Step 3: Create src/api/routes/agents.ts**

```typescript
import { Hono } from 'hono';
import { detectAgents } from '../../agent/detection';
import { getAgentDef } from '../../agent/registry';

const agentsRouter = new Hono();

agentsRouter.get('/', async (c) => {
  const agents = await detectAgents();
  return c.json({ agents });
});

agentsRouter.get('/:id/models', async (c) => {
  const def = getAgentDef(c.req.param('id'));
  if (!def) return c.json({ error: 'Not found' }, 404);
  return c.json({ models: def.fallbackModels });
});

export default agentsRouter;
```

- [ ] **Step 4: Mount in api-app.ts**

```typescript
import agentsRouter from './api/routes/agents';
app.route('/api/agents', agentsRouter);
```

- [ ] **Step 5: Test agent detection**

Run: `pnpm dev`
Then: `curl http://localhost:3000/api/agents`
Expected: List of agents with `available: true/false` based on what's installed

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: agent detection system"
```

---

## Task 8: Agent Stream Parser

**Files:**
- Create: `src/agent/stream-parser.ts`

- [ ] **Step 1: Create src/agent/stream-parser.ts**

Adapted from open-design's `claude-stream.ts`:

```typescript
import type { StreamEvent } from './types';

type EventSink = (event: StreamEvent) => void;
type BlockState = { type?: unknown; name?: unknown; id?: unknown; input: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createClaudeStreamHandler(onEvent: EventSink) {
  let buffer = '';
  const blocks = new Map<string, BlockState>();
  const streamedToolUseIds = new Set<string>();
  let currentMessageId: string | null = null;
  const textStreamed = new Set<string>();

  function blockKey(index: unknown): string {
    return `${currentMessageId ?? 'anon'}:${index}`;
  }

  function feed(chunk: string) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { handleObject(JSON.parse(line)); }
      catch { onEvent({ type: 'raw', line }); }
    }
  }

  function flush() {
    const rem = buffer.trim();
    buffer = '';
    if (!rem) return;
    try { handleObject(JSON.parse(rem)); }
    catch { onEvent({ type: 'raw', line: rem }); }
  }

  function handleObject(obj: unknown) {
    if (!isRecord(obj)) return;

    if (obj.type === 'system' && obj.subtype === 'init') {
      onEvent({ type: 'status', label: 'initializing', model: obj.model ?? null });
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'status') {
      onEvent({ type: 'status', label: obj.status ?? 'working' });
      return;
    }
    if (obj.type === 'stream_event' && isRecord(obj.event)) {
      handleStreamEvent(obj.event);
      return;
    }
    if (obj.type === 'assistant' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      currentMessageId = typeof obj.message.id === 'string' ? obj.message.id : currentMessageId;
      const msgId = typeof obj.message.id === 'string' ? obj.message.id : null;
      const alreadyStreamed = msgId ? textStreamed.has(msgId) : false;
      for (const block of obj.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_use') {
          if (typeof block.id === 'string' && streamedToolUseIds.has(block.id)) {
            streamedToolUseIds.delete(block.id);
            continue;
          }
          onEvent({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? null });
        } else if (!alreadyStreamed && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          onEvent({ type: 'text_delta', delta: block.text });
        } else if (!alreadyStreamed && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
          onEvent({ type: 'thinking_delta', delta: block.thinking });
        }
      }
      return;
    }
    if (obj.type === 'result') {
      onEvent({ type: 'usage', usage: obj.usage ?? null, costUsd: obj.total_cost_usd ?? null });
      return;
    }
  }

  function handleStreamEvent(ev: Record<string, unknown>) {
    if (ev.type === 'message_start') {
      currentMessageId = isRecord(ev.message) && typeof ev.message.id === 'string' ? ev.message.id : null;
      return;
    }
    if (ev.type === 'content_block_start' && isRecord(ev.content_block)) {
      blocks.set(blockKey(ev.index), { type: ev.content_block.type, name: ev.content_block.name, id: ev.content_block.id, input: '' });
      return;
    }
    if (ev.type === 'content_block_delta' && isRecord(ev.delta)) {
      const state = blocks.get(blockKey(ev.index));
      const delta = ev.delta;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'text_delta', delta: delta.text });
        return;
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'thinking_delta', delta: delta.thinking });
        return;
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        if (state && state.type === 'tool_use') state.input += delta.partial_json;
        return;
      }
    }
    if (ev.type === 'content_block_stop') {
      const key = blockKey(ev.index);
      const state = blocks.get(key);
      if (state && state.type === 'tool_use' && typeof state.id === 'string' && state.input.trim()) {
        try {
          onEvent({ type: 'tool_use', id: state.id, name: state.name, input: JSON.parse(state.input) });
          streamedToolUseIds.add(state.id);
        } catch { /* malformed JSON, skip */ }
      }
      blocks.delete(key);
    }
  }

  return { feed, flush };
}

export function createJsonEventHandler(onEvent: EventSink) {
  let buffer = '';
  return {
    feed(chunk: string) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          onEvent({ type: obj.type || 'raw', ...obj });
        } catch {
          onEvent({ type: 'raw', line });
        }
      }
    },
    flush() {
      const rem = buffer.trim();
      buffer = '';
      if (!rem) return;
      try { onEvent({ type: 'raw', ...JSON.parse(rem) }); }
      catch { onEvent({ type: 'raw', line: rem }); }
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: agent stream parser (Claude + JSON event formats)"
```

---

## Task 9: Agent Run Lifecycle

**Files:**
- Create: `src/agent/run.ts`
- Create: `src/agent/launch.ts`

- [ ] **Step 1: Create src/agent/launch.ts**

```typescript
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { RuntimeAgentDef } from './types';
import { resolveAgentExecutable } from './executables';

export interface AgentProcess {
  child: ReturnType<typeof spawn>;
  stdin: NodeJS.WritableStream | null;
}

export function launchAgent(
  def: RuntimeAgentDef,
  prompt: string,
  cwd: string,
  extraDirs: string[] = [],
  model?: string,
): AgentProcess {
  const bin = resolveAgentExecutable(def);
  if (!bin) throw new Error(`Agent ${def.id} not found on PATH`);

  const args = def.buildArgs(prompt, extraDirs, { model });
  const env = { ...process.env };
  const binDir = path.dirname(bin);
  env.PATH = `${binDir}:${env.PATH}`;

  const child = spawn(args[0], args.slice(1), {
    cwd,
    env,
    stdio: [def.promptViaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  if (def.promptViaStdin && def.promptInputFormat === 'stream-json' && child.stdin) {
    const msg = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    child.stdin.write(msg + '\n');
    // Keep stdin open for interactive tool results
  } else if (def.promptViaStdin && child.stdin) {
    child.stdin.write(prompt);
    child.stdin.end();
  }

  return { child, stdin: child.stdin };
}
```

- [ ] **Step 2: Create src/agent/run.ts**

```typescript
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from './types';

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface Run {
  id: string;
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
  status: RunStatus;
  events: Array<{ id: number; event: string; data: unknown; timestamp: number }>;
  nextEventId: number;
  clients: Set<(event: string, data: unknown, id: number) => void>;
  child: ReturnType<typeof import('node:child_process').spawn> | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  cancelRequested: boolean;
}

const runs = new Map<string, Run>();

export function createRun(meta: { projectId: string; agentId: string; skillId: string; stage: string }): Run {
  const run: Run = {
    id: randomUUID(),
    projectId: meta.projectId,
    agentId: meta.agentId,
    skillId: meta.skillId,
    stage: meta.stage,
    status: 'queued',
    events: [],
    nextEventId: 1,
    clients: new Set(),
    child: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
    cancelRequested: false,
  };
  runs.set(run.id, run);
  return run;
}

export function getRun(id: string): Run | null {
  return runs.get(id) ?? null;
}

export function emitEvent(run: Run, event: string, data: unknown) {
  const id = run.nextEventId++;
  const record = { id, event, data, timestamp: Date.now() };
  run.events.push(record);
  if (run.events.length > 2000) run.events.splice(0, run.events.length - 2000);
  run.updatedAt = Date.now();
  for (const send of run.clients) send(event, data, id);
}

export function finishRun(run: Run, status: RunStatus) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.status = status;
  run.updatedAt = Date.now();
  emitEvent(run, 'end', { status });
  run.clients.clear();
  setTimeout(() => runs.delete(run.id), 30 * 60 * 1000).unref?.();
}

export function cancelRun(run: Run) {
  if (['succeeded', 'failed', 'canceled'].includes(run.status)) return;
  run.cancelRequested = true;
  if (run.child && !run.child.killed) {
    run.child.kill('SIGTERM');
  } else {
    finishRun(run, 'canceled');
  }
}

export function subscribeRun(run: Run, send: (event: string, data: unknown, id: number) => void) {
  run.clients.add(send);
}
```

- [ ] **Step 3: Create src/api/routes/runs.ts**

```typescript
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createRun, getRun, emitEvent, finishRun, cancelRun, subscribeRun } from '../../agent/run';
import { getAgentDef } from '../../agent/registry';
import { detectAgents } from '../../agent/detection';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler, createJsonEventHandler } from '../../agent/stream-parser';
import { db } from '../../db/drizzle';
import { conversations, messages, runs as runsTable } from '../../db/schema';
import { generateId } from '../../utils/id';

const runsRouter = new Hono();

runsRouter.post('/', async (c) => {
  const body = await c.req.json();
  const { projectId, agentId, skillId, stage, message } = body;

  const def = getAgentDef(agentId);
  if (!def) return c.json({ error: 'Agent not found' }, 404);

  const agents = await detectAgents();
  const detected = agents.find((a) => a.id === agentId);
  if (!detected?.available) return c.json({ error: 'Agent not available' }, 400);

  // Create conversation and message in DB
  const convId = generateId('conv_');
  await db.insert(conversations).values({ id: convId, projectId, agentId, stage });
  const msgId = generateId('msg_');
  await db.insert(messages).values({ id: msgId, conversationId: convId, role: 'user', content: message });

  const run = createRun({ projectId, agentId, skillId, stage });

  // Store run in DB
  await db.insert(runsTable).values({ id: run.id, conversationId: convId, agent: agentId, status: 'running' });

  // Compose prompt (simplified - will be enhanced in Task 14)
  const composedPrompt = message;

  // Launch agent
  const { child } = launchAgent(def, composedPrompt, `./data/projects/${projectId}`);
  run.child = child;
  run.status = 'running';

  // Parse stream
  const handler = def.streamFormat === 'claude-stream-json'
    ? createClaudeStreamHandler((event) => emitEvent(run, 'agent', event))
    : createJsonEventHandler((event) => emitEvent(run, 'agent', event));

  child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => emitEvent(run, 'stderr', { text: chunk.toString() }));

  child.on('close', (code) => {
    handler.flush();
    finishRun(run, code === 0 ? 'succeeded' : 'failed');
    db.update(runsTable).set({ status: run.status, finishedAt: new Date() }).where(eq(runsTable.id, run.id)).execute();
  });

  return c.json({ runId: run.id }, 201);
});

runsRouter.get('/:id/events', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);

  return stream(c, async (streamWriter) => {
    streamWriter.onAbort(() => { /* client disconnected */ });

    // Set SSE headers
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const lastEventId = Number(c.req.header('Last-Event-ID') || 0);

    // Replay missed events
    for (const record of run.events) {
      if (record.id > lastEventId) {
        await streamWriter.write(`id: ${record.id}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`);
      }
    }

    // If already finished, close
    if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
      return;
    }

    // Subscribe for live events
    const send = async (event: string, data: unknown, id: number) => {
      try {
        await streamWriter.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* client disconnected */ }
    };
    subscribeRun(run, send);

    // Keep-alive heartbeat
    const heartbeat = setInterval(async () => {
      try { await streamWriter.write(': keepalive\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 15000);

    streamWriter.onAbort(() => {
      clearInterval(heartbeat);
      run.clients.delete(send);
    });

    // Wait until run finishes
    while (!['succeeded', 'failed', 'canceled'].includes(run.status)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  });
});

runsRouter.post('/:id/tool-result', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json();
  if (run.child?.stdin) {
    const msg = JSON.stringify({
      type: 'tool_result',
      tool_use_id: body.toolUseId,
      content: body.content,
      is_error: body.isError || false,
    });
    run.child.stdin.write(msg + '\n');
  }
  return c.json({ ok: true });
});

runsRouter.delete('/:id', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  cancelRun(run);
  return c.json({ ok: true });
});

// Need to import eq for the DB update
import { eq } from 'drizzle-orm';

export default runsRouter;
```

- [ ] **Step 4: Mount in api-app.ts**

```typescript
import runsRouter from './api/routes/runs';
app.route('/api/runs', runsRouter);
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: agent run lifecycle with SSE streaming"
```

---

## Task 10: Plugin System

**Files:**
- Create: `src/plugins/types.ts`
- Create: `src/plugins/loader.ts`
- Create: `src/plugins/registry.ts`
- Create: `src/api/routes/plugins.ts`

- [ ] **Step 1: Create src/plugins/types.ts**

```typescript
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  stages: string[];
  templates: string[];
  legacyTools?: string[];
}

export interface Plugin {
  id: string;
  manifest: PluginManifest;
  skillContent: string;
  path: string;
}
```

- [ ] **Step 2: Create src/plugins/loader.ts**

```typescript
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { Plugin, PluginManifest } from './types';

export function loadPlugins(dir: string): Plugin[] {
  if (!existsSync(dir)) return [];
  const plugins: Plugin[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(dir, entry.name);
    const manifestPath = path.join(pluginDir, 'open-novel.json');
    const skillPath = path.join(pluginDir, 'SKILL.md');
    if (!existsSync(manifestPath) || !existsSync(skillPath)) continue;
    try {
      const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const skillContent = readFileSync(skillPath, 'utf-8');
      plugins.push({ id: manifest.id, manifest, skillContent, path: pluginDir });
    } catch { /* skip invalid plugins */ }
  }
  return plugins;
}
```

- [ ] **Step 3: Create src/plugins/registry.ts**

```typescript
import path from 'node:path';
import { loadPlugins } from './loader';
import type { Plugin } from './types';

let plugins: Plugin[] = [];

export function initPlugins() {
  const dir = path.resolve(process.cwd(), 'plugins');
  plugins = loadPlugins(dir);
}

export function getPlugins(): Plugin[] {
  return plugins;
}

export function getPlugin(id: string): Plugin | null {
  return plugins.find((p) => p.id === id) || null;
}
```

- [ ] **Step 4: Create src/api/routes/plugins.ts**

```typescript
import { Hono } from 'hono';
import { getPlugins, getPlugin } from '../../plugins/registry';

const pluginsRouter = new Hono();

pluginsRouter.get('/', (c) => {
  const plugins = getPlugins().map((p) => ({
    id: p.id,
    name: p.manifest.name,
    description: p.manifest.description,
    version: p.manifest.version,
    stages: p.manifest.stages,
  }));
  return c.json({ plugins });
});

pluginsRouter.get('/:id', (c) => {
  const plugin = getPlugin(c.req.param('id'));
  if (!plugin) return c.json({ error: 'Not found' }, 404);
  return c.json({
    id: plugin.id,
    manifest: plugin.manifest,
    skillContent: plugin.skillContent,
  });
});

export default pluginsRouter;
```

- [ ] **Step 5: Mount in api-app.ts and init plugins**

```typescript
import pluginsRouter from './api/routes/plugins';
import { initPlugins } from './plugins/registry';

// After DB ready
initPlugins();

app.route('/api/plugins', pluginsRouter);
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: plugin system with SKILL.md + manifest loading"
```

---

## Task 11: Frontend Shell

**Files:**
- Create: `src/styles/global.ts`
- Create: `src/styles/shared.ts`
- Create: `src/App.tsx`
- Create: `src/hooks/useQueryClient.tsx`

- [ ] **Step 1: Create src/styles/global.ts**

```typescript
import { css } from '@linaria/core';

export const globalStyles = css`
  :global() {
    :root {
      --haze-color-primary: #6366f1;
      --haze-color-primary-hover: #4f46e5;
      --haze-color-bg: #ffffff;
      --haze-color-bg-secondary: #f9fafb;
      --haze-color-text: #111827;
      --haze-color-text-secondary: #6b7280;
      --haze-color-border: #e5e7eb;
      --haze-color-error: #ef4444;
      --haze-color-success: #22c55e;
      --haze-color-warning: #f59e0b;
      --haze-font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --haze-font-mono: 'SF Mono', 'Fira Code', monospace;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --haze-color-primary: #818cf8;
        --haze-color-primary-hover: #6366f1;
        --haze-color-bg: #111827;
        --haze-color-bg-secondary: #1f2937;
        --haze-color-text: #f9fafb;
        --haze-color-text-secondary: #9ca3af;
        --haze-color-border: #374151;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--haze-font-sans); background: var(--haze-color-bg); color: var(--haze-color-text); }
    a { color: var(--haze-color-primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
  }
`;
```

- [ ] **Step 2: Create src/styles/shared.ts**

```typescript
import { css } from '@linaria/core';

export const pageContainer = css`
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
`;

export const pageTitle = css`
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 1.5rem;
`;

export const card = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 1.5rem;
`;

export const primaryBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.875rem;
  &:hover { background: var(--haze-color-primary-hover); }
`;

export const input = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  width: 100%;
`;

export const emptyState = css`
  text-align: center;
  padding: 3rem;
  color: var(--haze-color-text-secondary);
`;
```

- [ ] **Step 3: Create src/hooks/useQueryClient.tsx**

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const AppQueryProvider = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
```

- [ ] **Step 4: Create src/App.tsx**

```typescript
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { cx } from '@linaria/core';
import { lightTheme, spacing, typography } from 'haze-ui';
import { ToastContainer } from 'haze-ui';
import { AppQueryProvider } from './hooks/useQueryClient';
import { globalStyles } from './styles/global';

const HomePage = lazy(() => import('./web/pages/HomePage'));
const ProjectPage = lazy(() => import('./web/pages/ProjectPage'));
const SettingsPage = lazy(() => import('./web/pages/SettingsPage'));

export default function App() {
  return (
    <AppQueryProvider>
      <BrowserRouter>
        <div className={cx(globalStyles, lightTheme, spacing, typography)}>
          <ToastContainer />
          <Suspense fallback={<div>Loading...</div>}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/projects/:id" element={<ProjectPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </div>
      </BrowserRouter>
    </AppQueryProvider>
  );
}
```

- [ ] **Step 5: Create placeholder pages**

```typescript
// src/web/pages/HomePage.tsx
export default function HomePage() {
  return <div>Home</div>;
}

// src/web/pages/ProjectPage.tsx
export default function ProjectPage() {
  return <div>Project</div>;
}

// src/web/pages/SettingsPage.tsx
export default function SettingsPage() {
  return <div>Settings</div>;
}
```

- [ ] **Step 6: Verify frontend loads**

Run: `pnpm dev`
Expected: Page shows "Home" at /

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: frontend shell with router, providers, and global styles"
```

---

## Task 12: Home Page (Project List)

**Files:**
- Modify: `src/web/pages/HomePage.tsx`
- Create: `src/hooks/useProject.ts`

- [ ] **Step 1: Create src/hooks/useProject.ts**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await fetch('/api/projects');
      const data = await res.json();
      return data.projects;
    },
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title: string; genre?: string }) => {
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}
```

- [ ] **Step 2: Implement HomePage.tsx**

```typescript
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { css } from '@linaria/core';
import { useProjects, useCreateProject, useDeleteProject } from '@/hooks/useProject';
import { pageContainer, pageTitle, card, primaryBtn, input, emptyState } from '@/styles/shared';

const grid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
`;

const projectCard = css`
  cursor: pointer;
  &:hover { border-color: var(--haze-color-primary); }
`;

const header = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
`;

const genreBadge = css`
  display: inline-block;
  background: var(--haze-color-bg-secondary);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  margin-top: 0.5rem;
`;

export default function HomePage() {
  const navigate = useNavigate();
  const { data: projects, isLoading } = useProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');

  const handleCreate = () => {
    if (!title.trim()) return;
    createProject.mutate({ title: title.trim() }, {
      onSuccess: (data) => {
        setShowCreate(false);
        setTitle('');
        navigate(`/projects/${data.project.id}`);
      },
    });
  };

  return (
    <div className={pageContainer}>
      <div className={header}>
        <h1 className={pageTitle}>我的小说</h1>
        <button className={primaryBtn} onClick={() => setShowCreate(true)}>新建项目</button>
      </div>

      {showCreate && (
        <div className={card} style={{ marginBottom: '1rem' }}>
          <input className={input} placeholder="小说标题" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
          <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
            <button className={primaryBtn} onClick={handleCreate}>创建</button>
            <button onClick={() => setShowCreate(false)}>取消</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className={emptyState}>加载中...</div>
      ) : !projects?.length ? (
        <div className={emptyState}>还没有项目，点击"新建项目"开始创作</div>
      ) : (
        <div className={grid}>
          {projects.map((p: any) => (
            <div key={p.id} className={`${card} ${projectCard}`} onClick={() => navigate(`/projects/${p.id}`)}>
              <h3>{p.title}</h3>
              <span className={genreBadge}>{p.genre}</span>
              <p style={{ marginTop: '0.5rem', color: 'var(--haze-color-text-secondary)', fontSize: '0.875rem' }}>
                {p.chapterCount} 章 · {p.targetWords.toLocaleString()} 字
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: home page with project list and creation"
```

---

## Task 13: Project Workspace Layout

**Files:**
- Modify: `src/web/pages/ProjectPage.tsx`
- Create: `src/web/components/Sidebar.tsx`
- Create: `src/web/components/WorkflowProgress.tsx`

- [ ] **Step 1: Create src/web/components/WorkflowProgress.tsx**

```typescript
import { css } from '@linaria/core';

const stages = [
  { id: 'concept', label: '概念' },
  { id: 'world', label: '世界观' },
  { id: 'characters', label: '角色' },
  { id: 'outline', label: '大纲' },
  { id: 'scenes', label: '场景' },
  { id: 'writing', label: '写作' },
];

const container = css`
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1rem;
`;

const step = css`
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--haze-color-border);
`;

const stepActive = css`
  background: var(--haze-color-primary);
`;

const stepCompleted = css`
  background: var(--haze-color-success);
`;

const labels = css`
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
`;

interface Props {
  currentStage: string;
  onStageClick: (stage: string) => void;
}

export default function WorkflowProgress({ currentStage, onStageClick }: Props) {
  const currentIdx = stages.findIndex((s) => s.id === currentStage);
  return (
    <div>
      <div className={container}>
        {stages.map((s, i) => (
          <div key={s.id} className={`${step} ${i < currentIdx ? stepCompleted : i === currentIdx ? stepActive : ''}`} onClick={() => onStageClick(s.id)} style={{ cursor: 'pointer' }} />
        ))}
      </div>
      <div className={labels}>
        {stages.map((s) => <span key={s.id}>{s.label}</span>)}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create src/web/components/Sidebar.tsx**

```typescript
import { css } from '@linaria/core';

const sidebar = css`
  width: 240px;
  border-right: 1px solid var(--haze-color-border);
  padding: 1rem;
  overflow-y: auto;
  height: 100%;
`;

const navItem = css`
  display: block;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--haze-color-text);
  &:hover { background: var(--haze-color-bg-secondary); text-decoration: none; }
`;

const navItemActive = css`
  background: var(--haze-color-bg-secondary);
  font-weight: 500;
`;

const sectionTitle = css`
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--haze-color-text-secondary);
  margin: 1rem 0 0.5rem;
`;

interface Props {
  activeView: string;
  onViewChange: (view: string) => void;
  chapters: Array<{ number: number; title: string | null }>;
}

export default function Sidebar({ activeView, onViewChange, chapters }: Props) {
  const views = [
    { id: 'dashboard', label: '总览' },
    { id: 'concept', label: '故事概念' },
    { id: 'world', label: '世界观' },
    { id: 'characters', label: '角色' },
    { id: 'outline', label: '大纲' },
    { id: 'scenes', label: '场景' },
    { id: 'foreshadow', label: '伏笔' },
    { id: 'wuxia', label: '武侠' },
  ];

  return (
    <div className={sidebar}>
      <div className={sectionTitle}>文档</div>
      {views.map((v) => (
        <a key={v.id} className={`${navItem} ${activeView === v.id ? navItemActive : ''}`} onClick={() => onViewChange(v.id)}>
          {v.label}
        </a>
      ))}
      <div className={sectionTitle}>章节</div>
      {chapters.map((ch) => (
        <a key={ch.number} className={`${navItem} ${activeView === `chapter-${ch.number}` ? navItemActive : ''}`} onClick={() => onViewChange(`chapter-${ch.number}`)}>
          第{ch.number}章 {ch.title || ''}
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Implement ProjectPage.tsx**

```typescript
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';
import Sidebar from '@/web/components/Sidebar';
import WorkflowProgress from '@/web/components/WorkflowProgress';

const layout = css`
  display: flex;
  height: 100vh;
`;

const main = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const topBar = css`
  padding: 1rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

const content = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
`;

const chatPanel = css`
  width: 400px;
  border-left: 1px solid var(--haze-color-border);
  display: flex;
  flex-direction: column;
`;

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [activeView, setActiveView] = useState('dashboard');

  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      return data.project;
    },
  });

  const { data: chapters } = useQuery({
    queryKey: ['chapters', id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${id}/chapters`);
      const data = await res.json();
      return data.chapters;
    },
  });

  if (!project) return <div>Loading...</div>;

  return (
    <div className={layout}>
      <Sidebar activeView={activeView} onViewChange={setActiveView} chapters={chapters || []} />
      <div className={main}>
        <div className={topBar}>
          <h2>{project.title}</h2>
          <WorkflowProgress currentStage={project.currentStage} onStageClick={setActiveView} />
        </div>
        <div className={content}>
          {/* Views will be rendered here based on activeView */}
          <div>View: {activeView}</div>
        </div>
      </div>
      <div className={chatPanel}>
        {/* Chat panel will be implemented in Task 15 */}
        <div style={{ padding: '1rem' }}>Chat Panel</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: project workspace layout with sidebar and workflow progress"
```

---

## Task 14: Chat Panel with SSE

**Files:**
- Create: `src/web/components/ChatPanel.tsx`
- Create: `src/web/components/AgentMessage.tsx`
- Create: `src/web/hooks/useRun.ts`

- [ ] **Step 1: Create src/web/hooks/useRun.ts**

```typescript
import { useState, useCallback, useRef } from 'react';
import type { StreamEvent } from '@/agent/types';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolUse?: Array<{ id: string; name: string; input: unknown }>;
  thinking?: string;
}

export function useRun() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (params: {
    projectId: string;
    agentId: string;
    skillId: string;
    stage: string;
    message: string;
  }) => {
    setMessages((prev) => [...prev, { role: 'user', content: params.message }]);
    setIsRunning(true);
    setStatus('starting');

    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const { runId } = await res.json();

    const eventSource = new EventSource(`/api/runs/${runId}/events`);
    abortRef.current = new AbortController();

    let assistantContent = '';
    let thinkingContent = '';
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];

    eventSource.onmessage = () => {};
    eventSource.addEventListener('agent', ((e: MessageEvent) => {
      const event: StreamEvent = JSON.parse(e.data);
      switch (event.type) {
        case 'status':
          setStatus(String(event.label));
          break;
        case 'text_delta':
          assistantContent += String(event.delta);
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant') {
              last.content = assistantContent;
            } else {
              updated.push({ role: 'assistant', content: assistantContent, toolUse: [...toolUses], thinking: thinkingContent });
            }
            return updated;
          });
          break;
        case 'thinking_delta':
          thinkingContent += String(event.delta);
          break;
        case 'tool_use':
          toolUses.push({ id: String(event.id), name: String(event.name), input: event.input });
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant') {
              last.toolUse = [...toolUses];
              last.thinking = thinkingContent;
            }
            return updated;
          });
          break;
      }
    }) as EventListener);

    eventSource.addEventListener('end', () => {
      eventSource.close();
      setIsRunning(false);
      setStatus('');
      if (assistantContent) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            last.content = assistantContent;
            last.toolUse = [...toolUses];
            last.thinking = thinkingContent;
          }
          return updated;
        });
      }
    });

    eventSource.onerror = () => {
      eventSource.close();
      setIsRunning(false);
      setStatus('error');
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsRunning(false);
  }, []);

  return { messages, isRunning, status, sendMessage, cancel };
}
```

- [ ] **Step 2: Create src/web/components/AgentMessage.tsx**

```typescript
import { css } from '@linaria/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ToolCard from './ToolCard';

const messageBlock = css`
  margin-bottom: 1rem;
`;

const userMsg = css`
  background: var(--haze-color-primary);
  color: white;
  padding: 0.75rem 1rem;
  border-radius: 12px 12px 0 12px;
  max-width: 80%;
  margin-left: auto;
`;

const assistantMsg = css`
  background: var(--haze-color-bg-secondary);
  padding: 0.75rem 1rem;
  border-radius: 12px 12px 12px 0;
  max-width: 90%;
`;

const thinkingBlock = css`
  background: var(--haze-color-bg);
  border: 1px dashed var(--haze-color-border);
  padding: 0.5rem;
  border-radius: 6px;
  margin-bottom: 0.5rem;
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
`;

interface Props {
  role: 'user' | 'assistant';
  content: string;
  toolUse?: Array<{ id: string; name: string; input: unknown }>;
  thinking?: string;
}

export default function AgentMessage({ role, content, toolUse, thinking }: Props) {
  return (
    <div className={messageBlock}>
      <div className={role === 'user' ? userMsg : assistantMsg}>
        {thinking && <details className={thinkingBlock}><summary>思考过程</summary><pre>{thinking}</pre></details>}
        {role === 'assistant' ? <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown> : content}
        {toolUse?.map((t) => <ToolCard key={t.id} name={t.name} input={t.input} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create src/web/components/ToolCard.tsx**

```typescript
import { css } from '@linaria/core';

const card = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem;
  margin-top: 0.5rem;
  font-size: 0.8rem;
`;

const toolName = css`
  font-weight: 600;
  color: var(--haze-color-primary);
`;

interface Props {
  name: string;
  input: unknown;
}

export default function ToolCard({ name, input }: Props) {
  return (
    <div className={card}>
      <span className={toolName}>{name}</span>
      <pre style={{ marginTop: '0.25rem', fontSize: '0.75rem', overflow: 'auto' }}>
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Create src/web/components/ChatPanel.tsx**

```typescript
import { useState, useRef, useEffect } from 'react';
import { css } from '@linaria/core';
import { useRun } from '@/web/hooks/useRun';
import AgentMessage from './AgentMessage';

const panel = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const messages = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
`;

const inputArea = css`
  border-top: 1px solid var(--haze-color-border);
  padding: 0.75rem;
  display: flex;
  gap: 0.5rem;
`;

const textarea = css`
  flex: 1;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.5rem;
  resize: none;
  font-family: inherit;
  font-size: 0.875rem;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
`;

const sendBtn = css`
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

interface Props {
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
}

export default function ChatPanel({ projectId, agentId, skillId, stage }: Props) {
  const { messages: chatMessages, isRunning, sendMessage } = useRun();
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleSend = () => {
    if (!input.trim() || isRunning) return;
    sendMessage({ projectId, agentId, skillId, stage, message: input.trim() });
    setInput('');
  };

  return (
    <div className={panel}>
      <div className={messages}>
        {chatMessages.map((msg, i) => (
          <AgentMessage key={i} role={msg.role} content={msg.content} toolUse={msg.toolUse} thinking={msg.thinking} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className={inputArea}>
        <textarea className={textarea} rows={2} placeholder="输入消息..." value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())} />
        <button className={sendBtn} onClick={handleSend} disabled={isRunning}>发送</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire ChatPanel into ProjectPage**

Update `src/web/pages/ProjectPage.tsx` to import and render ChatPanel.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: chat panel with SSE streaming and markdown rendering"
```

---

## Task 15: Editor Panel

**Files:**
- Create: `src/web/components/EditorPanel.tsx`
- Create: `src/hooks/useChapters.ts`

- [ ] **Step 1: Create src/hooks/useChapters.ts**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export function useChapter(projectId: string, num: number) {
  return useQuery({
    queryKey: ['chapter', projectId, num],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters/${num}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.chapter;
    },
  });
}

export function useUpdateChapter(projectId: string, num: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title?: string; content?: string; wordCount?: number }) => {
      const res = await fetch(`/api/projects/${projectId}/chapters/${num}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chapter', projectId, num] }),
  });
}
```

- [ ] **Step 2: Create src/web/components/EditorPanel.tsx**

```typescript
import { useState, useEffect, useRef } from 'react';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';

const editorContainer = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const editorToolbar = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
`;

const textarea = css`
  flex: 1;
  border: none;
  padding: 1rem;
  resize: none;
  font-family: var(--haze-font-mono);
  font-size: 0.9rem;
  line-height: 1.6;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  &:focus { outline: none; }
`;

interface Props {
  projectId: string;
  chapterNum: number;
}

export default function EditorPanel({ projectId, chapterNum }: Props) {
  const { data: chapter } = useQuery({
    queryKey: ['chapter-content', projectId, chapterNum],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterNum}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.chapter;
    },
  });

  const [content, setContent] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (chapter?.content) setContent(chapter.content);
  }, [chapter]);

  useEffect(() => {
    // Count Chinese chars + English words
    const chinese = (content.match(/[一-鿿]/g) || []).length;
    const english = (content.match(/[a-zA-Z]+/g) || []).length;
    setWordCount(chinese + english);
  }, [content]);

  const handleChange = (value: string) => {
    setContent(value);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(`/api/projects/${projectId}/chapters/${chapterNum}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value, wordCount }),
      });
    }, 1000);
  };

  return (
    <div className={editorContainer}>
      <div className={editorToolbar}>
        <span>第 {chapterNum} 章 {chapter?.title || ''}</span>
        <span>{wordCount} 字</span>
      </div>
      <textarea className={textarea} value={content} onChange={(e) => handleChange(e.target.value)} placeholder="开始写作..." />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: editor panel with auto-save and word count"
```

---

## Task 16: Visualization Views

**Files:**
- Create: `src/web/components/views/DashboardView.tsx`
- Create: `src/web/components/views/ConceptView.tsx`
- Create: `src/web/components/views/WorldView.tsx`
- Create: `src/web/components/views/CharacterView.tsx`
- Create: `src/web/components/views/OutlineView.tsx`
- Create: `src/web/components/views/SceneView.tsx`
- Create: `src/web/components/views/ForeshadowView.tsx`
- Create: `src/web/components/views/WuxiaView.tsx`

- [ ] **Step 1: Create src/web/components/views/DashboardView.tsx**

```typescript
import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';

const grid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
`;

const statCard = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
`;

const statValue = css`
  font-size: 2rem;
  font-weight: 700;
  color: var(--haze-color-primary);
`;

const statLabel = css`
  font-size: 0.875rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.25rem;
`;

interface Props {
  projectId: string;
}

export default function DashboardView({ projectId }: Props) {
  const { data: project } = useQuery({ queryKey: ['project', projectId] });
  const { data: chapters } = useQuery({ queryKey: ['chapters', projectId] });

  const totalWords = chapters?.reduce((sum: number, ch: any) => sum + (ch.wordCount || 0), 0) || 0;
  const completedChapters = chapters?.filter((ch: any) => ch.status === 'completed').length || 0;

  return (
    <div>
      <h3>总览</h3>
      <div className={grid}>
        <div className={statCard}>
          <div className={statValue}>{totalWords.toLocaleString()}</div>
          <div className={statLabel">总字数</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{chapters?.length || 0}</div>
          <div className={statLabel}>总章数</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{completedChapters}</div>
          <div className={statLabel}>已完成</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{project?.currentStage || '-'}</div>
          <div className={statLabel}>当前阶段</div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create src/web/components/views/ConceptView.tsx**

```typescript
import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  projectId: string;
}

export default function ConceptView({ projectId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['novel-file', projectId, 'concept'],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files/.novel/concept.md`);
      if (!res.ok) return null;
      return res.text();
    },
  });

  if (isLoading) return <div>加载中...</div>;
  if (!data) return <div>尚未创建故事概念。在聊天面板中输入 /concept 开始。</div>;

  return (
    <div>
      <h3>故事概念</h3>
      <Markdown remarkPlugins={[remarkGfm]}>{data}</Markdown>
    </div>
  );
}
```

- [ ] **Step 3: Create remaining view stubs**

Each view follows the same pattern — fetch the corresponding `.novel/` file and render with Markdown.

```typescript
// src/web/components/views/WorldView.tsx
// Fetches .novel/world-building.md

// src/web/components/views/CharacterView.tsx
// Fetches .novel/characters/profiles.md and .novel/characters/*.md
// Renders character cards

// src/web/components/views/OutlineView.tsx
// Fetches .novel/outline-brief.md and .novel/outline-detailed.md

// src/web/components/views/SceneView.tsx
// Fetches .novel/scenes.md

// src/web/components/views/ForeshadowView.tsx
// Fetches .novel/foreshadow.json, renders kanban board

// src/web/components/views/WuxiaView.tsx
// Fetches .novel/wuxia/*.md if they exist
```

- [ ] **Step 4: Add file serving endpoint to API**

Add to `src/api-app.ts`:
```typescript
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

app.get('/api/projects/:id/files/*', async (c) => {
  const id = c.req.param('id');
  const filePath = c.req.path.replace(`/api/projects/${id}/files/`, '');
  const fullPath = path.resolve('./data/projects', id, filePath);
  try {
    const content = await readFile(fullPath, 'utf-8');
    return c.text(content);
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});
```

- [ ] **Step 5: Wire views into ProjectPage**

Update ProjectPage to render the appropriate view based on `activeView`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: visualization views for all story elements"
```

---

## Task 17: Prompt Composition

**Files:**
- Create: `src/prompts/compose.ts`

- [ ] **Step 1: Create src/prompts/compose.ts**

```typescript
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { getPlugin } from '../plugins/registry';

interface ComposeOptions {
  skillId: string;
  stage: string;
  userMessage: string;
  projectDir: string;
}

export function composePrompt({ skillId, stage, userMessage, projectDir }: ComposeOptions): string {
  const plugin = getPlugin(skillId);
  if (!plugin) return userMessage;

  const parts: string[] = [];

  // Base system instructions
  parts.push(`# Open Novel - AI 小说创作助手

你是一个专业的小说创作助手。你通过阅读和写作文件来帮助用户创作小说。

## 工作目录
所有小说文件都在 .novel/ 目录下。使用你的文件工具（Read, Write, Edit）来操作这些文件。

## 当前阶段: ${stage}
`);

  // Inject skill content
  parts.push(plugin.skillContent);

  // Stage-specific instructions
  const stageInstructions: Record<string, string> = {
    concept: '现在处于概念设计阶段。帮助用户设计故事的核心概念：一句话梗概、五句话简介、核心冲突、道德前提、两难困境。',
    world: '现在处于世界观构建阶段。帮助用户设计地理、社会、力量体系、文化、世界规则。',
    characters: '现在处于角色设计阶段。帮助用户设计主角（驱动三角）、反派（动机合理化）、配角、关系图。',
    outline: '现在处于大纲阶段。先写简要大纲（三幕结构），再写详细大纲（每章规划）。',
    scenes: '现在处于场景设计阶段。将每章分解为主动场景（目标-冲突-灾难）和被动场景（反应-困境-决定）。',
    writing: '现在处于写作阶段。按照大纲逐章写作，注意反AI词汇规则、感官描写、Show Don\'t Tell。',
  };
  if (stageInstructions[stage]) {
    parts.push(`## 阶段说明\n${stageInstructions[stage]}`);
  }

  // Project context - read existing files
  const novelDir = path.join(projectDir, '.novel');
  const contextFiles = ['config.json', 'concept.md', 'summary.md'];
  for (const file of contextFiles) {
    const filePath = path.join(novelDir, file);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      parts.push(`## ${file}\n${content}`);
    }
  }

  parts.push(`## 用户消息\n${userMessage}`);

  return parts.join('\n\n');
}
```

- [ ] **Step 2: Update run.ts to use composePrompt**

Update the `POST /api/runs` handler to use `composePrompt` instead of passing the raw message.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: prompt composition with skill content and project context"
```

---

## Task 18: Novel Plugin Content

**Files:**
- Create: `plugins/novel/SKILL.md`
- Create: `plugins/novel/open-novel.json`
- Create: `plugins/novel/templates/` (all template files)

- [ ] **Step 1: Create plugins/novel/open-novel.json**

```json
{
  "id": "novel",
  "name": "小说创作",
  "description": "完整的小说创作工作流，包含6个阶段",
  "version": "1.0.0",
  "stages": ["concept", "world", "characters", "outline", "scenes", "writing"],
  "templates": ["concept.md", "world-building.md", "characters/", "outline-brief.md", "outline-detailed.md", "scenes.md", "summary.md", "foreshadow.json"]
}
```

- [ ] **Step 2: Create plugins/novel/SKILL.md**

Port the content from the original `opencode-novel-plugin/skills/novel-workflow/SKILL.md` and `novel-writing/SKILL.md`. This is the core skill content that gets injected into the agent's system prompt.

Key sections:
- 6-stage workflow with checkpoints
- Anti-AI vocabulary rules
- Writing techniques (Show Don't Tell, sensory description)
- Scene type templates (active: Goal-Conflict-Disaster; passive: Reaction-Dilemma-Decision)
- Chapter opening templates
- Continuation rules

- [ ] **Step 3: Create template files**

Port from `opencode-novel-plugin/src/templates.ts`:
- `plugins/novel/templates/concept.md`
- `plugins/novel/templates/world-building.md`
- `plugins/novel/templates/characters/profiles.md`
- `plugins/novel/templates/characters/{name}.md`
- `plugins/novel/templates/outline-brief.md`
- `plugins/novel/templates/outline-detailed.md`
- `plugins/novel/templates/scenes.md`
- `plugins/novel/templates/summary.md`
- `plugins/novel/templates/foreshadow.json`
- `plugins/novel/templates/config.json`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: novel plugin with SKILL.md and document templates"
```

---

## Task 19: Wuxia & Reality Plugins

**Files:**
- Create: `plugins/wuxia/SKILL.md`
- Create: `plugins/wuxia/open-novel.json`
- Create: `plugins/reality/SKILL.md`
- Create: `plugins/reality/open-novel.json`

- [ ] **Step 1: Create wuxia plugin**

Port from `opencode-novel-plugin/skills/novel-wuxia/SKILL.md`:
- Martial arts system design (5 levels)
- Sect architecture (4 factions)
- Combat scene writing (rhythm, verb chains)
- Classic wuxia plot templates
- Weapon spectrum

- [ ] **Step 2: Create reality plugin**

Port from `opencode-novel-plugin/skills/novel-reality/SKILL.md`:
- Critical realism forms
- Defamiliarization techniques
- Character archetype extraction
- Fictionalization safety

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: wuxia and reality mapping plugins"
```

---

## Task 20: Settings Page

**Files:**
- Modify: `src/web/pages/SettingsPage.tsx`

- [ ] **Step 1: Implement SettingsPage.tsx**

```typescript
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { pageContainer, pageTitle, card, primaryBtn, input } from '@/styles/shared';

const formGroup = css`
  margin-bottom: 1rem;
`;

const label = css`
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
`;

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings');
      const data = await res.json();
      return data.settings;
    },
  });

  const { data: agents } = useQuery({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await fetch('/api/agents');
      const data = await res.json();
      return data.agents;
    },
  });

  const saveSettings = useMutation({
    mutationFn: async (body: Record<string, string>) => {
      await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const [preferredAgent, setPreferredAgent] = useState('');

  useEffect(() => {
    if (settings?.preferred_agent) setPreferredAgent(settings.preferred_agent);
  }, [settings]);

  return (
    <div className={pageContainer}>
      <h1 className={pageTitle}>设置</h1>
      <div className={card}>
        <div className={formGroup}>
          <label className={label}>首选 Agent</label>
          <select className={input} value={preferredAgent} onChange={(e) => { setPreferredAgent(e.target.value); saveSettings.mutate({ preferred_agent: e.target.value }); }}>
            <option value="">选择...</option>
            {agents?.map((a: any) => (
              <option key={a.id} value={a.id} disabled={!a.available}>{a.name} {!a.available ? '(未安装)' : ''}</option>
            ))}
          </select>
        </div>
        <h3 style={{ marginTop: '2rem', marginBottom: '1rem' }}>可用 Agent</h3>
        {agents?.map((a: any) => (
          <div key={a.id} style={{ marginBottom: '0.5rem', padding: '0.5rem', background: 'var(--haze-color-bg-secondary)', borderRadius: '6px' }}>
            <strong>{a.name}</strong> — {a.available ? `✓ ${a.version}` : `✗ 未安装`}
            {a.installUrl && !a.available && <a href={a.installUrl} target="_blank" rel="noopener" style={{ marginLeft: '0.5rem' }}>安装指南</a>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: settings page with agent selection"
```

---

## Task 21: Project Initialization (novel_init equivalent)

**Files:**
- Create: `src/api/routes/projects.ts` (add init endpoint)

- [ ] **Step 1: Add project init endpoint**

Add to `src/api/routes/projects.ts`:

```typescript
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getPlugin } from '../../plugins/registry';

projectsRouter.post('/:id/init', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const plugin = getPlugin(body.skillId || 'novel');
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

  const projectDir = path.resolve('./data/projects', id);
  const novelDir = path.join(projectDir, '.novel');

  if (!existsSync(novelDir)) {
    mkdirSync(novelDir, { recursive: true });
    mkdirSync(path.join(novelDir, 'characters'), { recursive: true });
    mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });

    // Copy templates
    const templatesDir = path.join(plugin.path, 'templates');
    if (existsSync(templatesDir)) {
      copyTemplates(templatesDir, novelDir, {
        title: project.title,
        genre: project.genre,
        targetWords: String(project.targetWords),
        chapterCount: String(project.chapterCount),
      });
    }

    // Write config
    writeFileSync(path.join(novelDir, 'config.json'), JSON.stringify({
      title: project.title,
      genre: project.genre,
      targetWords: project.targetWords,
      chapterCount: project.chapterCount,
      perspective: project.perspective,
      createdAt: new Date().toISOString(),
    }, null, 2));
  }

  return c.json({ ok: true });
});

function copyTemplates(src: string, dest: string, vars: Record<string, string>) {
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyTemplates(srcPath, destPath, vars);
    } else {
      let content = readFileSync(srcPath, 'utf-8');
      for (const [key, value] of Object.entries(vars)) {
        content = content.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
      }
      writeFileSync(destPath, content);
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: project initialization with template copying"
```

---

## Task 22: Testing

**Files:**
- Create: `tests/unit/plugins/loader.test.ts`
- Create: `tests/unit/agent/stream-parser.test.ts`
- Create: `tests/integration/api/projects.test.ts`

- [ ] **Step 1: Write plugin loader test**

```typescript
import { describe, it, expect } from 'vitest';
import { loadPlugins } from '@/plugins/loader';
import path from 'node:path';

describe('loadPlugins', () => {
  it('loads plugins from directory', () => {
    const plugins = loadPlugins(path.resolve('./plugins'));
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins[0]).toHaveProperty('id');
    expect(plugins[0]).toHaveProperty('manifest');
    expect(plugins[0]).toHaveProperty('skillContent');
  });

  it('returns empty for missing directory', () => {
    expect(loadPlugins('/nonexistent')).toEqual([]);
  });
});
```

- [ ] **Step 2: Write stream parser test**

```typescript
import { describe, it, expect } from 'vitest';
import { createClaudeStreamHandler } from '@/agent/stream-parser';

describe('createClaudeStreamHandler', () => {
  it('parses text_delta events', () => {
    const events: any[] = [];
    const handler = createClaudeStreamHandler((e) => events.push(e));

    handler.feed(JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg1' } },
    }) + '\n');

    handler.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    }) + '\n');

    handler.flush();

    expect(events.some((e) => e.type === 'text_delta' && e.delta === 'Hello')).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: plugin loader and stream parser unit tests"
```

---

## Final Task: E2E Smoke Test

**Files:**
- Create: `tests/e2e/smoke.spec.ts`

- [ ] **Step 1: Write E2E smoke test**

```typescript
import { test, expect } from '@playwright/test';

test('home page loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('text=我的小说')).toBeVisible();
});

test('create project', async ({ page }) => {
  await page.goto('/');
  await page.click('text=新建项目');
  await page.fill('input[placeholder="小说标题"]', '测试小说');
  await page.click('text=创建');
  await expect(page).toHaveURL(/\/projects\//);
});
```

- [ ] **Step 2: Run E2E tests**

Run: `pnpm test:e2e`
Expected: Smoke tests pass

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: E2E smoke tests"
```
