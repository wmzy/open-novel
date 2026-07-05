# 设计：概念/世界观/角色视图补「定向修订」入口

**日期**：2026-07-05
**范围**：open-novel 前端三个结构化视图（ConceptView / WorldView / CharacterView）+ WritingView 收敛
**动机**：当前只有章节（WritingView）有 `✎ 修订` 按钮，能走"外科手术修订"链路（注入文件全文 + 修订意见 + Edit 局部改规则）。概念/世界观/角色三个视图是纯展示，对已有内容的迭代只能走聊天面板的 generate 模式——agent 倾向重写而非局部改，对成熟内容改动过大。补一个一致的修订入口，让作者能定向微调已生成的设定。

---

## 1. 设计概览

新增公共 hook `useFileRevision`，封装"修订某个 `.novel/` 文件"的完整逻辑（弹窗状态 + RevisionDialog 渲染 + onSubmit fetch）。三个结构化视图各加一个 `✎ 修订` 按钮，复用该 hook。同时用同一 hook 收敛 WritingView 现有的内联实现，消除四处重复。

```
ConceptView / WorldView / CharacterView
└─ viewHeaderRow
   ├─ <h3> 标题
   ├─ [✎ 修订] 按钮   ← 新增
   └─ <ViewToolbar/>
{revision.dialog}      ← 新增，条件渲染 <RevisionDialog>

WritingView
└─ 选完章节后 → revision.openDialog(`chapters/第N章.md`)
```

入口：每个视图的 `viewHeaderRow` 内，标题与 `ViewToolbar` 之间。

---

## 2. 公共 hook：`useFileRevision`

**新文件** `src/web/hooks/useFileRevision.ts`

### 2.1 接口

```typescript
import type { ReactNode } from 'react';

interface UseFileRevisionOptions {
  projectId: string;
  targetFile: string;   // 相对 .novel/ 的默认目标，如 'concept.md'；可为 ''（WritingView 延迟指定）
  stage: string;        // 语义 stage，写入 conversation 记录（revise 模式下不影响 agent 指令）
  onClose?: () => void; // 弹窗关闭回调（WritingView 用来清空 reviseChapter；三视图不传）
}

interface UseFileRevisionResult {
  openDialog: (targetFile?: string) => void;  // 不传则用 options.targetFile
  closeDialog: () => void;
  dialog: ReactNode;   // 已挂载的 <RevisionDialog>；未打开时为 null
}

export function useFileRevision(options: UseFileRevisionOptions): UseFileRevisionResult;
```

`openDialog(targetFile?)` 的可选参数服务 WritingView 的"先选章节再开弹窗"场景：默认 targetFile 在 options 里固定（三视图），WritingView 在选完章节后用动态路径调用 `openDialog`。

**渲染规则**：`dialog` 仅在 `isDialogOpen && activeTargetFile` 非空时渲染 `<RevisionDialog>`，否则为 `null`（防止空 targetFile 触发无效 run）。

### 2.2 内部职责

- `useState<boolean>` 管理 `isDialogOpen`
- `useState<string>` 管理当前 `activeTargetFile`（初始为 options.targetFile，openDialog 时覆盖）
- `useAgentSelection()` 取 agentId
- `onSubmit(mode, data)` 处理器：
  - `mode === 'revise'` → `POST /api/runs`，body：
    ```json
    { "projectId", "agentId", "stage", "message": data.revisionNote,
      "mode": "revise", "targetFile": activeTargetFile, "revisionNote": data.revisionNote }
    ```
  - `mode === 'rename'` → `POST /api/projects/:projectId/rename`，body：
    ```json
    { "oldName": data.oldName, "newName": data.newName, "scope": data.scope }
    ```
  - 完成后 `closeDialog()`
- 渲染 `<RevisionDialog projectId activeTargetFile onClose onSubmit>`
- **不处理刷新**——ProjectPage 的 SSE `file-changed` 监听已覆盖 concept.md / world-building.md / characters/* 路径，自动 invalidate 对应 query，视图自动重渲染（见 `ProjectPage.tsx:285-290`）

### 2.3 不在 hook 内做的事

- 不显示 toast（成功/失败由 ChatPanel 的 SSE 流统一呈现，与 WritingView 现状一致）
- 不做 diff 预览（`RevisionDiffPanel` 已在 ChatPanel 全局监听 `revision-applied` 事件）
- 不做撤销（git-based undo 已全局存在）

---

## 3. 三视图接入

### 3.1 ConceptView

```tsx
const revision = useFileRevision({ projectId, targetFile: 'concept.md', stage: 'concept' });

return (
  <div>
    <div className={viewHeaderRow}>
      <h3 className={pageHeading}>故事概念</h3>
      <button className={reviseBtn} onClick={() => revision.openDialog()}>✎ 修订</button>
      <ViewToolbar mode={viewMode} onChange={setViewMode} />
    </div>
    <div className={conceptGrid}>{sections.map(renderElement)}</div>
    {revision.dialog}
  </div>
);
```

### 3.2 WorldView

同构，`targetFile: 'world-building.md'`，`stage: 'world'`。

### 3.3 CharacterView

同构，`targetFile: 'characters/profiles.md'`，`stage: 'characters'`。CharacterView 已有 `viewHeaderRow` + 起名工具切换按钮 + ViewToolbar，修订按钮插在起名工具按钮之前（紧邻标题）。

---

## 4. WritingView 收敛

现有 WritingView 内联实现（`WritingView.tsx:120-214`）：
- `useState<number|null>` `reviseChapter`
- 章节卡片上的 `✎ 修订` 按钮 → `setReviseChapter(c.number)`
- 条件渲染 `<RevisionDialog targetFile={\`chapters/第${reviseChapter}章.md\`}>` + 内联 onSubmit fetch

收敛后：

```tsx
const [reviseChapter, setReviseChapter] = useState<number | null>(null);
const revision = useFileRevision({ projectId, targetFile: '', stage: 'writing' });

// 章节按钮不变：setReviseChapter(c.number)
// 监听 reviseChapter 变化，非 null 时开弹窗
useEffect(() => {
  if (reviseChapter !== null) revision.openDialog(`chapters/第${reviseChapter}章.md`);
}, [reviseChapter]);

// 关闭时同步清空 reviseChapter
// → 通过 closeDialog 包装或在 useEffect 里处理
```

WritingView 传 `onClose: () => setReviseChapter(null)`，弹窗关闭时同步清空章节选择。三视图不传 `onClose`，无副作用。

---

## 5. 样式：`reviseBtn` 提取共享

WritingView 现有 `reviseBtn` css（`WritingView.tsx:92-97`）迁移到 `viewShared.tsx` 导出，四视图共用。

---

## 6. 边界情况

| 场景 | 处理 |
|---|---|
| 文件不存在（视图显示 EmptyState） | 三视图在 `!data` / `sections.length===0` 时早返回，根本走不到 header，按钮不渲染——天然安全 |
| agent 未响应/超时 | 沿用 ChatPanel SSE 错误展示，hook 不重复处理 |
| WritingView `targetFile: ''` 初始空值 | 仅作占位，实际调用必带 `openDialog(具体路径)`；hook 在 `activeTargetFile` 为空时不渲染 dialog |
| 视图未激活 | dialog 受 `isDialogOpen` 控制，不渲染 |

---

## 7. 验证方式

1. `pnpm typecheck` → `pnpm test` → `pnpm build`（项目铁律）
2. 手动 E2E：
   - 创建项目 → `/concept` 生成概念 → 切到概念视图 → 点 `✎ 修订` → 填"把核心冲突改为…" → 确认 agent 用 Edit 工具改了 `.novel/concept.md` → 视图自动刷新看到新内容
   - 同样验证世界观、角色视图
   - 验证 WritingView 章节修订未被破坏（回归）
3. 重命名路径（CharacterView 的 rename 模式）回归：选角色→改全项目

---

## 8. 不做的事（YAGNI）

- ❌ 卡片级修订（每个 section 一个按钮）——文件级入口 + 意见里指明"改第 X 张卡片"足够
- ❌ diff 预览——`RevisionDiffPanel` 全局监听已覆盖
- ❌ 修订历史——超出范围
- ❌ 后端改动——`mode:'revise'` 链路已完整可用，纯前端工作

---

## 9. 影响文件清单

| 文件 | 改动 |
|---|---|
| `src/web/hooks/useFileRevision.ts` | **新建** 公共 hook |
| `src/web/components/views/viewShared.tsx` | 新增 `reviseBtn` 样式导出 |
| `src/web/components/views/ConceptView.tsx` | 接入 hook + 按钮 |
| `src/web/components/views/WorldView.tsx` | 接入 hook + 按钮 |
| `src/web/components/views/CharacterView.tsx` | 接入 hook + 按钮 |
| `src/web/components/views/WritingView.tsx` | 收敛内联实现为 hook 调用 |

零后端改动，零数据库改动。
