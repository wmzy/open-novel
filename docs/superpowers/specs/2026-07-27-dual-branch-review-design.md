# 双分支审阅闸门设计

**Date:** 2026-07-27
**Status:** Approved

## Motivation

### 现状（代码核实）

项目已用 git 做底层存储（`.novel/` 仓库，单分支）。所有写入**事后落盘**，无事前闸门：

| 机制 | 实现 | 审阅时机 |
|---|---|---|
| agent run / rename 后 | `runs.ts:532` `createSnapshot` → `git add -A && commit "[auto] ..."` 直接进主线 | **无审阅，事后落盘** |
| 用户手改（EditorPanel/视图） | 直接落盘，下次 auto snapshot 一起提交 | 无审阅 |
| 单文件 revise | run-local `baseSnapshot`（内存）+ `RevisionDiffPanel` | **事后展示 diff，改动已落盘** |
| 里程碑 | `createUserSnapshot` 打 tag `milestone-<name>` | — |
| 回退 | `restoreSnapshot(hash)` = `git checkout <hash> -- .` | — |

`revision-loop` 设计**刻意避开 git HEAD 做 diff 基线**（spec 里写的理由：并发/穿插 run 时 `HEAD~1` 不可靠），改用 run 启动时读入内存的全文。所以现有 diff 审阅是**单文件、事后、不依赖分支**的。

### 痛点

**事前审阅闸门缺失**：agent 改动在合并到正式版本前，用户无法先看、无法拒绝。所有改动事后才落盘，无法在进入主线前拦截。

## Architecture

### 核心约束：main 是只读镜像

> **main 只能通过"审阅合并"动作更新，从不被直接 commit；所有日常写入（agent run + 用户手改）都落在 draft。**

此约束使 `git merge main draft` **必然 fast-forward，零冲突**。draft 单调前进，main 快进跟上。draft 领先 main 的 commit = 待审阅内容。

代价：main 不能被外部工具直接改（否则破坏 ff 前提）。对单用户本地工具，此约束可接受，需文档说明。

### 分支模型

```
working tree 常驻 draft 分支
├── agent run close handler → createSnapshot 进 draft（语义从 main→draft，后端近乎零改动）
├── 用户手改（EditorPanel/视图）→ 落 draft 工作区（未提交）
├── main = 只读镜像，仅"审阅合并"动作更新（fast-forward）
└── 审阅合并：diff main..draft → 用户确认 → ff main 到 draft / 或丢弃
```

### Commit 流程

- agent run close handler：`createSnapshot` 照常提交。因 working tree 已在 draft，语义自动变为进 draft，**后端近乎零改动**。
- 用户手改：直接落 draft 工作区（未提交）。审阅动作触发时统一 `add -A && commit` 进 draft，确保 diff 完整。
- reject（丢弃整批未审阅）：`git checkout draft && git reset --hard main`，丢弃 draft 自 main 以来的所有 commit + working tree 改动。

> **关于 reset 语义**：在 ff merge 下 `merge 后 reset draft 到 main` 是 no-op（已在同一 commit）。reset 真正有意义的场景是 **reject**。accept 不做 reset（draft 自然在 main 上），reject 用 reset 清空待审阅。

## Components

### 1. 分支操作（`src/agent/snapshot.ts` 扩展）

新增四个纯函数：

- **`ensureDraftBranch(projectDir): Promise<void>`** — 迁移与幂等。检查是否存在 `draft` 分支：
  - 不存在：从当前 HEAD 创建 `draft`，`git checkout draft`
  - 存在但 working tree 不在其上：`git checkout draft`
  - 已在 draft：跳过
- **`reviewDiff(projectDir): Promise<ReviewResult>`** — 审阅数据。流程：
  1. `git add -A`（暂存 working tree 改动，但**不 commit**——用于 diff 完整性）
  2. 若有暂存改动，先 commit 到 draft（确保审阅看到全部内容；commit message `[auto] review checkpoint`）
  3. `git rev-list --count main..draft` → 0 则返回空审阅
  4. `git rev-list main..draft --format=%H|%s|%ai` → 待审阅 commit 列表
  5. `git diff main..draft --stat` → 文件级统计
  6. 对每个文件 `git diff main..draft -- <path>` → unified diff 字符串
  7. 解析增删行数（复用 `summarizeDiff`）
  - 返回 `{ commits: ReviewCommit[], files: ReviewFile[], totalAdded, totalRemoved }`
- **`mergeDraft(projectDir): Promise<{ success, fastForward, hash }>`** — `git checkout main && git merge --ff draft && git checkout draft`
- **`discardDraft(projectDir): Promise<{ success }>`** — `git checkout draft && git reset --hard main`

> **注意 `gitSync`**：现有 `gitSync(dir)` = `git pull --rebase && git push`。双分支后需要明确推送哪个分支。决策：`gitSync` 仅处理当前分支（draft），push/pull 都在 draft 上。main 是本地镜像，不直接 sync。若用户希望 main 也推到远程，由审阅合并后单独处理（v1 不做，文档说明）。

### 2. API（`src/api/routes/review.ts` 新建）

```
GET  /api/projects/:id/review          → ReviewResult（待审阅 commits + per-file diff）
POST /api/projects/:id/review/merge    → ff main 到 draft
POST /api/projects/:id/review/discard  → reset draft 到 main
```

挂载到 `src/api-app.ts`。

### 3. 迁移钩子（`src/api/routes/projects.ts`）

项目打开（`GET /api/projects/:id` 或首次任何文件操作前）调用 `ensureDraftBranch`。幂等，已有 draft 则跳过。

> **不强制重命名现有分支**：保留用户的 `master`/`main`（含 remote 历史）作为 `main` 角色身份；仅新增 `draft`。

### 4. 前端（`src/web/components/ReviewPanel.tsx` 新建）

- 顶栏「审阅并合并」按钮（样式 `previewToggle`）；`git rev-list --count main..draft > 0` 时显示徽标「N 待审阅」（轮询或文件变更事件触发 refetch）
- 点击打开 `ReviewPanel`：
  - 顶部摘要：N 个 commit、M 个文件、+X -Y
  - commit 列表（hash、message、时间）
  - 文件列表：path + 状态（新增/修改/删除）+ `+N -M` 摘要，点开看 per-file unified diff —— **复用 `RevisionDiffPanel`**（其 Props `{ targetFile, diff, addedLines, removedLines }` 完全匹配 `git diff` 输出）
  - 底部「合并 / 丢弃」按钮（丢弃需二次确认）
- 挂载到 `ProjectPage.tsx` 顶栏 `toolbarActions`

### 5. hook（`src/web/hooks/useReview.ts` 新建）

- `useQuery(['review', projectId])` → `GET /review`
- `useMutation` merge / discard → 成功后 invalidate `['review']` + `['snapshots']`
- 触发 refetch 的时机：file-changed SSE 事件、run 结束事件

## 与现有能力的共存

| 现有能力 | 新模型下的处理 |
|---|---|
| `createUserSnapshot`（milestone tag） | **打在 main**（已审阅节点）。若想 milestone 含最新改动，先合并再打——即 milestone 入口先调 merge 再 tag。 |
| `restoreSnapshot(hash)` `git checkout <hash> -- .` | 语义保留：恢复文件到 draft 工作区（未提交）。回退到 main 历史版本时，恢复后走正常审阅合并。 |
| `listSnapshots` `git log` | working tree 在 draft，log 默认是 draft 历史。决策：快照面板新增分支参数，**默认显示 main**（已审阅）历史；未审阅的 draft commit 在审阅面板看。 |
| revise `baseSnapshot` 单文件 diff | 保留作 run 内 revise 的事后展示（与分支级审阅互补，职责不重叠）。 |

## Error Handling

- **reviewDiff 无待审阅**：返回 `{ commits: [], files: [], totalAdded: 0, totalRemoved: 0 }`，前端按钮不显示徽标。
- **merge 非 ff**（理论不应发生，main 被外部改过）：返回错误，提示用户"main 已被外部修改，请检查"。fallback：建议 `git merge` 普通合并（但破坏 ff 前提，需用户知情）。
- **discard 有未 commit 的 working tree 改动**：`reset --hard` 会一并丢弃。discard 前提示"将丢弃所有未审阅改动（含未提交的手改）"。
- **迁移时无 HEAD（空仓库）**：`ensureDraftBranch` 先建 draft 分支并首次 commit。

## Testing Strategy

### 单元测试（`tests/unit/agent/review.test.ts` 新建，归入已有 agent 目录）

每个测试用临时 git 仓库（`mkdtemp` + 真实 `git`）：

- `ensureDraftBranch`：无 draft 时创建并 checkout；已有 draft 幂等；working tree 在 main 时切到 draft
- `reviewDiff`：空审阅（draft==main）；多 commit + 多文件；纯新增/纯删除/修改混合；working tree 有未提交改动时先 checkpoint commit
- `mergeDraft`：ff 成功；merge 后 main==draft
- `discardDraft`：reset 后 draft==main，working tree 干净

### API 测试（`tests/unit/api/review.test.ts` 新建）

- 三个端点的 happy path + 边界（空审阅、无 HEAD）
- 迁移钩子在 `GET /projects/:id` 触发（或首次 review 时）

### 前端测试（`tests/unit/web/review-panel.test.tsx` 新建）

- 空审阅：按钮无徽标，打开面板显示"无待审阅"
- 有审阅：徽标显示 N，文件列表渲染，点开看 diff（mock `GET /review`）
- merge/discard mutation 调用正确端点 + invalidate

## Files to Change

| File | Change |
|------|--------|
| `src/agent/snapshot.ts` | 加 `ensureDraftBranch`/`reviewDiff`/`mergeDraft`/`discardDraft`；`createUserSnapshot` milestone 改打 main（merge 先行）；`listSnapshots` 加分支参数默认 main |
| `src/api/routes/review.ts` | **新建**：三个端点 |
| `src/api-app.ts` | 挂载 review 路由 |
| `src/api/routes/projects.ts` | 项目打开时调 `ensureDraftBranch` |
| `src/web/components/ReviewPanel.tsx` | **新建**：审阅面板 |
| `src/web/hooks/useReview.ts` | **新建**：query + mutations |
| `src/web/pages/ProjectPage.tsx` | 顶栏加按钮 + 徽标 + 挂载 ReviewPanel |
| `tests/unit/agent/review.test.ts` | **新建**：分支操作纯函数测试 |
| `tests/unit/api/review.test.ts` | **新建**：端点测试 |
| `tests/unit/web/review-panel.test.tsx` | **新建**：面板渲染 + 交互 |

## Open / Future

- **per-hunk 接受**（挑选性接受）：v1 不做。fast-forward 语义下，要支持需改 merge 为 cherry-pick + 部分应用，复杂度高。当前 reject 仍是整批粒度。
- **审阅面板可视化 mockup**：v1 用文本布局（文件列表 + 折叠 diff），未来可做更精细 UI。
- **多 run 并发**：单用户本地，v1 不处理并发审阅冲突（多个审阅面板同时开）。`useReview` 加乐观锁即可，但 YAGNI。
