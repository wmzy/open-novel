# Git Novel Storage Design

**Date:** 2026-05-29
**Status:** Approved

## Motivation

Replace the centralized storage (`data/projects/{id}/`) with user-specified local directories. Novel data lives in the user's own git repository under `.novel/`, matching the opencode-novel-plugin convention. Users manage git remotes and sync via UI buttons.

## Architecture

### Before

```
data/projects/{id}/.novel/    ← centralized, opaque
PGlite DB: { id, title, genre, ... }
```

### After

```
{user-chosen-dir}/.novel/     ← user's own directory
PGlite DB: { id, title, genre, path, ... }
```

`path` stores the absolute path to the user's directory (e.g., `/home/zlt/novels/my-novel`).

## Components

### 1. Database Schema

Add `path` column to `projects` table:

```sql
path VARCHAR(500) NOT NULL
```

Update `src/db/schema.ts` and `src/db/drizzle.ts` (the `ensureDbReady` DDL).

### 2. Project Creation Flow

**Frontend (`HomePage.tsx`):**

- Enhanced create form with directory picker + manual path input
- Use `webkitdirectory` input or `<input type="text">` for path
- Show validation feedback (directory exists, is writable)

**Backend (`POST /api/projects`):**

1. Accept `{ title, genre, targetWords, chapterCount, path }`
2. Validate `path` exists and is writable
3. Resolve to absolute path
4. Create `.novel/` structure (reuse existing `copyTemplates` logic)
5. `git init` if not already a repo
6. `git add -A && git commit -m "init: {title}"`
7. Insert DB record with `path`
8. Return project

**Remove:** `getProjectDir()` and `getNovelDir(projectId)` from `config.ts`.

### 3. File Operations

All file APIs resolve from `{project.path}/.novel/` instead of `data/projects/{id}/.novel/`.

Helper function:

```typescript
async function resolveNovelDir(projectId: string): Promise<string> {
  const project = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw new Error('Project not found');
  return path.join(project[0].path, '.novel');
}
```

Affected routes:
- `GET /api/projects/:id/files` — read file
- `POST /api/projects/:id/upload` — upload file
- `GET /api/projects/:id/files/list` — list files
- `GET /api/projects/:id/events` — SSE file watcher
- `PATCH /api/projects/:id` — update project
- `DELETE /api/projects/:id` — delete DB record only, not files

### 4. Git Operations

Extend `src/agent/snapshot.ts`:

- **`ensureGitInit(dir)`** — already exists, keep as-is
- **`createSnapshot(dir, message)`** — already exists, keep as-is
- **`listSnapshots(dir)`** — already exists, keep as-is
- **`restoreSnapshot(dir, hash)`** — already exists, keep as-is
- **`gitSync(dir)`** — NEW: `git pull --rebase && git push`
- **`hasRemote(dir)`** — NEW: check if remote is configured

### 5. UI Changes

**Project page top bar — add「同步」button:**

```
[← 首页] [项目标题] [进度条] [MD] [TXT] [撤销] [同步] [显示预览]
```

Click handler:
1. Call `POST /api/projects/:id/sync`
2. Backend runs `git pull --rebase && git push`
3. If no remote configured, show toast: "请先配置远程仓库: git remote add origin <url>"
4. On success, show toast: "同步完成"
5. On conflict, show toast with error

**New API:** `POST /api/projects/:id/sync`

### 6. Project Listing

- Read from DB, verify `path` exists via `fs.existsSync`
- Mark missing projects with a warning badge
- Delete only removes DB record, not user files

### 7. Migration

Import existing projects:
- UI: "导入项目" button on homepage
- Accepts a local path
- Backend scans for `.novel/` structure, reads `config.json`, inserts DB record

## Files to Change

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `path` column |
| `src/db/drizzle.ts` | Update DDL |
| `src/config.ts` | Remove `getProjectDir`, `getNovelDir` |
| `src/api/routes/projects.ts` | Rewrite file ops to use `path` from DB |
| `src/agent/snapshot.ts` | Add `gitSync`, `hasRemote` |
| `src/api/routes/runs.ts` | Update snapshot paths |
| `src/web/pages/HomePage.tsx` | Enhanced create form, import button |
| `src/web/pages/ProjectPage.tsx` | Add sync button |
| `src/web/components/Sidebar.tsx` | No change needed |
| `src/hooks/useProject.ts` | Update create mutation input |

## Testing

- Create project in user directory, verify `.novel/` structure
- File read/write APIs work with new path resolution
- Git init + commit on project creation
- Sync button works with configured remote
- Sync button shows helpful message without remote
- Project listing shows missing paths as warnings
- Import existing project from local path
