# Git Novel Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace centralized `data/projects/{id}/` storage with user-specified local directories, where novel data lives under `{user-dir}/.novel/`.

**Architecture:** Add a `path` column to the `projects` table. All file operations resolve from `project.path` instead of `config.dataDir`. Create a `resolveProjectDir` helper used by all route handlers. Git operations remain parameterized by `projectDir`.

**Tech Stack:** Hono, Drizzle ORM, PGlite, Node.js `fs`/`child_process`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/shared/project-dir.ts` | NEW — `resolveProjectDir(projectId)` helper |
| `src/db/schema.ts` | Add `path` column to `projects` table |
| `src/db/drizzle.ts` | Update raw DDL for `projects` table |
| `src/config.ts` | Remove `getProjectDir`, `getNovelDir`, `dataDir` |
| `src/api/routes/projects.ts` | Rewrite file ops to use `resolveProjectDir` |
| `src/api/routes/runs.ts` | Rewrite run/snapshot ops to use `resolveProjectDir` |
| `src/agent/snapshot.ts` | Add `gitSync()`, `hasRemote()` |
| `src/web/hooks/useProject.ts` | Add `path` to `CreateProjectInput` |
| `src/web/pages/HomePage.tsx` | Enhanced create form with path input |
| `src/web/pages/ProjectPage.tsx` | Add sync button |

---

### Task 1: Add `path` column to database schema

**Files:**
- Modify: `src/db/schema.ts:4-17`
- Modify: `src/db/drizzle.ts:37-49`

- [ ] **Step 1: Add `path` column to Drizzle schema**

In `src/db/schema.ts`, add `path` after `title` in the `projects` table definition:

```typescript
export const projects = pgTable('projects', {
  id: varchar('id', { length: 25 }).primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  path: varchar('path', { length: 500 }).notNull(),
  genre: varchar('genre', { length: 50 }).notNull().default('general'),
  // ... rest unchanged
```

- [ ] **Step 2: Update raw DDL in `ensureDbReady`**

In `src/db/drizzle.ts`, add `path VARCHAR(500) NOT NULL` to the `CREATE TABLE IF NOT EXISTS projects` statement, after the `title` line:

```sql
CREATE TABLE IF NOT EXISTS projects (
  id VARCHAR(25) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  path VARCHAR(500) NOT NULL,
  genre VARCHAR(50) NOT NULL DEFAULT 'general',
  ...
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: no new errors (pre-existing drizzle.ts error is acceptable).

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts src/db/drizzle.ts
git commit -m "feat(db): add path column to projects table"
```

---

### Task 2: Create `resolveProjectDir` helper

**Files:**
- Create: `src/shared/project-dir.ts`

- [ ] **Step 1: Create the helper module**

```typescript
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { db } from '../db/drizzle';
import { projects } from '../db/schema';

/**
 * Resolve the .novel directory for a project by reading its `path` from the DB.
 */
export async function resolveNovelDir(projectId: string): Promise<string> {
  const [project] = await db
    .select({ path: projects.path })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`Project not found: ${projectId}`);
  return path.join(project.path, '.novel');
}

/**
 * Resolve the project root directory from the DB.
 */
export async function resolveProjectDir(projectId: string): Promise<string> {
  const [project] = await db
    .select({ path: projects.path })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project.path;
}
```

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/project-dir.ts
git commit -m "feat: add resolveProjectDir helper"
```

---

### Task 3: Update `projects` API routes to use `resolveProjectDir`

**Files:**
- Modify: `src/api/routes/projects.ts`

- [ ] **Step 1: Replace imports**

Remove:
```typescript
import { getProjectDir, getNovelDir } from '../../config';
```

Add:
```typescript
import { resolveProjectDir, resolveNovelDir } from '../../shared/project-dir';
```

- [ ] **Step 2: Update `POST /` (create project) — lines 22-67**

The create route must accept `path` from the body, validate it, and store it:

```typescript
projectsRouter.post('/', async (c) => {
  const body = await c.req.json();
  const id = generateId('proj_');

  // Resolve and validate path
  const userPath = path.resolve(body.path);
  mkdirSync(userPath, { recursive: true });

  const [project] = await db.insert(projects).values({
    id,
    title: body.title || '未命名项目',
    path: userPath,
    genre: body.genre || 'general',
    targetWords: body.targetWords || 100000,
    chapterCount: body.chapterCount || 20,
    theme: body.theme || null,
    perspective: body.perspective || 'third-person',
  }).returning();

  // Auto-initialize workspace
  const plugin = getPlugin(body.skillId || body.genre || 'novel') || getPlugin('novel');
  if (plugin) {
    const novelDir = path.join(userPath, '.novel');

    if (!existsSync(novelDir)) {
      mkdirSync(novelDir, { recursive: true });
      mkdirSync(path.join(novelDir, 'characters'), { recursive: true });
      mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });

      const templatesDir = path.join(plugin.path, 'templates');
      if (existsSync(templatesDir)) {
        copyTemplates(templatesDir, novelDir, {
          title: project.title,
          genre: project.genre,
          targetWords: String(project.targetWords),
          chapterCount: String(project.chapterCount),
        });
      }

      writeFileSync(path.join(novelDir, 'config.json'), JSON.stringify({
        title: project.title,
        genre: project.genre,
        targetWords: project.targetWords,
        chapterCount: project.chapterCount,
        perspective: project.perspective,
        createdAt: new Date().toISOString(),
      }, null, 2));
    }
  }

  return c.json({ project }, 201);
});
```

- [ ] **Step 3: Update `POST /:id/init` — lines 97-137**

Replace `getProjectDir(id)` with `resolveProjectDir(id)`:

```typescript
projectsRouter.post('/:id/init', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const plugin = getPlugin(body.skillId || 'novel');
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);

  const projectDir = project.path;
  const novelDir = path.join(projectDir, '.novel');

  if (!existsSync(novelDir)) {
    mkdirSync(novelDir, { recursive: true });
    mkdirSync(path.join(novelDir, 'characters'), { recursive: true });
    mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });

    const templatesDir = path.join(plugin.path, 'templates');
    if (existsSync(templatesDir)) {
      copyTemplates(templatesDir, novelDir, {
        title: project.title,
        genre: project.genre,
        targetWords: String(project.targetWords),
        chapterCount: String(project.chapterCount),
      });
    }

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
```

- [ ] **Step 4: Update `POST /:id/upload` — lines 167-200**

Replace `getNovelDir(projectId)` with `resolveNovelDir(projectId)`:

```typescript
projectsRouter.post('/:id/upload', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveNovelDir(projectId);
  // ... rest unchanged, use projectDir as before
```

- [ ] **Step 5: Update `GET /:id/files` — lines 202-224**

```typescript
projectsRouter.get('/:id/files', async (c) => {
  const projectId = c.req.param('id');
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'path is required' }, 400);

  const projectDir = await resolveNovelDir(projectId);
  const normalizedPath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.resolve(projectDir, normalizedPath);

  if (!fullPath.startsWith(projectDir + path.sep) && fullPath !== projectDir) {
    return c.json({ error: 'Invalid path' }, 400);
  }

  try {
    const content = readFileSync(fullPath, 'utf-8');
    return c.json({ path: normalizedPath, content });
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});
```

- [ ] **Step 6: Update `GET /:id/files/list` — lines 226-237**

```typescript
projectsRouter.get('/:id/files/list', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveNovelDir(projectId);

  try {
    const files = listFilesRecursive(projectDir, '');
    return c.json({ files });
  } catch {
    return c.json({ files: [] });
  }
});
```

- [ ] **Step 7: Update `GET /:id/events` (SSE) — lines 256-293**

```typescript
projectsRouter.get('/:id/events', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveNovelDir(projectId);
  // ... rest unchanged, use projectDir for subscribe()
```

- [ ] **Step 8: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 9: Commit**

```bash
git add src/api/routes/projects.ts
git commit -m "feat(api): use resolveProjectDir in projects routes"
```

---

### Task 4: Update `runs` API routes to use `resolveProjectDir`

**Files:**
- Modify: `src/api/routes/runs.ts`

- [ ] **Step 1: Replace imports**

Remove:
```typescript
import { getProjectDir } from '../../config';
```

Add:
```typescript
import { resolveProjectDir } from '../../shared/project-dir';
```

- [ ] **Step 2: Update `POST /` (launch run) — lines 60-70**

Replace both `getProjectDir(projectId)` calls:

```typescript
  const projectDir = await resolveProjectDir(projectId);

  const composedPrompt = await composePrompt({
    message,
    projectId,
    skillId,
    stage,
    projectDir,
    history: history.length > 0 ? history : undefined,
  });

  const { child } = launchAgent(def, composedPrompt, projectDir, [], model);
```

- [ ] **Step 3: Update `close` handler — lines 114-120**

Replace `getProjectDir(projectId)`:

```typescript
    const projectDir = await resolveProjectDir(projectId);
    if (writtenPaths.size > 0) {
      await syncFilesToDb(projectId, writtenPaths, projectDir).catch(() => {});
    }
    await createSnapshot(projectDir, `Run ${run.id.slice(0, 8)}: ${writtenPaths.size} files modified`).catch(() => {});
```

- [ ] **Step 4: Update snapshot routes — lines 248-266**

```typescript
runsRouter.get('/projects/:projectId/snapshots', async (c) => {
  const projectId = c.req.param('projectId');
  const projectDir = await resolveProjectDir(projectId);
  const snapshots = await listSnapshots(projectDir);
  return c.json({ snapshots });
});

runsRouter.post('/projects/:projectId/rollback', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await c.req.json();
  if (!body.commitHash) return c.json({ error: 'commitHash is required' }, 400);

  const projectDir = await resolveProjectDir(projectId);
  const success = await restoreSnapshot(projectDir, body.commitHash);
  if (!success) return c.json({ error: 'Rollback failed' }, 500);

  return c.json({ ok: true });
});
```

- [ ] **Step 5: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/runs.ts
git commit -m "feat(api): use resolveProjectDir in runs routes"
```

---

### Task 5: Remove old `getProjectDir`/`getNovelDir` from config

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Remove unused functions and dataDir**

Remove `getProjectDir`, `getNovelDir`, and `config.dataDir` from `src/config.ts`. Keep the rest of the config (port, host, agentPaths, db, logLevel, features).

The resulting file:

```typescript
export const config = {
  port: parseInt(process.env.PORT || '3006', 10),
  host: process.env.HOST || '0.0.0.0',
  agentPaths: {
    claude: process.env.CLAUDE_PATH || 'claude',
    opencode: process.env.OPENCODE_PATH || 'opencode',
  },
  db: {
    url: process.env.DATABASE_URL,
  },
  logLevel: process.env.LOG_LEVEL || 'info',
  features: {
    autoSave: process.env.FEATURE_AUTO_SAVE !== 'false',
    snapshots: process.env.FEATURE_SNAPSHOTS !== 'false',
    fileWatching: process.env.FILE_WATCHING !== 'false',
  },
} as const;
```

- [ ] **Step 2: Verify no remaining imports of removed functions**

```bash
grep -rn "getProjectDir\|getNovelDir\|config\.dataDir" src/
```

Expected: no results.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/config.ts
git commit -m "refactor: remove getProjectDir/getNovelDir from config"
```

---

### Task 6: Add git sync operations

**Files:**
- Modify: `src/agent/snapshot.ts`

- [ ] **Step 1: Add `hasRemote` function**

```typescript
/**
 * Check if a git remote is configured.
 */
export async function hasRemote(projectDir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['remote'], { cwd: projectDir });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Add `gitSync` function**

```typescript
/**
 * Sync with remote: pull then push.
 * Returns { success, message }.
 */
export async function gitSync(projectDir: string): Promise<{ success: boolean; message: string }> {
  try {
    if (!(await hasRemote(projectDir))) {
      return { success: false, message: '未配置远程仓库。请先运行: git remote add origin <url>' };
    }

    // Pull with rebase
    try {
      await execFileAsync('git', ['pull', '--rebase'], { cwd: projectDir, timeout: 30000 });
    } catch (err: any) {
      // If pull fails because no upstream, that's OK for first push
      if (!err.message?.includes('no tracking information')) {
        return { success: false, message: `拉取失败: ${err.message}` };
      }
    }

    // Push
    try {
      await execFileAsync('git', ['push'], { cwd: projectDir, timeout: 30000 });
    } catch (err: any) {
      return { success: false, message: `推送失败: ${err.message}` };
    }

    return { success: true, message: '同步完成' };
  } catch (err: any) {
    return { success: false, message: `同步失败: ${err.message}` };
  }
}
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/agent/snapshot.ts
git commit -m "feat: add gitSync and hasRemote to snapshot module"
```

---

### Task 7: Add sync API route

**Files:**
- Modify: `src/api/routes/projects.ts`

- [ ] **Step 1: Add import for gitSync**

```typescript
import { gitSync } from '../../agent/snapshot';
```

- [ ] **Step 2: Add sync route**

```typescript
// Sync project with remote git
projectsRouter.post('/:id/sync', async (c) => {
  const projectId = c.req.param('id');
  const projectDir = await resolveProjectDir(projectId);
  const result = await gitSync(projectDir);
  if (!result.success) return c.json({ error: result.message }, 400);
  return c.json({ ok: true, message: result.message });
});
```

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/projects.ts
git commit -m "feat(api): add POST /projects/:id/sync route"
```

---

### Task 8: Update frontend create project form

**Files:**
- Modify: `src/hooks/useProject.ts`
- Modify: `src/web/pages/HomePage.tsx`

- [ ] **Step 1: Add `path` to `CreateProjectInput`**

In `src/hooks/useProject.ts`:

```typescript
export interface CreateProjectInput {
  title: string;
  genre?: string;
  targetWords?: number;
  chapterCount?: number;
  perspective?: string;
  path: string;
}
```

- [ ] **Step 2: Update HomePage create form**

In `src/web/pages/HomePage.tsx`, add a path input field to the create form. Add state:

```typescript
const [projectPath, setProjectPath] = useState('');
```

Add to the form JSX (inside the `showCreate` block, after the chapter count field):

```tsx
<div style={{ gridColumn: '1 / -1' }}>
  <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
    项目目录
  </label>
  <input
    className={input}
    placeholder="/home/user/novels/my-novel"
    value={projectPath}
    onChange={(e) => setProjectPath(e.target.value)}
    style={{ width: '100%' }}
  />
</div>
```

Update `handleCreate` to include `path`:

```typescript
const handleCreate = () => {
  if (!title.trim() || !projectPath.trim()) return;
  createProject.mutate({
    title: title.trim(),
    genre,
    targetWords: parseInt(targetWords) || 100000,
    chapterCount: parseInt(chapterCount) || 20,
    path: projectPath.trim(),
  }, {
    onSuccess: (data) => {
      setShowCreate(false);
      setTitle('');
      setProjectPath('');
      navigate(`/projects/${data.project.id}`);
    },
  });
};
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useProject.ts src/web/pages/HomePage.tsx
git commit -m "feat(ui): add path input to create project form"
```

---

### Task 9: Add sync button to project page

**Files:**
- Modify: `src/web/pages/ProjectPage.tsx`

- [ ] **Step 1: Add sync handler**

```typescript
const [syncing, setSyncing] = useState(false);

const handleSync = async () => {
  setSyncing(true);
  try {
    const res = await fetch(`/api/projects/${id}/sync`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      toast.success(data.message || '同步完成');
    } else {
      toast.error(data.error || '同步失败');
    }
  } catch {
    toast.error('同步失败');
  } finally {
    setSyncing(false);
  }
};
```

- [ ] **Step 2: Add sync button to top bar**

In the top bar `div`, add the button after the "撤销" button:

```tsx
<button className={previewToggle} onClick={handleSync} disabled={syncing} title="同步到远程仓库">
  {syncing ? '同步中...' : '同步'}
</button>
```

- [ ] **Step 3: Commit**

```bash
git add src/web/pages/ProjectPage.tsx
git commit -m "feat(ui): add sync button to project page"
```

---

### Task 10: Add import project feature

**Files:**
- Modify: `src/api/routes/projects.ts`
- Modify: `src/web/pages/HomePage.tsx`

- [ ] **Step 1: Add import API route**

```typescript
// Import an existing .novel/ directory
projectsRouter.post('/import', async (c) => {
  const body = await c.req.json();
  const userPath = path.resolve(body.path);
  const novelDir = path.join(userPath, '.novel');

  if (!existsSync(novelDir)) {
    return c.json({ error: '该目录下不存在 .novel/ 结构' }, 400);
  }

  // Read config.json if it exists
  let title = body.title || path.basename(userPath);
  let genre = 'general';
  let targetWords = 100000;
  let chapterCount = 20;
  let perspective = 'third-person';

  const configPath = path.join(novelDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      title = config.title || title;
      genre = config.genre || genre;
      targetWords = config.targetWords || targetWords;
      chapterCount = config.chapterCount || chapterCount;
      perspective = config.perspective || perspective;
    } catch { /* ignore */ }
  }

  // Check if already imported
  const existing = await db.select().from(projects).where(eq(projects.path, userPath)).limit(1);
  if (existing.length > 0) {
    return c.json({ error: '该项目已导入' }, 400);
  }

  const id = generateId('proj_');
  const [project] = await db.insert(projects).values({
    id,
    title,
    path: userPath,
    genre,
    targetWords,
    chapterCount,
    perspective,
  }).returning();

  return c.json({ project }, 201);
});
```

- [ ] **Step 2: Add import button to HomePage**

Add state and handler:

```typescript
const [showImport, setShowImport] = useState(false);
const [importPath, setImportPath] = useState('');

const handleImport = async () => {
  if (!importPath.trim()) return;
  try {
    const res = await fetch('/api/projects/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: importPath.trim() }),
    });
    const data = await res.json();
    if (res.ok) {
      setShowImport(false);
      setImportPath('');
      toast.success('导入成功');
      navigate(`/projects/${data.project.id}`);
    } else {
      toast.error(data.error || '导入失败');
    }
  } catch {
    toast.error('导入失败');
  }
};
```

Add import button next to "新建项目":

```tsx
<button onClick={() => setShowImport(true)} style={{ background: 'var(--haze-color-bg)', border: '1px solid var(--haze-color-border)', borderRadius: '6px', padding: '0.5rem 1rem', cursor: 'pointer' }}>
  导入项目
</button>
```

Add import form (similar to create form):

```tsx
{showImport && (
  <div className={card} style={{ marginBottom: '1rem' }}>
    <input className={input} placeholder="项目目录路径（如 /home/user/novels/my-novel）" value={importPath} onChange={(e) => setImportPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleImport()} style={{ width: '100%' }} />
    <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
      <button className={primaryBtn} onClick={handleImport}>导入</button>
      <button onClick={() => setShowImport(false)}>取消</button>
    </div>
  </div>
)}
```

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/projects.ts src/web/pages/HomePage.tsx
git commit -m "feat: add import existing project feature"
```

---

### Task 11: Run tests and verify

- [ ] **Step 1: Run unit tests**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: no new errors.

- [ ] **Step 3: Manual verification**

Start the dev server and test:
1. Create a new project with a custom path
2. Verify `.novel/` is created in the specified directory
3. Verify git init was performed
4. Navigate to the project, check file content loads
5. Test the sync button (should show "未配置远程仓库" message)
6. Test import with an existing `.novel/` directory

```bash
pnpm dev
```

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete git novel storage refactor"
```

---

### Task 12: Add project listing path validation

**Files:**
- Modify: `src/api/routes/projects.ts`

- [ ] **Step 1: Update `GET /` to check path existence**

```typescript
import { existsSync } from 'node:fs';

projectsRouter.get('/', async (c) => {
  const all = await db.select().from(projects).orderBy(desc(projects.createdAt));
  const enriched = all.map((p) => ({
    ...p,
    pathExists: existsSync(p.path),
  }));
  return c.json({ projects: enriched });
});
```

- [ ] **Step 2: Update HomePage to show warning badge**

In `src/web/pages/HomePage.tsx`, add a warning badge for projects with missing paths:

```tsx
{!p.pathExists && (
  <span style={{ display: 'inline-block', background: '#fef3c7', color: '#92400e', padding: '0.125rem 0.375rem', borderRadius: '4px', fontSize: '0.7rem', marginLeft: '0.5rem' }}>
    路径不存在
  </span>
)}
```

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/projects.ts src/web/pages/HomePage.tsx
git commit -m "feat: show path existence warning in project list"
```

---

### Task 13: Auto-commit after agent run

**Files:**
- Modify: `src/api/routes/runs.ts`

This is already handled in the existing `close` handler at line 120 which calls `createSnapshot`. The `createSnapshot` function in `snapshot.ts` does `git add -A && git commit`. No additional work needed — the existing behavior already auto-commits after agent runs.

Verified: `runs.ts:120` calls `createSnapshot(projectDir, ...)` which stages all changes and commits. This satisfies the spec requirement "Agent writes files → auto git add + commit".
