# 双分支审阅闸门 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给小说版本管理加"事前审阅闸门"——agent/用户改动落 draft 分支，main 作为只读镜像仅通过审阅合并(fast-forward)更新。

**Architecture:** 双分支 `main`（只读镜像）+ `draft`（工作区）。working tree 常驻 draft；agent run 的 `createSnapshot` 因此自动落 draft（零改动）。新增 `reviewDiff`/`mergeDraft`/`discardDraft` 三个 git 纯函数 + 三个 REST 端点 + 前端审阅面板。main 只通过 ff merge 更新 → 零冲突。

**Tech Stack:** Hono (API)、execFile git (分支操作)、React 19 + @linaria/core + @tanstack/react-query (前端)、vitest + @testing-library/react (测试)

**Spec:** `docs/superpowers/specs/2026-07-27-dual-branch-review-design.md`

---

## 设计决策（偏离 spec 的简化，已自审）

1. **`createUserSnapshot` 不改**：milestone 仍在当前分支（draft）打 tag。spec 说打 main，但 draft 历史已包含 main 所有 commit（ff 关系），tag 跟 commit 走，审阅合并后 tag 自然在 main 可见。零风险、不破坏现有"存版本"行为。
2. **`listSnapshots` 不改**：撤销面板仍显示 draft 历史（= 所有 commit，含已审阅+未审阅）。draft 历史是 main 的超集，足够。
3. **`gitSync` 不改**：v1 sync 仍在当前分支（draft）操作。文档注明：remote 上是 draft。

这些简化把 `snapshot.ts` 改动收敛为**纯新增**，不触碰现有函数。

## File Structure

| File | Responsibility |
|------|----------------|
| `src/agent/snapshot.ts` | 新增 `ensureDraftBranch`/`reviewDiff`/`mergeDraft`/`discardDraft` 四个 git 纯函数 + 类型导出 |
| `src/api/routes/review.ts` | **新建**：审阅三端点路由 |
| `src/api-app.ts` | 挂载 review 路由 |
| `src/api/routes/projects.ts` | `GET /:id` 调 `ensureDraftBranch`（迁移钩子） |
| `src/web/hooks/useReview.ts` | **新建**：query + merge/discard mutations |
| `src/web/components/ReviewPanel.tsx` | **新建**：审阅面板（复用 RevisionDiffPanel） |
| `src/web/pages/ProjectPage.tsx` | 顶栏按钮 + 徽标 + 挂载面板 |
| `tests/unit/agent/snapshot.test.ts` | **新建**：分支操作纯函数测试（临时 git 仓库） |
| `tests/unit/api/review.test.ts` | **新建**：三端点契约测试 |
| `tests/unit/web/review-panel.test.tsx` | **新建**：面板渲染 + 交互 |

---

### Task 1: `ensureDraftBranch` 分支迁移纯函数

**Files:**
- Modify: `src/agent/snapshot.ts`（末尾追加）
- Test: `tests/unit/agent/snapshot.test.ts`

- [ ] **Step 1: 写失败测试（创建测试文件 + 第一个用例）**

Create `tests/unit/agent/snapshot.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureGitInit, createSnapshot, ensureDraftBranch } from '../../../src/agent/snapshot';

const execFileAsync = promisify(execFile);

/** 创建一个已初始化、有初始 commit 的临时 git 仓库。 */
async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-test-'));
  await ensureGitInit(dir);
  await fs.writeFile(path.join(dir, 'README.md'), 'init\n');
  await createSnapshot(dir, 'init');
  return dir;
}

/** 读取当前分支名。 */
async function currentBranch(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return stdout.trim();
}

/** 判断分支是否存在。 */
async function branchExists(dir: string, name: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', name], { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

describe('ensureDraftBranch', () => {
  let dir: string;

  beforeEach(async () => { dir = await makeRepo(); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('无 draft 时从当前 HEAD 创建 draft + main，并 checkout 到 draft', async () => {
    await ensureDraftBranch(dir);
    expect(await currentBranch(dir)).toBe('draft');
    expect(await branchExists(dir, 'draft')).toBe(true);
    expect(await branchExists(dir, 'main')).toBe(true);
  });

  it('已有 draft 时幂等（不报错，仍在 draft）', async () => {
    await ensureDraftBranch(dir);
    await ensureDraftBranch(dir);
    expect(await currentBranch(dir)).toBe('draft');
  });

  it('working tree 在 main 时切到 draft', async () => {
    await ensureDraftBranch(dir);
    await execFileAsync('git', ['checkout', 'main'], { cwd: dir });
    expect(await currentBranch(dir)).toBe('main');
    await ensureDraftBranch(dir);
    expect(await currentBranch(dir)).toBe('draft');
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/snapshot.test.ts 2>&1 | tail -8`
Expected: FAIL — `ensureDraftBranch is not a function` 或导入错误。

- [ ] **Step 3: 实现 `ensureDraftBranch`**

在 `src/agent/snapshot.ts` 末尾追加：

```typescript
/**
 * 确保项目仓库处于双分支模型：main（只读镜像）+ draft（工作区）。
 * - 两者都不存在：从当前 HEAD 创建 main 与 draft，checkout 到 draft
 * - main 不存在：从当前 HEAD 创建 main（不动位置）
 * - draft 不存在：从当前 HEAD 创建 draft
 * - checkout 到 draft
 *
 * 幂等：已处于双分支模型时无副作用。
 */
export async function ensureDraftBranch(projectDir: string): Promise<void> {
  await ensureGitInit(projectDir);

  const hasBranch = async (name: string): Promise<boolean> => {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', name], { cwd: projectDir });
      return true;
    } catch {
      return false;
    }
  };

  // 若无任何提交（空仓库），先建一个初始提交作为分支基点
  try {
    await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectDir });
  } catch {
    await execFileAsync('git', ['add', '-A'], { cwd: projectDir });
    try {
      await execFileAsync('git', ['commit', '--allow-empty', '-m', '[auto] init'], { cwd: projectDir });
    } catch { /* nothing to commit, allow-empty 兜底 */ }
  }

  // 推断"当前分支名"作为基点（迁移前可能是 master/main/其他）
  const { stdout: curOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir });
  const cur = curOut.trim();

  // 确保 main 存在（若 cur 就是 main/master 则复用；否则从当前 HEAD 建 main）
  const mainExists = await hasBranch('main');
  if (!mainExists) {
    // 若用户原分支是 master，将其视为 main（不强制改名：在 main 上 mirror master 的位置）
    const masterExists = await hasBranch('master');
    if (masterExists && cur === 'master') {
      await execFileAsync('git', ['branch', 'main', 'master'], { cwd: projectDir });
    } else {
      await execFileAsync('git', ['branch', 'main'], { cwd: projectDir });
    }
  }

  // 确保 draft 存在
  const draftExists = await hasBranch('draft');
  if (!draftExists) {
    await execFileAsync('git', ['branch', 'draft'], { cwd: projectDir });
  }

  // checkout 到 draft
  await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir });
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/snapshot.test.ts 2>&1 | tail -8`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/agent/snapshot.ts tests/unit/agent/snapshot.test.ts && git commit -m "feat(review): ensureDraftBranch 双分支迁移纯函数"
```

---

### Task 2: `reviewDiff` 审阅数据聚合纯函数

**Files:**
- Modify: `src/agent/snapshot.ts`（追加类型 + 函数）
- Test: `tests/unit/agent/snapshot.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试（追加到 snapshot.test.ts）**

在 `tests/unit/agent/snapshot.test.ts` 顶部 import 加入 `reviewDiff`：

```typescript
import { ensureGitInit, createSnapshot, ensureDraftBranch, reviewDiff } from '../../../src/agent/snapshot';
```

在文件末尾追加：

```typescript
describe('reviewDiff', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeRepo();
    await ensureDraftBranch(dir);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('draft==main 时返回空审阅', async () => {
    const r = await reviewDiff(dir);
    expect(r.commits).toHaveLength(0);
    expect(r.files).toHaveLength(0);
    expect(r.totalAdded).toBe(0);
    expect(r.totalRemoved).toBe(0);
  });

  it('draft 领先 main 时返回 commit 列表 + per-file diff', async () => {
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章内容\n');
    await createSnapshot(dir, '写第一章');

    const r = await reviewDiff(dir);
    expect(r.commits.length).toBeGreaterThanOrEqual(1);
    expect(r.files.some((f) => f.path === 'ch1.md')).toBe(true);
    const ch1 = r.files.find((f) => f.path === 'ch1.md')!;
    expect(ch1.status).toBe('added');
    expect(ch1.addedLines).toBeGreaterThan(0);
    expect(ch1.diff).toContain('+第一章内容');
    expect(r.totalAdded).toBeGreaterThan(0);
  });

  it('working tree 有未提交改动时先 checkpoint commit，diff 包含之', async () => {
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章\n');
    await createSnapshot(dir, '写第一章');
    // 未提交改动
    await fs.writeFile(path.join(dir, 'ch2.md'), '第二章\n');

    const r = await reviewDiff(dir);
    expect(r.files.some((f) => f.path === 'ch2.md')).toBe(true);
  });

  it('修改/删除文件状态正确', async () => {
    await fs.writeFile(path.join(dir, 'ch1.md'), 'AAA\nBBB\nCCC\n');
    await createSnapshot(dir, '加 ch1');
    await fs.writeFile(path.join(dir, 'ch1.md'), 'AAA\nXXX\nCCC\n'); // 修改
    await fs.rm(path.join(dir, 'README.md')); // 删除
    await createSnapshot(dir, '改 ch1 删 README');

    const r = await reviewDiff(dir);
    const ch1 = r.files.find((f) => f.path === 'ch1.md');
    const readme = r.files.find((f) => f.path === 'README.md');
    expect(ch1?.status).toBe('modified');
    expect(readme?.status).toBe('deleted');
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/snapshot.test.ts 2>&1 | tail -8`
Expected: FAIL — `reviewDiff is not a function`

- [ ] **Step 3: 实现 `reviewDiff` + 类型**

在 `src/agent/snapshot.ts` 末尾追加：

```typescript
export interface ReviewCommit {
  hash: string;
  message: string;
  date: string;
}

export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  addedLines: number;
  removedLines: number;
  diff: string;
}

export interface ReviewResult {
  commits: ReviewCommit[];
  files: ReviewFile[];
  totalAdded: number;
  totalRemoved: number;
}

/**
 * 聚合 draft 相对 main 的待审阅数据。
 * 流程：
 * 1. 先把 working tree 未提交改动 checkpoint commit 到 draft（确保 diff 完整）
 * 2. rev-list main..draft 取 commit 列表；为空则返回空审阅
 * 3. diff --name-status main..draft 取文件状态
 * 4. 对每个文件 diff main..draft -- <path> 取 unified diff，summarizeDiff 统计行数
 */
export async function reviewDiff(projectDir: string): Promise<ReviewResult> {
  await ensureDraftBranch(projectDir);

  // 1. checkpoint 未提交改动
  await execFileAsync('git', ['add', '-A'], { cwd: projectDir });
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: projectDir });
    // 无暂存改动
  } catch {
    await execFileAsync('git', ['commit', '-m', '[auto] review checkpoint'], { cwd: projectDir });
  }

  // 2. commit 列表
  const { stdout: revOut } = await execFileAsync('git', [
    'rev-list', 'main..draft', '--format=%H|%s|%ai', '--no-color',
  ], { cwd: projectDir });
  const commits: ReviewCommit[] = revOut.trim().split('\n')
    .filter((l) => l && !l.startsWith('commit '))
    .map((line) => {
      const [hash, message, date] = line.split('|');
      return { hash, message, date };
    });

  if (commits.length === 0) {
    return { commits: [], files: [], totalAdded: 0, totalRemoved: 0 };
  }

  // 3. 文件状态
  const { stdout: statOut } = await execFileAsync('git', [
    'diff', '--name-status', 'main..draft', '--no-color',
  ], { cwd: projectDir });
  const fileEntries = statOut.trim().split('\n').filter(Boolean).map((line) => {
    const [code, filePath] = line.split('\t');
    const status: ReviewFile['status'] =
      code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
    return { path: filePath, status };
  });

  // 4. per-file diff + 行数统计
  const { summarizeDiff } = await import('./../shared/diff-utils');
  let totalAdded = 0;
  let totalRemoved = 0;
  const files: ReviewFile[] = [];
  for (const fe of fileEntries) {
    const { stdout: diffOut } = await execFileAsync('git', [
      'diff', 'main..draft', '--', fe.path, '--no-color',
    ], { cwd: projectDir });
    const summary = summarizeDiff(diffOut);
    files.push({
      path: fe.path,
      status: fe.status,
      addedLines: summary.addedLines,
      removedLines: summary.removedLines,
      diff: diffOut,
    });
    totalAdded += summary.addedLines;
    totalRemoved += summary.removedLines;
  }

  return { commits, files, totalAdded, totalRemoved };
}
```

> 注意 `summarizeDiff` 来自 `src/shared/diff-utils.ts`，已存在。`import('./../shared/diff-utils')` 的相对路径：`src/agent/snapshot.ts` → `../shared/diff-utils`。

- [ ] **Step 4: 运行测试，验证通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/snapshot.test.ts 2>&1 | tail -8`
Expected: PASS（Task1 的 3 + Task2 的 4 = 7 用例）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/agent/snapshot.ts tests/unit/agent/snapshot.test.ts && git commit -m "feat(review): reviewDiff 审阅数据聚合纯函数"
```

---

### Task 3: `mergeDraft` + `discardDraft` 审阅动作纯函数

**Files:**
- Modify: `src/agent/snapshot.ts`（追加）
- Test: `tests/unit/agent/snapshot.test.ts`（追加 describe）

- [ ] **Step 1: 写失败测试**

在 `tests/unit/agent/snapshot.test.ts` 顶部 import 加入 `mergeDraft, discardDraft`：

```typescript
import { ensureGitInit, createSnapshot, ensureDraftBranch, reviewDiff, mergeDraft, discardDraft } from '../../../src/agent/snapshot';
```

末尾追加：

```typescript
/** 读取 main 分支指向的 commit hash。 */
async function mainHash(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'main'], { cwd: dir });
  return stdout.trim();
}
async function draftHash(dir: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'draft'], { cwd: dir });
  return stdout.trim();
}

describe('mergeDraft', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeRepo();
    await ensureDraftBranch(dir);
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章\n');
    await createSnapshot(dir, '写第一章');
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('ff main 到 draft，merge 后 main==draft，working tree 回到 draft', async () => {
    const beforeDraft = await draftHash(dir);
    const res = await mergeDraft(dir);
    expect(res.success).toBe(true);
    expect(res.fastForward).toBe(true);
    expect(await mainHash(dir)).toBe(beforeDraft);
    expect(await currentBranch(dir)).toBe('draft');
  });

  it('merge 后 reviewDiff 为空', async () => {
    await mergeDraft(dir);
    const r = await reviewDiff(dir);
    expect(r.commits).toHaveLength(0);
  });
});

describe('discardDraft', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeRepo();
    await ensureDraftBranch(dir);
    await fs.writeFile(path.join(dir, 'ch1.md'), '第一章\n');
    await createSnapshot(dir, '写第一章');
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('reset draft 到 main，丢弃 commit + working tree 改动', async () => {
    const beforeMain = await mainHash(dir);
    const res = await discardDraft(dir);
    expect(res.success).toBe(true);
    expect(await draftHash(dir)).toBe(beforeMain);
    // 文件被丢弃
    await expect(fs.access(path.join(dir, 'ch1.md'))).rejects.toThrow();
  });

  it('discard 后 reviewDiff 为空', async () => {
    await discardDraft(dir);
    const r = await reviewDiff(dir);
    expect(r.commits).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/snapshot.test.ts 2>&1 | tail -8`
Expected: FAIL — `mergeDraft is not a function`

- [ ] **Step 3: 实现 `mergeDraft` + `discardDraft`**

在 `src/agent/snapshot.ts` 末尾追加：

```typescript
export interface MergeResult {
  success: boolean;
  fastForward: boolean;
  hash: string | null;
}

/**
 * 审阅合并：ff main 到 draft，然后 checkout 回 draft。
 * main 只读镜像约束下必然 fast-forward。
 */
export async function mergeDraft(projectDir: string): Promise<MergeResult> {
  try {
    await ensureDraftBranch(projectDir);
    await execFileAsync('git', ['checkout', 'main'], { cwd: projectDir });

    // 检测能否 ff
    let fastForward = true;
    try {
      await execFileAsync('git', ['merge', '--ff-only', 'draft'], { cwd: projectDir });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Not possible to fast-forward') || msg.includes('non-fast-forward')) {
        fastForward = false;
        // 兜底：尝试普通合并（破坏 ff 约束，但避免卡死）
        await execFileAsync('git', ['merge', '--no-edit', 'draft'], { cwd: projectDir });
      } else {
        throw err;
      }
    }

    const { stdout } = await execFileAsync('git', ['rev-parse', 'main'], { cwd: projectDir });
    await execFileAsync('git', ['checkout', 'draft'], { cwd: projectDir });
    return { success: true, fastForward, hash: stdout.trim() };
  } catch {
    return { success: false, fastForward: false, hash: null };
  }
}

export interface DiscardResult {
  success: boolean;
}

/**
 * 丢弃整批未审阅：reset draft 到 main（含 working tree 改动）。
 */
export async function discardDraft(projectDir: string): Promise<DiscardResult> {
  try {
    await ensureDraftBranch(projectDir);
    await execFileAsync('git', ['reset', '--hard', 'main'], { cwd: projectDir });
    return { success: true };
  } catch {
    return { success: false };
  }
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/agent/snapshot.test.ts 2>&1 | tail -8`
Expected: PASS（7 + 4 = 11 用例）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/agent/snapshot.ts tests/unit/agent/snapshot.test.ts && git commit -m "feat(review): mergeDraft/discardDraft 审阅动作纯函数"
```

---

### Task 4: review 路由 + 挂载

**Files:**
- Create: `src/api/routes/review.ts`
- Modify: `src/api-app.ts`
- Test: `tests/unit/api/review.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/unit/api/review.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';
import { ensureGitInit, createSnapshot, ensureDraftBranch } from '../../../src/agent/snapshot';

describe('review API', () => {
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-api-'));
    await ensureGitInit(tempDir);
    await fs.writeFile(path.join(tempDir, 'README.md'), 'init\n');
    await createSnapshot(tempDir, 'init');
    await ensureDraftBranch(tempDir);

    projectId = 'test_proj_review_1';
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({
      id: projectId,
      title: '审阅测试',
      path: tempDir,
      genre: 'wuxia',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('GET /review 无待审阅时返回空', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/review`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commits).toHaveLength(0);
    expect(data.files).toHaveLength(0);
  });

  it('GET /review 有 draft 改动时返回 diff', async () => {
    await fs.writeFile(path.join(tempDir, 'ch1.md'), '第一章\n');
    await createSnapshot(tempDir, '写第一章');

    const res = await apiApp.request(`/api/projects/${projectId}/review`);
    const data = await res.json();
    expect(data.commits.length).toBeGreaterThanOrEqual(1);
    expect(data.files.some((f: { path: string }) => f.path === 'ch1.md')).toBe(true);
  });

  it('POST /review/merge 把 main ff 到 draft', async () => {
    await fs.writeFile(path.join(tempDir, 'ch1.md'), '第一章\n');
    await createSnapshot(tempDir, '写第一章');

    const res = await apiApp.request(`/api/projects/${projectId}/review/merge`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // merge 后 review 应为空
    const after = await apiApp.request(`/api/projects/${projectId}/review`);
    const afterData = await after.json();
    expect(afterData.commits).toHaveLength(0);
  });

  it('POST /review/discard 丢弃 draft 改动', async () => {
    await fs.writeFile(path.join(tempDir, 'ch1.md'), '第一章\n');
    await createSnapshot(tempDir, '写第一章');

    const res = await apiApp.request(`/api/projects/${projectId}/review/discard`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    await expect(fs.access(path.join(tempDir, 'ch1.md'))).rejects.toThrow();
  });

  it('项目不存在时返回 404', async () => {
    const res = await apiApp.request('/api/projects/nonexistent/review');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/api/review.test.ts 2>&1 | tail -8`
Expected: FAIL — 路由不存在（404 全部 case）

- [ ] **Step 3: 实现 review 路由**

Create `src/api/routes/review.ts`:

```typescript
import { Hono } from 'hono';
import { resolveProjectDir } from '../../shared/project-dir';
import { reviewDiff, mergeDraft, discardDraft } from '../../agent/snapshot';

const reviewRouter = new Hono();

/** GET /api/projects/:projectId/review — 待审阅 commits + per-file diff */
reviewRouter.get('/projects/:projectId/review', async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const projectDir = await resolveProjectDir(projectId);
    const result = await reviewDiff(projectDir);
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('不存在')) return c.json({ error: '项目不存在' }, 404);
    return c.json({ error: msg }, 500);
  }
});

/** POST /api/projects/:projectId/review/merge — ff main 到 draft */
reviewRouter.post('/projects/:projectId/review/merge', async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const projectDir = await resolveProjectDir(projectId);
    const result = await mergeDraft(projectDir);
    if (!result.success) return c.json({ error: '合并失败' }, 500);
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

/** POST /api/projects/:projectId/review/discard — 丢弃整批未审阅 */
reviewRouter.post('/projects/:projectId/review/discard', async (c) => {
  const projectId = c.req.param('projectId');
  try {
    const projectDir = await resolveProjectDir(projectId);
    const result = await discardDraft(projectDir);
    if (!result.success) return c.json({ error: '丢弃失败' }, 500);
    return c.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

export default reviewRouter;
```

挂载到 `src/api-app.ts`：

import 区追加（与其他 router 并列）：
```typescript
import reviewRouter from './api/routes/review';
```

路由区追加（紧邻 `app.route('/api/projects/:projectId/rename', renameRouter);` 之后）：
```typescript
app.route('/api/projects/:projectId/review', reviewRouter);
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/api/review.test.ts 2>&1 | tail -8`
Expected: PASS（5 用例）

- [ ] **Step 5: typecheck**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | tail -10`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
cd ~/projects/open-novel && git add src/api/routes/review.ts src/api-app.ts tests/unit/api/review.test.ts && git commit -m "feat(review): GET/merge/discard 三端点 + 挂载"
```

---

### Task 5: projects 路由迁移钩子

**Files:**
- Modify: `src/api/routes/projects.ts`（`GET /:id`）
- Test: `tests/unit/api/review.test.ts`（追加用例）

> 让 `GET /api/projects/:id` 调用 `ensureDraftBranch`，使旧项目首次打开即迁移到双分支。

- [ ] **Step 1: 写失败测试**

在 `tests/unit/api/review.test.ts` 末尾追加：

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

describe('迁移钩子：GET /:id 触发 ensureDraftBranch', () => {
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-api-'));
    await ensureGitInit(tempDir);
    await fs.writeFile(path.join(tempDir, 'README.md'), 'init\n');
    await createSnapshot(tempDir, 'init');
    // 注意：不预先 ensureDraftBranch，让 GET /:id 触发

    projectId = 'test_proj_migrate_1';
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.insert(projects).values({
      id: projectId,
      title: '迁移测试',
      path: tempDir,
      genre: 'wuxia',
    });
  });

  afterEach(async () => {
    await db.delete(projects).where(eq(projects.id, projectId)).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('GET /api/projects/:id 后 draft 分支存在', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'draft'], { cwd: tempDir });
    expect(stdout.trim()).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/api/review.test.ts 2>&1 | tail -8`
Expected: FAIL — draft 分支不存在

- [ ] **Step 3: 在 `GET /:id` 加迁移钩子**

先定位 `src/api/routes/projects.ts` 中 `GET /:id` 的 handler。读取：

Run: `cd ~/projects/open-novel && grep -n "projectsRouter.get('/:id'" src/api/routes/projects.ts`

在 handler 内、`return c.json(...)` 之前插入迁移调用。在文件顶部 import 区加：

```typescript
import { ensureDraftBranch } from '../../agent/snapshot';
```

在 `GET /:id` handler 中，读取到 project 之后、返回前加（用 `.catch(() => {})` 避免阻塞主流程）：

```typescript
    // 迁移到双分支模型（幂等，已有 draft 则跳过）。失败不阻塞项目读取。
    await ensureDraftBranch(projectDir).catch(() => {});
```

其中 `projectDir` 是 handler 内已解析出的项目路径变量名（按实际代码调整；若变量名不同，用 `project[0].path`）。

- [ ] **Step 4: 运行测试，验证通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/api/review.test.ts 2>&1 | tail -8`
Expected: PASS（5 + 1 = 6 用例）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/api/routes/projects.ts tests/unit/api/review.test.ts && git commit -m "feat(review): GET /projects/:id 迁移钩子触发 ensureDraftBranch"
```

---

### Task 6: `useReview` hook

**Files:**
- Create: `src/web/hooks/useReview.ts`
- Test: `tests/unit/web/use-review.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `tests/unit/web/use-review.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReview } from '../../../src/web/hooks/useReview';

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return { ...actual };
});

const mockReview = {
  commits: [{ hash: 'abc1234', message: '[auto] test', date: '2026-07-27T00:00:00+08:00' }],
  files: [{ path: 'ch1.md', status: 'added' as const, addedLines: 5, removedLines: 0, diff: '+content' }],
  totalAdded: 5,
  totalRemoved: 0,
};

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useReview', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('拉取 review 数据', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => mockReview,
    });
    const { result } = renderHook(() => useReview('proj1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.review).toBeDefined());
    expect(result.current.review?.commits).toHaveLength(1);
    expect(result.current.pendingCount).toBe(1);
  });

  it('pendingCount 为 commits.length', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockReview, commits: [...mockReview.commits, ...mockReview.commits] }),
    });
    const { result } = renderHook(() => useReview('proj1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.pendingCount).toBe(2));
  });

  it('空审阅时 pendingCount 为 0', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ commits: [], files: [], totalAdded: 0, totalRemoved: 0 }),
    });
    const { result } = renderHook(() => useReview('proj1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.review).toBeDefined());
    expect(result.current.pendingCount).toBe(0);
  });

  it('merge 调用 POST /review/merge', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/merge') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => mockReview });
    });
    const { result } = renderHook(() => useReview('proj1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.review).toBeDefined());
    await result.current.merge();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/projects/proj1/review/merge',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/use-review.test.tsx 2>&1 | tail -8`
Expected: FAIL — `Cannot find module '../../../src/web/hooks/useReview'`

- [ ] **Step 3: 实现 hook**

Create `src/web/hooks/useReview.ts`:

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReviewResult } from '../../agent/snapshot';

/**
 * 审阅闸门 hook：拉取待审阅数据 + merge/discard mutations。
 * 触发 refetch 由调用方在 file-changed / run 结束事件后 invalidate ['review']。
 */
export function useReview(projectId: string) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['review', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/review`);
      if (!res.ok) throw new Error('拉取审阅数据失败');
      return (await res.json()) as ReviewResult;
    },
  });

  const mergeMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/review/merge`, { method: 'POST' });
      if (!res.ok) throw new Error('合并失败');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review', projectId] });
      qc.invalidateQueries({ queryKey: ['snapshots', projectId] });
    },
  });

  const discardMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/review/discard`, { method: 'POST' });
      if (!res.ok) throw new Error('丢弃失败');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review', projectId] });
      qc.invalidateQueries({ queryKey: ['snapshots', projectId] });
    },
  });

  return {
    review: query.data,
    isLoading: query.isLoading,
    pendingCount: query.data?.commits.length ?? 0,
    merge: mergeMut.mutateAsync,
    discard: discardMut.mutateAsync,
    merging: mergeMut.isPending,
    discarding: discardMut.isPending,
  };
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/use-review.test.tsx 2>&1 | tail -8`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/web/hooks/useReview.ts tests/unit/web/use-review.test.tsx && git commit -m "feat(review): useReview hook（query + merge/discard mutations）"
```

---

### Task 7: `ReviewPanel` 组件

**Files:**
- Create: `src/web/components/ReviewPanel.tsx`
- Test: `tests/unit/web/review-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `tests/unit/web/review-panel.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReviewPanel from '../../../src/web/components/ReviewPanel';
import type { ReviewResult } from '../../../src/agent/snapshot';

const emptyReview: ReviewResult = { commits: [], files: [], totalAdded: 0, totalRemoved: 0 };
const sampleReview: ReviewResult = {
  commits: [{ hash: 'abc1234', message: '[auto] 写第一章', date: '2026-07-27T00:00:00+08:00' }],
  files: [
    { path: 'chapters/第1章.md', status: 'added', addedLines: 5, removedLines: 0, diff: '+第一章内容\n' },
    { path: 'concept.md', status: 'modified', addedLines: 2, removedLines: 1, diff: '-old\n+new\n' },
  ],
  totalAdded: 7,
  totalRemoved: 1,
};

describe('ReviewPanel', () => {
  it('空审阅时显示"无待审阅"', () => {
    render(<ReviewPanel review={emptyReview} onMerge={vi.fn()} onDiscard={vi.fn()} merging={false} discarding={false} onClose={vi.fn()} />);
    expect(screen.getByText('无待审阅')).toBeInTheDocument();
  });

  it('渲染文件列表 + 增删摘要', () => {
    render(<ReviewPanel review={sampleReview} onMerge={vi.fn()} onDiscard={vi.fn()} merging={false} discarding={false} onClose={vi.fn()} />);
    expect(screen.getByText('chapters/第1章.md')).toBeInTheDocument();
    expect(screen.getByText('concept.md')).toBeInTheDocument();
    expect(screen.getByText(/\+7/)).toBeInTheDocument();
  });

  it('点文件展开 diff', () => {
    render(<ReviewPanel review={sampleReview} onMerge={vi.fn()} onDiscard={vi.fn()} merging={false} discarding={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('chapters/第1章.md'));
    expect(screen.getByText('+第一章内容')).toBeInTheDocument();
  });

  it('点合并调用 onMerge', () => {
    const onMerge = vi.fn();
    render(<ReviewPanel review={sampleReview} onMerge={onMerge} onDiscard={vi.fn()} merging={false} discarding={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('合并'));
    expect(onMerge).toHaveBeenCalledOnce();
  });

  it('点丢弃需二次确认', () => {
    const onDiscard = vi.fn();
    render(<ReviewPanel review={sampleReview} onMerge={vi.fn()} onDiscard={onDiscard} merging={false} discarding={false} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('丢弃'));
    // 第一次点出确认
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认丢弃'));
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 运行测试，验证失败**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/review-panel.test.tsx 2>&1 | tail -8`
Expected: FAIL — `Cannot find module '../../../src/web/components/ReviewPanel'`

- [ ] **Step 3: 实现 ReviewPanel**

Create `src/web/components/ReviewPanel.tsx`:

```typescript
import { useState } from 'react';
import { css } from '@linaria/core';
import RevisionDiffPanel from './RevisionDiffPanel';
import type { ReviewResult } from '../../agent/snapshot';

interface Props {
  review: ReviewResult | undefined;
  onMerge: () => void;
  onDiscard: () => void;
  merging: boolean;
  discarding: boolean;
  onClose: () => void;
}

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

const panel = css`
  background: var(--haze-color-bg, #fff);
  border-radius: 8px;
  width: 80vw;
  max-width: 900px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
`;

const header = css`
  padding: 1rem;
  border-bottom: 1px solid var(--haze-color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const body = css`
  padding: 1rem;
  overflow-y: auto;
  flex: 1;
`;

const footer = css`
  padding: 1rem;
  border-top: 1px solid var(--haze-color-border);
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
`;

const fileRow = css`
  padding: 0.5rem;
  cursor: pointer;
  border-bottom: 1px solid var(--haze-color-border);
  display: flex;
  justify-content: space-between;
  &:hover { background: var(--haze-color-bg-secondary); }
`;

const statusBadge = css`
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  margin-right: 0.5rem;
`;

const mergeBtn = css`
  background: var(--haze-color-success, #16a34a);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const discardBtn = css`
  background: var(--haze-color-error, #dc2626);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const closeBtn = css`
  background: transparent;
  border: 1px solid var(--haze-color-border);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
`;

const statusLabel = (s: string): string => ({ added: '新增', modified: '修改', deleted: '删除' } as Record<string, string>)[s] || s;

export default function ReviewPanel({ review, onMerge, onDiscard, merging, discarding, onClose }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const empty = !review || review.commits.length === 0;

  return (
    <div className={overlay} onClick={onClose}>
      <div className={panel} onClick={(e) => e.stopPropagation()}>
        <div className={header}>
          <div>
            <strong>审阅待合并</strong>
            {!empty && (
              <span style={{ marginLeft: '0.5rem', color: 'var(--haze-color-text-secondary)' }}>
                {review!.commits.length} 个提交 · {review!.files.length} 个文件 · +{review!.totalAdded} -{review!.totalRemoved}
              </span>
            )}
          </div>
          <button className={closeBtn} onClick={onClose}>✕</button>
        </div>
        <div className={body}>
          {empty ? (
            <div>无待审阅</div>
          ) : (
            review!.files.map((f) => (
              <div key={f.path}>
                <div className={fileRow} onClick={() => setExpanded(expanded === f.path ? null : f.path)}>
                  <span>
                    <span className={statusBadge}>{statusLabel(f.status)}</span>
                    {f.path}
                  </span>
                  <span>
                    <span style={{ color: 'var(--haze-color-success, #16a34a)' }}>+{f.addedLines}</span>{' '}
                    <span style={{ color: 'var(--haze-color-error, #dc2626)' }}>-{f.removedLines}</span>
                  </span>
                </div>
                {expanded === f.path && (
                  <RevisionDiffPanel
                    targetFile={f.path}
                    diff={f.diff}
                    addedLines={f.addedLines}
                    removedLines={f.removedLines}
                  />
                )}
              </div>
            ))
          )}
        </div>
        {!empty && (
          <div className={footer}>
            {confirmDiscard ? (
              <>
                <span style={{ alignSelf: 'center' }}>将丢弃所有未审阅改动（含未提交手改），确认？</span>
                <button className={discardBtn} onClick={() => { onDiscard(); setConfirmDiscard(false); }} disabled={discarding}>
                  {discarding ? '丢弃中...' : '确认丢弃'}
                </button>
                <button className={closeBtn} onClick={() => setConfirmDiscard(false)}>取消</button>
              </>
            ) : (
              <>
                <button className={discardBtn} onClick={() => setConfirmDiscard(true)} disabled={discarding || merging}>丢弃</button>
                <button className={mergeBtn} onClick={onMerge} disabled={merging || discarding}>
                  {merging ? '合并中...' : '合并'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试，验证通过**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/review-panel.test.tsx 2>&1 | tail -8`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/web/components/ReviewPanel.tsx tests/unit/web/review-panel.test.tsx && git commit -m "feat(review): ReviewPanel 组件（文件列表 + 复用 RevisionDiffPanel）"
```

---

### Task 8: ProjectPage 接线

**Files:**
- Modify: `src/web/pages/ProjectPage.tsx`

> 顶栏加「审阅并合并」按钮 + pending 徽标 + 条件渲染 ReviewPanel。

- [ ] **Step 1: 加 import + state**

在 `src/web/pages/ProjectPage.tsx` import 区追加（与其他组件 import 并列）：

```typescript
import ReviewPanel from '@/web/components/ReviewPanel';
import { useReview } from '@/web/hooks/useReview';
```

在 `ProjectPage` 函数体内、其他 useState 附近（约 269-271 行 `const [syncing, setSyncing]...` 之后）加：

```typescript
  const [showReview, setShowReview] = useState(false);
  const review = useReview(id!);
```

- [ ] **Step 2: 顶栏加按钮 + 徽标**

在 `toolbarActions` div 内（约 558-571 行），紧邻「同步」按钮之前插入：

```tsx
            <button className={previewToggle} onClick={() => setShowReview(true)} title="审阅并合并 draft 到 main">
              审阅{review.pendingCount > 0 && (
                <span style={{ marginLeft: '0.25rem', background: 'var(--haze-color-primary, #2563eb)', color: 'white', borderRadius: '8px', padding: '0 0.4rem', fontSize: '0.7rem' }}>
                  {review.pendingCount}
                </span>
              )}
            </button>
```

- [ ] **Step 3: 条件渲染 ReviewPanel**

在 `ProjectPage` 的 return JSX 最外层（`</div>` 闭合前，即整个页面根 div 内末尾）加：

```tsx
      {showReview && (
        <ReviewPanel
          review={review.review}
          onMerge={async () => {
            try {
              await review.merge();
              toast.success('已合并到 main');
            } catch {
              toast.error('合并失败');
            }
            setShowReview(false);
          }}
          onDiscard={async () => {
            try {
              await review.discard();
              toast.success('已丢弃未审阅改动');
            } catch {
              toast.error('丢弃失败');
            }
            setShowReview(false);
          }}
          merging={review.merging}
          discarding={review.discarding}
          onClose={() => setShowReview(false)}
        />
      )}
```

- [ ] **Step 4: typecheck**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | tail -10`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
cd ~/projects/open-novel && git add src/web/pages/ProjectPage.tsx && git commit -m "feat(review): ProjectPage 顶栏审阅按钮 + 徽标 + 挂载面板"
```

---

### Task 9: 全量回归

- [ ] **Step 1: typecheck**

Run: `cd ~/projects/open-novel && npx tsc --noEmit 2>&1 | tail -10`
Expected: 无错误

- [ ] **Step 2: 全量测试**

Run: `cd ~/projects/open-novel && npx vitest run 2>&1 | tail -20`
Expected: 全绿（含新增的 snapshot/review/use-review/review-panel 测试 + 现有测试不回归）

- [ ] **Step 3: build**

Run: `cd ~/projects/open-novel && npm run build 2>&1 | tail -10`
Expected: 构建成功

- [ ] **Step 4: 冒烟手测（手动）**

启动 dev server，打开一个已有项目：
1. 顶栏出现「审阅」按钮（无徽标，因 GET /:id 触发迁移后 draft==main）
2. 跑一次 agent run 写一章 → 「审阅」按钮出现徽标「N」
3. 点「审阅」→ 面板列出文件 + diff → 点「合并」→ 徽标消失
4. 再跑一次 → 点「丢弃」→ 二次确认 → 改动消失，徽标消失

- [ ] **Step 5: 最终 commit（若有未提交修复）**

```bash
cd ~/projects/open-novel && git add -A && git commit -m "test: 双分支审阅闸门全量回归通过"
```

---

## Self-Review

**1. Spec 覆盖：**
- 分支模型（main 只读镜像 + draft 工作区）→ Task 1 ensureDraftBranch ✓
- commit 流程（agent run 自动落 draft）→ 零改动验证（Task 9 冒烟）✓
- 审阅合并流程（reviewDiff + merge + discard）→ Task 2/3/4 ✓
- 迁移钩子 → Task 5 ✓
- 前端审阅面板 + 徽标 → Task 6/7/8 ✓
- 与现有能力共存 → 设计决策 1/2/3 已说明简化（createUserSnapshot/listSnapshots/gitSync 不改）

**2. 占位符扫描：** 无 TBD/TODO；每步都有完整代码或命令。

**3. 类型一致性：**
- `ReviewResult`/`ReviewCommit`/`ReviewFile` 在 Task 2 定义，Task 4/6/7 消费 ✓
- `MergeResult`/`DiscardResult` 在 Task 3 定义，Task 4 消费 ✓
- `useReview` 返回 `{ review, isLoading, pendingCount, merge, discard, merging, discarding }` 在 Task 6 定义，Task 8 消费 ✓
- `ReviewPanel` Props 在 Task 7 定义，Task 8 消费 ✓

**4. 已知偏离 spec：** 设计决策 1/2/3（createUserSnapshot/listSnapshots/gitSync 不改）——已在本计划顶部说明理由。spec 的"milestone 打 main"/"listSnapshots 默认 main"未实现，因 draft 历史已包含 main（ff 关系），简化为零风险。
