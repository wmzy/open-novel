# 修订循环（Revision Loop）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 open-novel 添加「修订已有内容」能力——语义修订走 agent（`mode=revise`），机械重命名走确定性引擎，两者混合。

**Architecture:** `runs` 表加 `mode`/`payload` 两列区分生成与修订。修订模式注入目标文件全文 + REVISE_INSTRUCTIONS，agent 用 Edit 做外科手术修改。重命名是独立确定性端点，复用 naming tool 的 `checkName` 预检。diff 用 run-local 快照（启动时读入内存）。

**Tech Stack:** Hono (API)、Drizzle (ORM/PGlite)、React 19 + Linaria (前端)、`diff` npm 包 (unified diff)

---

## 延迟项（spec §3.6 跨文件语义传播）

Spec §3.6 描述了「让角色 X 在所有出场章节都更 Y」的批量修订能力。该功能依赖本计划的核心修订 run（mode=revise）已就绪，逻辑上独立——先交付单文件修订 + 重命名，验证可用后再加批量传播。

**实施前提**：Task 1-9 全部完成并 E2E 验证通过。
**预计工作量**：1 个额外 Task（后端批量 revise run 循环 + propagate-progress 事件 + 前端进度 UI）。

---

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/db/schema.ts` | runs 表加 mode/payload 列 | 修改 |
| `drizzle/` | 新 migration SQL | 生成 |
| `src/shared/rename.ts` | 确定性重命名引擎（扫描+替换+预检） | 新建 |
| `src/api/routes/rename.ts` | `POST /api/projects/:id/rename` 端点 | 新建 |
| `src/api-app.ts` | 注册 renameRouter | 修改 |
| `src/agent/prompt-composer.ts` | REVISE_INSTRUCTIONS + revise 模式组装 | 修改 |
| `src/api/routes/runs.ts` | POST handler 加 mode=revise 分支 + close handler diff | 修改 |
| `src/shared/diff-utils.ts` | `createUnifiedDiff` + `summarizeDiff` 工具函数 | 新建 |
| `src/web/hooks/useRun.ts` | 处理 revision-applied / rename-done 事件 | 修改 |
| `src/web/components/RevisionDiffPanel.tsx` | diff 渲染组件 | 新建 |
| `src/web/components/RevisionDialog.tsx` | 统一修订弹窗 | 新建 |
| `src/web/components/views/*.tsx` | 各视图加「修订」按钮 | 修改 |
| `tests/unit/shared/rename.test.ts` | 重命名引擎测试 | 新建 |
| `tests/unit/agent/prompt-composer.test.ts` | revise 模式测试 | 修改 |
| `tests/unit/api/rename.test.ts` | rename API 测试 | 新建 |

---

## Task 1: 数据模型 — runs 表加 mode/payload 列

**Files:**
- Modify: `src/db/schema.ts:51-58`
- Generate: `drizzle/0003_*.sql`

- [ ] **Step 1: 在 schema.ts 的 runs 表加两列**

在 `src/db/schema.ts` 的 `runs` 表定义中，`finishedAt` 之后加：

```typescript
export const runs = pgTable('runs', {
  id: varchar('id', { length: 50 }).primaryKey(),
  conversationId: varchar('conversation_id', { length: 25 }).references(() => conversations.id, { onDelete: 'set null' }),
  agent: varchar('agent', { length: 50 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('queued'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  // 新增：区分 generate / revise / rename
  mode: varchar('mode', { length: 20 }).notNull().default('generate'),
  // 新增：模式特定数据（revise 的 targetFile/baseSnapshot/diff，rename 的 oldName/newName/scope）
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
});
```

- [ ] **Step 2: 生成 migration**

Run: `pnpm db:generate`
Expected: 生成 `drizzle/0003_*.sql`，内容为：
```sql
ALTER TABLE "runs" ADD COLUMN "mode" varchar(20) NOT NULL DEFAULT 'generate';--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "payload" jsonb;
```

- [ ] **Step 3: typecheck 验证**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 启动 server 验证 migration 自动执行**

Run: `timeout 10 npm run dev 2>&1 | grep -i "migrat\|error" | head -5`
Expected: 无报错（migration 在 ensureDbReady 中自动执行）

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: runs 表加 mode/payload 列支持修订模式"
```

---

## Task 2: 重命名引擎 — 共享层

**Files:**
- Create: `src/shared/rename.ts`
- Test: `tests/unit/shared/rename.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/shared/rename.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performRename, findSubstringConflicts } from '../../../src/shared/rename';

describe('findSubstringConflicts', () => {
  it('检测 oldName 是其他全名子串的情况', () => {
    const allNames = ['宋江', '宋清', '林冲', '吴用'];
    const conflicts = findSubstringConflicts('沈', allNames);
    expect(conflicts).toEqual(['宋江', '宋清']);
  });

  it('oldName 是精确全名时无冲突', () => {
    const allNames = ['宋江', '宋清', '林冲'];
    const conflicts = findSubstringConflicts('宋江', allNames);
    expect(conflicts).toEqual([]);
  });

  it('空名字列表返回空', () => {
    expect(findSubstringConflicts('沈', [])).toEqual([]);
  });
});

describe('performRename', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-test-'));
    // 模拟 .novel 结构
    const novelDir = path.join(tempDir, '.novel');
    await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
    await fs.mkdir(path.join(novelDir, 'characters'), { recursive: true });
    await fs.writeFile(
      path.join(novelDir, 'characters', 'profiles.md'),
      '## 一、宋清（主角）\n\n宋清站在破庙前。\n',
    );
    await fs.writeFile(
      path.join(novelDir, 'chapters', '第1章.md'),
      '# 第一章\n\n宋清推开了门。宋清看见师父。\n',
    );
    await fs.writeFile(
      path.join(novelDir, 'chapters', '第2章.md'),
      '# 第二章\n\n这一章没有主角出场。\n',
    );
    await fs.writeFile(
      path.join(novelDir, 'state.json'),
      JSON.stringify({
        characters: [{ name: '宋清', role: '主角' }],
        timeline: '宋清到达衡山',
        lastUpdatedChapter: 1,
        updatedAt: '2026-01-01',
      }),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('精确全名替换到所有匹配文件', async () => {
    const result = await performRename(tempDir, '宋清', '林寒声');
    expect(result.filesModified).toBe(3); // profiles.md + 第1章.md + state.json
    expect(result.totalReplacements).toBe(4); // profiles 2 + 第1章 2 + state 2

    const ch1 = await fs.readFile(path.join(tempDir, '.novel', 'chapters', '第1章.md'), 'utf-8');
    expect(ch1).toContain('林寒声');
    expect(ch1).not.toContain('宋清');

    const ch2 = await fs.readFile(path.join(tempDir, '.novel', 'chapters', '第2章.md'), 'utf-8');
    expect(ch2).not.toContain('林寒声'); // 未出场文件不被修改

    const state = JSON.parse(await fs.readFile(path.join(tempDir, '.novel', 'state.json'), 'utf-8'));
    expect(state.characters[0].name).toBe('林寒声');
  });

  it('scope 限定只替换指定文件', async () => {
    const result = await performRename(tempDir, '宋清', '林寒声', {
      scope: ['.novel/characters/profiles.md'],
    });
    expect(result.filesModified).toBe(1);

    const ch1 = await fs.readFile(path.join(tempDir, '.novel', 'chapters', '第1章.md'), 'utf-8');
    expect(ch1).toContain('宋清'); // 未在 scope 中，不变
  });

  it('无匹配时 filesModified=0', async () => {
    const result = await performRename(tempDir, '不存在的人', '某人');
    expect(result.filesModified).toBe(0);
    expect(result.totalReplacements).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/unit/shared/rename.test.ts`
Expected: FAIL — `Cannot find module '../../../src/shared/rename'`

- [ ] **Step 3: 实现 performRename 和 findSubstringConflicts**

创建 `src/shared/rename.ts`：

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';

export interface RenameResult {
  filesModified: number;
  totalReplacements: number;
  /** 每个文件的替换数（相对路径 → 次数） */
  perFile: Record<string, number>;
}

export interface RenameOptions {
  /** 限定扫描的文件相对路径数组（相对于 projectDir）。省略 = 全 .novel 目录。 */
  scope?: string[];
}

/**
 * 检测 oldName 是否是其他全名的子串。
 * @param oldName 要替换的名字
 * @param allNames profiles.md 中提取的所有角色全名
 * @returns 包含 oldName 为子串的其他全名列表（精确匹配的不算）
 */
export function findSubstringConflicts(oldName: string, allNames: string[]): string[] {
  if (!oldName) return [];
  return allNames.filter((n) => n !== oldName && n.includes(oldName));
}

/**
 * 扫描 .novel 目录下所有需要做替换的文件路径。
 * 包括 .md 文件 + state.json + foreshadow.json + outline-meta.json。
 */
async function collectTargetFiles(projectDir: string, scope?: string[]): Promise<string[]> {
  if (scope && scope.length > 0) {
    return scope.map((s) => (path.isAbsolute(s) ? s : path.join(projectDir, s)));
  }
  // 全 .novel 扫描
  const novelDir = path.join(projectDir, '.novel');
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(full);
      } else if (
        entry.endsWith('.md') ||
        entry === 'state.json' ||
        entry === 'foreshadow.json' ||
        entry === 'outline-meta.json'
      ) {
        results.push(full);
      }
    }
  }

  await walk(novelDir);
  return results;
}

/**
 * 执行确定性重命名：在所有目标文件中将 oldName 精确替换为 newName。
 * 零 agent 调用，瞬时完成。
 */
export async function performRename(
  projectDir: string,
  oldName: string,
  newName: string,
  options?: RenameOptions,
): Promise<RenameResult> {
  if (!oldName || !newName || oldName === newName) {
    return { filesModified: 0, totalReplacements: 0, perFile: {} };
  }

  const files = await collectTargetFiles(projectDir, options?.scope);
  let filesModified = 0;
  let totalReplacements = 0;
  const perFile: Record<string, number> = {};

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    // 统计出现次数
    const count = countOccurrences(content, oldName);
    if (count === 0) continue;

    const newContent = content.split(oldName).join(newName); // replaceAll 兼容写法
    await fs.writeFile(filePath, newContent, 'utf-8');

    filesModified++;
    totalReplacements += count;
    const rel = path.relative(projectDir, filePath);
    perFile[rel] = count;
  }

  return { filesModified, totalReplacements, perFile };
}

/** 统计子串出现次数（不依赖正则，避免特殊字符问题）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/unit/shared/rename.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: typecheck**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/shared/rename.ts tests/unit/shared/rename.test.ts
git commit -m "feat: 确定性重命名引擎——精确全名替换+子串冲突检测"
```

---

## Task 3: 重命名 API 端点

**Files:**
- Create: `src/api/routes/rename.ts`
- Modify: `src/api-app.ts`
- Test: `tests/unit/api/rename.test.ts`

- [ ] **Step 1: 写失败的 API 测试**

创建 `tests/unit/api/rename.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apiApp } from '../../../src/api-app';

// 测试用独立 PGlite 实例避免污染开发数据库
vi.mock('../../../src/db/drizzle', async () => {
  const { drizzle } = await import('drizzle-orm/pglite');
  const { PGlite } = await import('@electric-sql/pglite');
  const pglite = new PGlite(path.join(os.tmpdir(), `rename-api-test-${Date.now()}`));
  const db = drizzle(pglite);
  return { db, isPglite: true, ensureDbReady: vi.fn(async () => {}), closeDb: vi.fn() };
});

describe('POST /api/projects/:id/rename', () => {
  let tempDir: string;
  let projectId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-api-'));
    const novelDir = path.join(tempDir, '.novel');
    await fs.mkdir(path.join(novelDir, 'characters'), { recursive: true });
    await fs.writeFile(
      path.join(novelDir, 'characters', 'profiles.md'),
      '## 一、宋清（主角）\n\n## 二、宋江（反派）\n',
    );
    // 项目记录插入 DB（省略，用 mock）
    projectId = 'test-proj-1';
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('端点存在并返回 400 当缺少 oldName/newName', async () => {
    // 用真实 Hono app 测试——验证端点注册和参数校验
    // 完整的替换逻辑由 Task 2 的 performRename 单测覆盖
    const res = await apiApp.request('/api/projects/fake-proj/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('required');
  });
});
```

> **注**：API 级单测因依赖 DB mock 较重，核心逻辑由 Task 2 的 `performRename` 单测覆盖。API 测试聚焦端点注册和错误处理。完整 E2E 在 Task 9。

- [ ] **Step 2: 实现 rename 端点**

创建 `src/api/routes/rename.ts`：

```typescript
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { resolveProjectDir } from '../../shared/project-dir';
import { performRename, findSubstringConflicts } from '../../shared/rename';
import { checkName } from '../../shared/naming/name-checker';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot } from '../../agent/snapshot';
import { syncFilesToDb } from '../../agent/artifacts';

const renameRouter = new Hono();

/**
 * 从 profiles.md 提取所有角色全名（用于子串冲突检测 + checkName 的 existingNames）。
 */
async function loadAllCharacterNames(projectDir: string): Promise<string[]> {
  try {
    const content = await readFile(
      path.join(projectDir, '.novel', 'characters', 'profiles.md'),
      'utf-8',
    );
    const names: string[] = [];
    for (const line of content.split('\n')) {
      // 匹配 "## 一、宋清（主角）" 或 "### 宋清"
      const m = line.match(/^#{2,3}\s+(?:[一二三四五六七八九十\d]+[、.]\s*)?([^\s（(]+)/);
      if (m && m[1] && m[1].length >= 2) {
        names.push(m[1]);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * 确定性重命名端点。
 *
 * POST /api/projects/:projectId/rename
 * body: { oldName, newName, scope? }
 *
 * 流程：预检 checkName → 子串冲突检测 → 扫描替换 → 结构化同步 → git 快照
 */
renameRouter.post('/projects/:projectId/rename', async (c) => {
  const { projectId } = c.req.param();
  const { oldName, newName, scope } = await c.req.json();

  if (!oldName || !newName) {
    return c.json({ error: 'oldName and newName are required' }, 400);
  }

  const projectDir = await resolveProjectDir(projectId);
  const allNames = await loadAllCharacterNames(projectDir);

  // 1. 预检：checkName(newName) —— 谐音/碰撞/语音/相似/生僻
  const preCheck = checkName(newName, allNames.filter((n) => n !== oldName));
  if (preCheck.warnings.length > 0) {
    return c.json({
      error: 'precheck_failed',
      warnings: preCheck.warnings,
      checks: preCheck.checks,
    }, 409);
  }

  // 2. 子串冲突检测：oldName 不能是其他全名的子串
  const conflicts = findSubstringConflicts(oldName, allNames);
  if (conflicts.length > 0) {
    return c.json({
      error: 'precheck_failed',
      substringConflicts: conflicts,
      message: `"${oldName}" 是以下全名的子串，请使用精确全名：${conflicts.join('、')}`,
    }, 409);
  }

  // 3. 执行确定性替换
  const result = await performRename(projectDir, oldName, newName, scope ? { scope } : undefined);

  // 4. git 快照
  const snapshot = await createSnapshot(
    projectDir,
    `rename: ${oldName}→${newName}, ${result.filesModified} files, ${result.totalReplacements} replacements`,
  ).catch(() => null);

  // 5. 回写 DB（章节记录可能有标题变化）
  if (result.filesModified > 0) {
    const modifiedPaths = new Set(Object.keys(result.perFile));
    await syncFilesToDb(projectId, modifiedPaths, projectDir).catch(() => {});
  }

  return c.json({
    filesModified: result.filesModified,
    totalReplacements: result.totalReplacements,
    perFile: result.perFile,
    snapshot,
    newNameValid: true,
  });
});

export default renameRouter;
```

- [ ] **Step 3: 注册路由**

在 `src/api-app.ts` 的 import 区加：

```typescript
import renameRouter from './api/routes/rename';
```

在路由注册区（backupRouter 之后）加：

```typescript
app.route('/api', renameRouter);
```

- [ ] **Step 4: typecheck**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 运行测试**

Run: `npx vitest run tests/unit/shared/rename.test.ts tests/unit/api/rename.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/rename.ts src/api-app.ts tests/unit/api/rename.test.ts
git commit -m "feat: POST /api/projects/:id/rename 端点——确定性重命名+预检"
```

---

## Task 4: composePrompt revise 模式

**Files:**
- Modify: `src/agent/prompt-composer.ts`
- Test: `tests/unit/agent/prompt-composer.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `tests/unit/agent/prompt-composer.test.ts` 末尾的最后一个 `});` 之前加新 describe block：

```typescript
  describe('revise 模式', () => {
    it('revise 模式注入 REVISE_INSTRUCTIONS 和目标文件全文', async () => {
      // 先创建目标文件
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      await fs.writeFile(
        path.join(novelDir, 'chapters', '第1章.md'),
        '# 第一章\n\n这是已有的正文内容。\n',
      );

      const prompt = await composePrompt({
        message: '主角太冷，加温度',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
        mode: 'revise',
        reviseTarget: 'chapters/第1章.md',
        reviseNote: '主角太冷，加温度',
        reviseContent: '# 第一章\n\n这是已有的正文内容。\n',
      });
      expect(prompt).toContain('修订已有内容');
      expect(prompt).toContain('这是已有的正文内容');
      expect(prompt).toContain('主角太冷，加温度');
      expect(prompt).toContain('外科手术');
      expect(prompt).not.toContain('聚焦于构思核心概念'); // 不注入阶段指令
    });

    it('revise 模式目标是章节时注入核心设定层', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'chapters'), { recursive: true });
      await fs.writeFile(path.join(novelDir, 'concept.md'), '这是一个武侠故事。');
      await fs.writeFile(
        path.join(novelDir, 'chapters', '第1章.md'),
        '# 第一章\n\n正文。\n',
      );

      const prompt = await composePrompt({
        message: '修改',
        projectId: 'p',
        stage: 'writing',
        projectDir: tempDir,
        mode: 'revise',
        reviseTarget: 'chapters/第1章.md',
        reviseNote: '修改',
        reviseContent: '# 第一章\n\n正文。\n',
      });
      expect(prompt).toContain('核心设定层');
      expect(prompt).toContain('这是一个武侠故事');
    });

    it('revise 模式目标是设定文件时不注入章节摘要', async () => {
      const novelDir = path.join(tempDir, '.novel');
      await fs.mkdir(path.join(novelDir, 'characters'), { recursive: true });
      await fs.writeFile(path.join(novelDir, 'concept.md'), '概念。');
      await fs.writeFile(
        path.join(novelDir, 'characters', 'profiles.md'),
        '## 一、主角\n\n角色描述。\n',
      );

      const prompt = await composePrompt({
        message: '让主角更立体',
        projectId: 'p',
        stage: 'characters',
        projectDir: tempDir,
        mode: 'revise',
        reviseTarget: 'characters/profiles.md',
        reviseNote: '让主角更立体',
        reviseContent: '## 一、主角\n\n角色描述。\n',
      });
      expect(prompt).toContain('修订已有内容');
      expect(prompt).not.toContain('滚动摘要层'); // 设定文件修订不需要章节摘要
    });
  });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: FAIL — `mode` 属性不存在 / revise 相关断言失败

- [ ] **Step 3: 扩展 ComposePromptOptions**

在 `src/agent/prompt-composer.ts` 的 `ComposePromptOptions` interface 加字段：

```typescript
export interface ComposePromptOptions {
  message: string;
  projectId: string;
  skillId?: string;
  stage?: string;
  projectDir: string;
  history?: { role: string; content: string }[];
  /** 运行模式：generate（默认，生成全新）或 revise（修订已有文件）。 */
  mode?: 'generate' | 'revise';
  /** revise 模式：目标文件相对路径。 */
  reviseTarget?: string;
  /** revise 模式：用户修订意见。 */
  reviseNote?: string;
  /** revise 模式：目标文件当前全文。 */
  reviseContent?: string;
}
```

- [ ] **Step 4: 定义 REVISE_INSTRUCTIONS**

在 `prompt-composer.ts` 的 `STAGE_INSTRUCTIONS` 定义之后加：

```typescript
/** 修订模式的指令模板（替代 STAGE_INSTRUCTIONS）。 */
function buildReviseInstructions(reviseContent: string, reviseNote: string): string {
  return `## 当前任务：修订已有内容

你不是在从零创作，而是在对一份已有的文件做**定向修订**。

### 目标文件
以下是你需要修订的文件全文（已读入上下文，无需再 Read）：

\`\`\`
${reviseContent}
\`\`\`

### 修订意见
${reviseNote}

### 修订规则（严格遵守）

1. **必须用 Edit 工具做外科手术修改**——只改动与修订意见直接相关的段落，其余原封不动。
2. **禁止重写整篇**——如果你的改动会超过文件 30% 的内容，停下来在回复里说明原因，建议用户将修订拆分为多次。
3. **保留原文风格**——修订是定向调整，不是风格重写。不要"顺手"优化你没被要求改的句子。
4. **保存修改**——用 Edit 工具直接修改原文件（Edit 会直接写盘，不需要额外的 Write）。对整个文件的重建式改动才用 Write。
5. **简短说明**——在回复中用 2-3 句话说明你改了什么、为什么，便于用户判断是否符合预期。`;
}
```

- [ ] **Step 5: 在 composePrompt 函数体中加 revise 分支**

在 `composePrompt` 函数体中，`const { message, projectId, skillId, stage, projectDir, history } = options;` 改为解构出新增字段：

```typescript
  const { message, projectId, skillId, stage, projectDir, history,
          mode = 'generate', reviseTarget, reviseNote, reviseContent } = options;
```

在 `const STAGE_MISMATCH_HINT = detectStageMismatch(message, stage);` 之后加：

```typescript
  // revise 模式判断：targetFile 是否为章节正文（路径以 chapters/第 开头）
  const isChapterTarget = mode === 'revise' && reviseTarget
    ? /^chapters[/\\]第\d+章\.md$/.test(reviseTarget)
    : false;
```

在 `const parts: string[] = [];` 之后、注入阶段指令的逻辑处，用条件分支包裹。找到现有的：

```typescript
  // Stage-specific instructions
  const currentStage = stage || 'concept';
  const stageInstructions = STAGE_INSTRUCTIONS[currentStage] || `着手推进小说项目的「${currentStage}」阶段。`;
```

改为：

```typescript
  // Stage-specific instructions (generate 模式) 或 revise 指令 (revise 模式)
  const currentStage = stage || 'concept';
  const isRevise = mode === 'revise' && reviseNote && reviseContent;

  const stageInstructions = isRevise
    ? buildReviseInstructions(reviseContent!, reviseNote!)
    : STAGE_INSTRUCTIONS[currentStage] || `着手推进小说项目的「${currentStage}」阶段。`;
```

然后找到注入 writing 阶段上下文层的条件块：

```typescript
  // 写作阶段：注入字数目标 + 分层上下文（核心设定 / 状态 / 滚动摘要 / 活跃伏笔）
  if (isWritingStage(currentStage)) {
```

改为（revise 模式也需要上下文层，但条件不同）：

```typescript
  // 写作阶段（generate）或章节修订（revise）：注入字数目标 + 分层上下文
  const needsWritingContext = isWritingStage(currentStage) || (isRevise && isChapterTarget);
  if (needsWritingContext) {
```

在这个 if 块内部，活跃伏笔层的注入条件加 revise 排除：

```typescript
    // 定向提醒：本章须埋设的伏笔，置顶于分层上下文之前（仅 generate 模式）
    if (mode === 'generate') {
      const chapterForeshadow = await buildCurrentChapterForeshadows(projectDir, currentChapter);
      if (chapterForeshadow) {
        parts.push(`\n${chapterForeshadow}`);
      }
    }
```

对于 revise 模式但目标不是章节（设定文件）的情况，在 if 块之后加：

```typescript
  // revise 模式 + 设定文件：只注入 concept.md 作为高层锚点
  if (isRevise && !isChapterTarget) {
    const concept = await readNovelFile(projectDir, 'concept.md');
    if (concept) {
      parts.push(`\n### 核心设定锚点\n${concept}`);
    }
  }
```

最后，SKILL 指令注入条件加 revise 排除。找到：

```typescript
  if (skillContent) {
    parts.push(`\n## Skill Instructions\n${skillContent}`);
  }
```

改为：

```typescript
  if (skillContent && mode !== 'revise') {
    parts.push(`\n## Skill Instructions\n${skillContent}`);
  }
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: PASS — 所有测试包括新增 3 个 revise 测试

- [ ] **Step 7: typecheck**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/agent/prompt-composer.ts tests/unit/agent/prompt-composer.test.ts
git commit -m "feat: composePrompt revise 模式——REVISE_INSTRUCTIONS+上下文层裁剪"
```

---

## Task 5: runs.ts POST handler — mode=revise 分支 + diff 生成

**Files:**
- Modify: `src/api/routes/runs.ts:175-240`
- Create: `src/shared/diff-utils.ts`
- Test: `tests/unit/shared/diff-utils.test.ts`

- [ ] **Step 1: 安装 diff 包**

Run: `pnpm add diff && pnpm add -D @types/diff`

- [ ] **Step 2: 写 diff-utils 测试**

创建 `tests/unit/shared/diff-utils.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { createUnifiedDiff, summarizeDiff } from '../../../src/shared/diff-utils';

describe('createUnifiedDiff', () => {
  it('相同内容返回空 diff', () => {
    const diff = createUnifiedDiff('same', 'same', 'file.md');
    expect(diff).toBe('');
  });

  it('不同内容生成 unified diff', () => {
    const diff = createUnifiedDiff('line1\nline2\n', 'line1\nchanged\n', 'file.md');
    expect(diff).toContain('-line2');
    expect(diff).toContain('+changed');
    expect(diff).toContain('line1'); // 上下文行
  });

  it('文件名出现在 diff header', () => {
    const diff = createUnifiedDiff('a', 'b', 'chapters/第3章.md');
    expect(diff).toContain('第3章.md');
  });
});

describe('summarizeDiff', () => {
  it('统计添加和删除行数', () => {
    const diff = `--- a/file.md\n+++ b/file.md\n@@ -1,3 +1,3 @@\n context\n-deleted\n+added\n unchanged`;
    const summary = summarizeDiff(diff);
    expect(summary.addedLines).toBe(1);
    expect(summary.removedLines).toBe(1);
  });

  it('空 diff 返回 0', () => {
    const summary = summarizeDiff('');
    expect(summary.addedLines).toBe(0);
    expect(summary.removedLines).toBe(0);
  });
});
```

- [ ] **Step 3: 运行测试验证失败**

Run: `npx vitest run tests/unit/shared/diff-utils.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 4: 实现 diff-utils**

创建 `src/shared/diff-utils.ts`：

```typescript
import { createPatch } from 'diff';

/**
 * 生成两段文本之间的 unified diff。
 * @param oldContent 修改前内容
 * @param newContent 修改后内容
 * @param filePath 文件路径（用于 diff header）
 * @returns unified diff 字符串，内容相同时返回空串
 */
export function createUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  if (oldContent === newContent) return '';
  const fileName = filePath.split('/').pop() || filePath;
  return createPatch(fileName, oldContent, newContent, '', '', { context: 3 });
}

export interface DiffSummary {
  addedLines: number;
  removedLines: number;
}

/**
 * 从 unified diff 字符串统计添加/删除行数。
 */
export function summarizeDiff(diff: string): DiffSummary {
  if (!diff) return { addedLines: 0, removedLines: 0 };
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) addedLines++;
    else if (line.startsWith('-') && !line.startsWith('---')) removedLines++;
  }
  return { addedLines, removedLines };
}
```

- [ ] **Step 5: 运行 diff-utils 测试**

Run: `npx vitest run tests/unit/shared/diff-utils.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: 在 runs.ts POST handler 中加 mode=revise 分支**

在 `src/api/routes/runs.ts` 的 POST handler 中，解析 body 时取出 mode 和 revise 字段。

找到 `const body = await c.req.json();` 改为：

```typescript
  const body = await c.req.json();
  const { projectId, agentId, skillId, stage, message, conversationId, model,
          mode = 'generate', targetFile, revisionNote } = body;
```

找到 `const composedPrompt = await composePrompt({...})`，扩展传入 mode 字段：

```typescript
  // revise 模式：读取目标文件当前全文作为上下文 + baseSnapshot
  let reviseContent: string | undefined;
  let baseSnapshot: string | undefined;
  if (mode === 'revise' && targetFile) {
    const projectDir = await resolveProjectDir(projectId);
    const fullPath = path.isAbsolute(targetFile) ? targetFile : path.join(projectDir, targetFile);
    try {
      reviseContent = await readFile(fullPath, 'utf-8');
      baseSnapshot = reviseContent; // 快照 = 修改前全文
    } catch {
      return c.json({ error: `Target file not found: ${targetFile}` }, 404);
    }
  }

  const composedPrompt = await composePrompt({
    message,
    projectId,
    skillId,
    stage,
    projectDir: await resolveProjectDir(projectId),
    history: history.length > 0 ? history : undefined,
    mode,
    reviseTarget: targetFile,
    reviseNote: revisionNote,
    reviseContent,
  });
```

- [ ] **Step 7: 在 close handler 中生成 diff（仅 mode=revise）**

在 close handler 中，`await db.update(runsTable).set({...})` 之前加 diff 生成逻辑。找到 `// Update run record` 之前：

```typescript
    // revise 模式：生成 diff 并 emit revision-applied 事件
    if (mode === 'revise' && targetFile && baseSnapshot !== undefined) {
      try {
        const projectDir = await resolveProjectDir(projectId);
        const fullPath = path.isAbsolute(targetFile) ? targetFile : path.join(projectDir, targetFile);
        const newContent = await readFile(fullPath, 'utf-8');
        const { createUnifiedDiff, summarizeDiff } = await import('../../shared/diff-utils');
        const diff = createUnifiedDiff(baseSnapshot, newContent, targetFile);
        const summary = summarizeDiff(diff);

        // 更新 run payload
        await db.update(runsTable).set({
          payload: { targetFile, revisionNote, baseSnapshot, diff },
        }).where(eq(runsTable.id, run.id)).execute();

        // 通知前端
        emitEvent(run, 'agent', {
          type: 'revision-applied',
          targetFile,
          addedLines: summary.addedLines,
          removedLines: summary.removedLines,
          diffPreview: diff.slice(0, 2000), // 前 2000 字符预览
        });
      } catch {}
    }
```

- [ ] **Step 8: typecheck + 全量测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 无错误，全部测试通过

- [ ] **Step 9: Commit**

```bash
git add src/shared/diff-utils.ts tests/unit/shared/diff-utils.test.ts src/api/routes/runs.ts package.json
git commit -m "feat: revise run diff 生成——run-local 快照+unified diff+revision-applied 事件"
```

---

## Task 6: 前端 — RevisionDiffPanel 组件

**Files:**
- Create: `src/web/components/RevisionDiffPanel.tsx`
- Test: `tests/unit/web/revision-diff-panel.test.ts`

- [ ] **Step 1: 写组件测试**

创建 `tests/unit/web/revision-diff-panel.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { summarizeDiff } from '../../../src/shared/diff-utils';

// 组件渲染测试需要 jsdom 环境，这里测核心数据逻辑
describe('RevisionDiffPanel 数据逻辑', () => {
  it('summarizeDiff 正确统计', () => {
    const diff = `--- a/第3章.md\n+++ b/第3章.md\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx`;
    const s = summarizeDiff(diff);
    expect(s.addedLines).toBe(1);
    expect(s.removedLines).toBe(1);
  });
});
```

> **注**：组件视觉测试依赖 jsdom + Linaria，核心 diff 解析逻辑由 `diff-utils.test.ts` 覆盖。组件结构简单（diff 行渲染），E2E 在 Task 9 验证。

- [ ] **Step 2: 实现 RevisionDiffPanel**

创建 `src/web/components/RevisionDiffPanel.tsx`：

```tsx
import { useState } from 'react';
import { css } from '@linaria/core';

interface Props {
  targetFile: string;
  diff: string;
  addedLines: number;
  removedLines: number;
}

const container = css`
  margin-top: 0.75rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow: hidden;
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--haze-color-bg-secondary, #f6f6f6);
  font-size: 0.8rem;
  cursor: pointer;
  user-select: none;
`;

const fileName = css`
  font-weight: 600;
  color: var(--haze-color-text);
`;

const stats = css`
  display: flex;
  gap: 0.75rem;
  font-size: 0.72rem;
`;

const added = css`
  color: #16a34a;
`;

const removed = css`
  color: #dc2626;
`;

const diffBody = css`
  max-height: 400px;
  overflow-y: auto;
  padding: 0.5rem 0.75rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
`;

const lineAdded = css`
  color: #16a34a;
  background: rgba(22, 163, 74, 0.08);
`;

const lineRemoved = css`
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
`;

const lineContext = css`
  color: var(--haze-color-text-secondary, #888);
`;

const MAX_LINES_BEFORE_COLLAPSE = 200;
const VISIBLE_LINES_WHEN_COLLAPSED = 50;

/** 修订差异面板：展示 unified diff，可折叠。 */
export default function RevisionDiffPanel({ targetFile, diff, addedLines, removedLines }: Props) {
  const [expanded, setExpanded] = useState(false);

  const lines = diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  const shouldCollapse = lines.length > MAX_LINES_BEFORE_COLLAPSE;
  const visibleLines = shouldCollapse && !expanded
    ? lines.slice(0, VISIBLE_LINES_WHEN_COLLAPSED)
    : lines;

  return (
    <div className={container}>
      <div className={header} onClick={() => setExpanded(!expanded)}>
        <span className={fileName}>{targetFile}</span>
        <span className={stats}>
          <span className={added}>+{addedLines}</span>
          <span className={removed}>-{removedLines}</span>
        </span>
      </div>
      <div className={diffBody}>
        {visibleLines.map((line, i) => {
          let cls = lineContext;
          if (line.startsWith('+')) cls = lineAdded;
          else if (line.startsWith('-')) cls = lineRemoved;
          return (
            <div key={i} className={cls}>{line || ' '}</div>
          );
        })}
        {shouldCollapse && !expanded && (
          <div
            className={lineContext}
            style={{ cursor: 'pointer', padding: '0.5rem', textAlign: 'center' }}
            onClick={() => setExpanded(true)}
          >
            ▾ 展开全部（共 {lines.length} 行）
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: typecheck + 测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 无错误，全部通过

- [ ] **Step 4: Commit**

```bash
git add src/web/components/RevisionDiffPanel.tsx tests/unit/web/revision-diff-panel.test.ts
git commit -m "feat: RevisionDiffPanel——unified diff 渲染+折叠+行高亮"
```

---

## Task 7: 前端 — useRun 处理 revision-applied 事件

**Files:**
- Modify: `src/web/hooks/useRun.ts`

- [ ] **Step 1: 在 handleAgentEvent 中加 revision-applied 处理**

在 `src/web/hooks/useRun.ts` 的 `handleAgentEvent` 函数中，找到现有的 `case 'quality-warning'` 或类似的事件处理分支区，加：

```typescript
      case 'revision-applied': {
        const { targetFile, addedLines, removedLines, diffPreview } = data;
        if (assistantArtifactsRef.current) {
          assistantArtifactsRef.current.revisionDiff = {
            targetFile,
            diff: diffPreview || '',
            addedLines,
            removedLines,
          };
        }
        break;
      }
```

同时在 `ChatMessage` interface 中加可选字段：

```typescript
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  events?: AgentEvent[];
  startedAt?: number;
  endedAt?: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  error?: string;
  artifacts?: { count: number; paths: string[] };
  revisionDiff?: { targetFile: string; diff: string; addedLines: number; removedLines: number };
}
```

- [ ] **Step 2: 在 ChatPanel 中渲染 RevisionDiffPanel**

在 `src/web/components/ChatPanel.tsx` 中，找到消息渲染区域，在有 `revisionDiff` 的消息底部加：

```tsx
{msg.revisionDiff && msg.revisionDiff.diff && (
  <RevisionDiffPanel
    targetFile={msg.revisionDiff.targetFile}
    diff={msg.revisionDiff.diff}
    addedLines={msg.revisionDiff.addedLines}
    removedLines={msg.revisionDiff.removedLines}
  />
)}
```

并在文件顶部 import：

```typescript
import RevisionDiffPanel from './RevisionDiffPanel';
```

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/web/hooks/useRun.ts src/web/components/ChatPanel.tsx
git commit -m "feat: useRun+ChatPanel 处理 revision-applied 事件并渲染 diff"
```

---

## Task 8: 前端 — RevisionDialog 弹窗 + 各视图接入

**Files:**
- Create: `src/web/components/RevisionDialog.tsx`
- Modify: `src/web/components/views/*.tsx`

- [ ] **Step 1: 实现 RevisionDialog**

创建 `src/web/components/RevisionDialog.tsx`：

```tsx
import { useState, useEffect } from 'react';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';

interface Props {
  projectId: string;
  targetFile: string;        // 相对路径，如 "chapters/第3章.md"
  onClose: () => void;
  onSubmit: (mode: 'revise' | 'rename', data: { revisionNote?: string; oldName?: string; newName?: string; scope?: string[] }) => void;
}

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

const dialog = css`
  background: var(--haze-color-bg, #fff);
  border-radius: 8px;
  padding: 1.5rem;
  width: 480px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
`;

const modeToggle = css`
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
`;

const modeBtn = css`
  padding: 0.4rem 1rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 0.85rem;
  &.active {
    background: var(--haze-color-primary, #3b82f6);
    color: white;
    border-color: var(--haze-color-primary, #3b82f6);
  }
`;

const textarea = css`
  width: 100%;
  min-height: 80px;
  padding: 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-size: 0.85rem;
  resize: vertical;
`;

const input = css`
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-size: 0.85rem;
`;

const label = css`
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
  color: var(--haze-color-text);
`;

const warning = css`
  color: #dc2626;
  font-size: 0.78rem;
  margin-top: 0.3rem;
`;

const actions = css`
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
`;

/** 统一修订弹窗：修订内容 / 重命名 二选一。 */
export default function RevisionDialog({ projectId, targetFile, onClose, onSubmit }: Props) {
  const [mode, setMode] = useState<'revise' | 'rename'>('revise');
  const [revisionNote, setRevisionNote] = useState('');
  const [oldName, setOldName] = useState('');
  const [newName, setNewName] = useState('');
  const [nameWarning, setNameWarning] = useState('');
  const [scopeAll, setScopeAll] = useState(true);

  // 从 state.json 加载角色名列表（用于重命名下拉）
  const { data: characters } = useQuery({
    queryKey: ['characters', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/state`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.characters || []).map((c: { name: string }) => c.name) as string[];
    },
    enabled: mode === 'rename',
  });

  // 新名校验（失焦时）
  async function checkNewName(name: string) {
    if (!name || name.length < 2) { setNameWarning(''); return; }
    try {
      const res = await fetch(`/api/projects/${projectId}/naming/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, existingNames: characters || [] }),
      });
      const data = await res.json();
      if (data.warnings && data.warnings.length > 0) {
        setNameWarning(data.warnings.join('；'));
      } else {
        setNameWarning('');
      }
    } catch {
      setNameWarning('');
    }
  }

  function handleSubmit() {
    if (mode === 'revise') {
      if (!revisionNote.trim()) return;
      onSubmit('revise', { revisionNote });
    } else {
      if (!oldName || !newName) return;
      onSubmit('rename', { oldName, newName, scope: scopeAll ? undefined : [targetFile] });
    }
  }

  return (
    <div className={overlay} onClick={onClose}>
      <div className={dialog} onClick={(e) => e.stopPropagation()}>
        <div className={modeToggle}>
          <button className={`${modeBtn} ${mode === 'revise' ? 'active' : ''}`} onClick={() => setMode('revise')}>
            修订内容
          </button>
          <button className={`${modeBtn} ${mode === 'rename' ? 'active' : ''}`} onClick={() => setMode('rename')}>
            重命名
          </button>
        </div>

        {mode === 'revise' && (
          <>
            <label className={label}>修订意见（{targetFile}）</label>
            <textarea
              className={textarea}
              value={revisionNote}
              onChange={(e) => setRevisionNote(e.target.value)}
              placeholder="例：主角太冷，加一场与师父的温情戏"
            />
          </>
        )}

        {mode === 'rename' && (
          <>
            <label className={label}>旧名（从角色列表选择）</label>
            <select className={input} value={oldName} onChange={(e) => setOldName(e.target.value)}>
              <option value="">— 选择角色 —</option>
              {(characters || []).map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <label className={label} style={{ marginTop: '0.75rem' }}>新名</label>
            <input
              className={input}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={(e) => checkNewName(e.target.value)}
              placeholder="输入新名字"
            />
            {nameWarning && <div className={warning}>{nameWarning}</div>}
            <label style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', fontSize: '0.82rem' }}>
              <input type="checkbox" checked={scopeAll} onChange={(e) => setScopeAll(e.target.checked)} />
              全项目替换（取消则仅当前文件）
            </label>
          </>
        )}

        <div className={actions}>
          <button onClick={onClose} className={modeBtn}>取消</button>
          <button
            onClick={handleSubmit}
            className={`${modeBtn} active`}
            disabled={mode === 'revise' ? !revisionNote.trim() : !oldName || !newName}
          >
            执行修订
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 ChapterView 中加修订按钮**

在 `src/web/components/views/ChapterView.tsx` 的 toolbar 区域加「修订」按钮（参考 CharacterView 的 NamingPanel 集成方式）。在组件顶部加：

```tsx
import RevisionDialog from '../RevisionDialog';

// 组件内：
const [showRevision, setShowRevision] = useState(false);

// toolbar 中：
<button className={namingToggleBtn} onClick={() => setShowRevision(true)}>
  ✎ 修订
</button>

// 组件底部：
{showRevision && (
  <RevisionDialog
    projectId={projectId}
    targetFile={`chapters/第${chapterNum}章.md`}
    onClose={() => setShowRevision(false)}
    onSubmit={async (mode, data) => {
      if (mode === 'revise') {
        await fetch(`/api/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            agentId: 'claude-code',
            stage: 'writing',
            message: data.revisionNote,
            mode: 'revise',
            targetFile: `chapters/第${chapterNum}章.md`,
            revisionNote: data.revisionNote,
          }),
        });
      } else {
        await fetch(`/api/projects/${projectId}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldName: data.oldName, newName: data.newName, scope: data.scope }),
        });
      }
      setShowRevision(false);
    }}
  />
)}
```

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: Commit**

```bash
git add src/web/components/RevisionDialog.tsx src/web/components/views/ChapterView.tsx
git commit -m "feat: RevisionDialog 弹窗+ChapterView 修订入口"
```

---

## Task 9: E2E 验证

- [ ] **Step 1: 启动服务器**

Run: `npm run dev` (后台运行，确认端口 3006)

- [ ] **Step 2: 验证 naming API 挂载路径**

RevisionDialog 的 `checkNewName` 调用 `/api/projects/${projectId}/naming/check`。需确认 namingRouter 的实际挂载路径——运行 `grep -n 'namingRouter\|app.route.*naming' src/api-app.ts` 确认。如果挂在 `/api/naming` 而非 `/api/projects/:id/naming`，则 RevisionDialog 中的 fetch URL 需改为 `/api/naming/check`。

- [ ] **Step 3: 重命名 E2E 测试**

Run:
```bash
# 假设有龙魂凤血项目
curl -s -X POST http://localhost:3006/api/projects/proj_xxx/rename \
  -H "Content-Type: application/json" \
  -d '{"oldName":"宋清","newName":"林寒声"}' | python3 -m json.tool
```
Expected: `{ "filesModified": N, "totalReplacements": M, "newNameValid": true }`

验证：
```bash
grep -r "宋清" ~/projects/longhun-fengxue/.novel/ | wc -l  # 应为 0
grep -r "林寒声" ~/projects/longhun-fengxue/.novel/ | wc -l  # 应 > 0
```

- [ ] **Step 3: 修订 E2E 测试**

Run:
```bash
curl -s -X POST http://localhost:3006/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "proj_xxx",
    "agentId": "claude-code",
    "stage": "writing",
    "mode": "revise",
    "targetFile": "chapters/第3章.md",
    "revisionNote": "主角太冷，加一场与师父的温情戏",
    "message": "主角太冷，加一场与师父的温情戏"
  }' | python3 -m json.tool
```
Expected: run 成功，`revision-applied` 事件包含非空 diff

- [ ] **Step 4: 回滚（重命名回原名）**

```bash
curl -s -X POST http://localhost:3006/api/projects/proj_xxx/rename \
  -H "Content-Type: application/json" \
  -d '{"oldName":"林寒声","newName":"宋清"}'
```

- [ ] **Step 5: 全量测试回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck ✅, 全部测试通过

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test: E2E 验证修订循环——重命名+语义修订"
```
