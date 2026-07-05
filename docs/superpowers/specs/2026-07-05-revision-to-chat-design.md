# 修订改造：视图/卡片修订改为提交到右侧对话框

**日期**：2026-07-05
**状态**：设计中
**背景**：当前视图/卡片的 ✎ 修订按钮通过 `useFileRevision` 直接 `POST /api/runs`（fire-and-forget），用户看不到 agent 思考过程、看不到 diff 面板（revision-applied 事件无人接）。改造目标：让修订走右侧 ChatPanel 对话流，复用已有的流式渲染 + diff 展示能力。

## 目标

- 视图/卡片的 ✎ 修订 → 进入右侧 ChatPanel「修订模式」，用户在对话框写意见、手动发送
- 发送时走 `mode='revise'` 完整流程（后端读文件注入 prompt、SSE 流式响应、生成 diff、RevisionDiffPanel 显示）
- rename（机械改名）保留独立轻量 UI，不走 agent 对话流
- 移除原 RevisionDialog 弹窗的 revise 部分

## 非目标（YAGNI）

- 不改后端 `/api/runs` 对 `mode='revise'` 的处理（已完整支持）
- 不改 ViewRouter 的 props 传递（views 不需要新增 agentId/skillId prop）
- 不引入 React Context 层（事件总线足够）
- 不把 rename 改成走 agent（保留确定性改名引擎的可靠性）
- EditorPanel/RewritePanel（章节正文局部重写）不在本次范围，保持原样

## 现状分析

### 当前 revise 数据流（fire-and-forget）

```
卡片 ✎ → useFileRevision.openDialog() → 渲染 RevisionDialog
       → 用户填意见 → handleSubmit → fetch('/api/runs', { mode:'revise', targetFile, revisionNote })
       → 静默等待 → file-changed SSE → 视图刷新
```

问题：runId 未读、SSE 未连、revision-applied 事件（含 diff）丢弃、用户无反馈。

### ChatPanel 对话流（完整）

```
ChatPanel 输入 → useRun.sendMessage({ projectId, agentId, skillId, stage, message })
              → POST /api/runs + 读 runId + 连 SSE
              → 流式渲染 assistant 消息
              → revision-applied 事件 → msg.revisionDiff → RevisionDiffPanel
```

问题：sendMessage 当前**不传** `mode/targetFile/revisionNote`，所以 revise 流程跑不起来。

### 架构障碍

`useRun` 在 ChatPanel 内部实例化，view/useFileRevision 拿不到 `sendMessage`。

## 设计

### 方案选型：事件总线

三条跨组件传递路径对比：

| 方案 | 改动量 | 代价 |
|------|--------|------|
| **A. 事件总线**（采用） | 小 | 隐式耦合，但项目已有 `AGENT_CHANGE_EVENT` 先例 |
| B. 提升 useRun 到 ProjectPage + Context | 大 | ChatPanel 全面重构（messages/isRunning/cancel 全改 Context） |
| C. ref 命令模式 | 中 | 首渲染 ref 为 null，类型不安全；命令式 API 与 React 范式相悖 |

**选 A**：与项目现有 `open-novel:agent-change` 事件总线模式一致，改动最聚焦，views 的 props 完全不动。

### 数据流

```
卡片 ✎ 修订 → useFileRevision.openRevise()
            → window.dispatchEvent('open-novel:revise-to-chat', { targetFile, sectionTitle })
            → ChatPanel useEffect 监听
            → setState pendingRevise = { targetFile, sectionTitle }
            → 输入框聚焦 + 显示修订提示条

用户写意见 → 点发送
          → sendMessage({ ..., mode:'revise', targetFile, revisionNote:意见 })
          → 清空 pendingRevise
          → 后端走 revise 全流程 → SSE → RevisionDiffPanel
```

### 各组件改动

#### 1. `useRun.sendMessage` 扩展（`src/web/hooks/useRun.ts`）

签名增加可选字段：
```ts
sendMessage(params: {
  projectId, agentId, skillId, stage, message,
  model?,
  mode?: 'generate' | 'revise',      // 新增
  targetFile?: string,                // 新增
  revisionNote?: string,              // 新增
})
```
透传到 `/api/runs` body。后端无需改——`runs.ts:228` 已读这些字段。

#### 2. `useFileRevision` 改造（`src/web/hooks/useFileRevision.ts`）

返回值变更：
```ts
interface UseFileRevisionResult {
  openRevise: (targetFile?: string, sectionTitle?: string) => void;  // 新：dispatch 事件
  openRename: (targetFile?: string) => void;                          // 新：开 RenameDialog
  closeRename: () => void;                                            // 新
  renameDialog: ReactNode;                                            // 新：只含 rename UI
}
```

- `openRevise`：dispatch `open-novel:revise-to-chat` 事件，payload `{ targetFile, sectionTitle }`
- `openRename`：开 RenameDialog（原 RevisionDialog 拆出 rename 部分）
- 移除 revise 的 fetch 分支
- 移除 `useAgentSelection`（不再直接发 run，agent 由 ChatPanel 提供）

#### 3. ChatPanel 监听 + 修订模式（`src/web/components/ChatPanel.tsx`）

新状态：
```ts
const [pendingRevise, setPendingRevise] = useState<{
  targetFile: string;
  sectionTitle?: string;
} | null>(null);
```

监听：
```ts
useEffect(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    setPendingRevise(detail);
    // 聚焦输入框
    inputRef.current?.focus();
  };
  window.addEventListener('open-novel:revise-to-chat', handler);
  return () => window.removeEventListener('open-novel:revise-to-chat', handler);
}, []);
```

发送逻辑改造（`sendMessage` 包装）：
```ts
// 发送时若处于修订模式，附加 mode/targetFile/revisionNote
const submitMessage = (text: string) => {
  if (pendingRevise) {
    const note = pendingRevise.sectionTitle
      ? `【定向修订：仅修改「${pendingRevise.sectionTitle}」这一节】\n${text}`
      : text;
    sendMessage({
      ..., message: text,  // 对话记录显示用户原文
      mode: 'revise',
      targetFile: pendingRevise.targetFile,
      revisionNote: note,   // 后端注入 prompt 用带锚点的版本
    });
    setPendingRevise(null);
  } else {
    sendMessage({ ..., message: text });
  }
};
```

UI 改造：
- 输入框上方条件渲染修订提示条：`📌 正在修订 {targetFile}{sectionTitle ? ` · ${sectionTitle}` : ''} [✕]`
- ✕ → `setPendingRevise(null)`
- placeholder 动态：修订模式时显示"输入对 {targetFile} 的修订意见..."
- 切换对话（loadConversation/resetConversation）时清空 pendingRevise

#### 4. RenameDialog 拆出（`src/web/components/RenameDialog.tsx` 新文件）

从 RevisionDialog 拆出 rename 相关 UI：
- 去掉 mode toggle（固定 rename 模式）
- 保留：oldName 输入（带 characters 下拉）、newName 输入、checkName 预检、scope 选择
- title 显示"重命名 · {targetFile}"
- onSubmit 只调 rename 分支（`/api/projects/.../rename`）

原 RevisionDialog.tsx 删除（revise 部分不再需要弹窗，rename 部分迁到 RenameDialog）。

#### 5. 按钮拆分（4 个 view + viewShared）

视图顶部"✎ 修订"按钮 → 拆两个：
- `✎ 修订` → `openRevise()`
- `⇄ 重命名` → `openRename()`

卡片级"✎"按钮 → 拆两个图标按钮：
- `✎` → `openRevise(undefined, sectionTitle)`
- `⇄` → `openRename()`（rename 是实体级，不带 sectionTitle）

WritingView 特殊：只有章节级 ✎ 修订按钮（`openRevise('chapters/第N章.md')`），无 rename（章节文件名不通过此改名）。

涉及文件：
- `ConceptView.tsx`、`WorldView.tsx`、`CharacterView.tsx`（视图顶部 + 卡片级）
- `WritingView.tsx`（仅章节级 revise）
- `viewShared.tsx`（新增 `renameBtn` 样式，导出按钮样式复用）

### 交互细节

**进入修订模式**：
- 输入框自动聚焦
- 提示条显示目标文件（+ section 标题）
- 用户可正常切换 stage、查看其他视图（pendingRevise 保留）
- 若用户切换对话（/new、loadConversation），清空 pendingRevise

**发送**：
- 修订模式下发送 → 带 mode/targetFile/revisionNote，清空 pendingRevise
- 非修订模式发送 → 普通消息（原行为）

**退出修订模式**：
- 点提示条 ✕
- 切换对话
- 发送后自动退出

**stage 一致性**：
事件 payload 不带 stage——ChatPanel 用自己当前的 `stage` prop（保持与对话上下文一致）。openRevise 不强制切 stage，但 views 在渲染时若 stage 不匹配仍可触发（修订不依赖 stage 正确，只影响对话记录分类）。

## 影响范围

### 改动文件
- `src/web/hooks/useRun.ts`（sendMessage 签名扩展）
- `src/web/hooks/useFileRevision.ts`（返回值重构）
- `src/web/components/ChatPanel.tsx`（监听 + 修订模式 UI）
- `src/web/components/RenameDialog.tsx`（新文件，从 RevisionDialog 拆出）
- `src/web/components/RevisionDialog.tsx`（删除）
- `src/web/components/views/ConceptView.tsx`
- `src/web/components/views/WorldView.tsx`
- `src/web/components/views/CharacterView.tsx`
- `src/web/components/views/WritingView.tsx`
- `src/web/components/views/viewShared.tsx`（新增 renameBtn 样式）

### 不动
- 后端（`/api/runs`、`/rename`、prompt-composer）
- ViewRouter props
- ProjectPage 结构
- EditorPanel/RewritePanel
- useAgentSelection

## 测试策略

### 更新现有测试
- `useFileRevision` 相关测试：revise 不再 fetch，改断言 `window.dispatchEvent` 被 call 且 payload 正确；rename 仍走 fetch
- 删除 RevisionDialog 相关测试（若有），新增 RenameDialog 测试

### 新增测试
- ChatPanel 修订模式：
  - 监听 `open-novel:revise-to-chat` 事件 → 设置 pendingRevise
  - 修订模式下发送 → sendMessage 收到 mode/targetFile/revisionNote
  - 非修订模式发送 → sendMessage 不带 mode
  - ✕ 退出 → pendingRevise 清空
- useRun.sendMessage：透传 mode/targetFile/revisionNote 到 fetch body

### E2E 验证
- 角色视图卡片 ✎ 修订 → ChatPanel 输入框聚焦 + 提示条显示
- 输入意见发送 → 对话流出现 assistant 响应 + RevisionDiffPanel
- 卡片 ⇄ 重命名 → RenameDialog 弹出（轻量）
- WritingView 章节 ✎ 修订 → 修订模式 targetFile 为章节路径

## 风险

1. **事件总线隐式耦合**：ChatPanel 必须挂载才能收到事件。当前架构 ChatPanel 始终渲染（ProjectPage 右侧固定面板），无风险。若未来 ChatPanel 条件渲染，需改为 Context。
2. **pendingRevise 跨 stage 残留**：用户点 ✎ 后切到别的视图再回来，pendingRevise 仍在。设计为「保留」（用户可能想跨视图准备意见），✕ 可手动清空。
3. **revisionNote 与 message 不一致**：section 级修订时，message 是用户原文（对话记录可读），revisionNote 是带锚点版本（后端注入 prompt）。这是有意设计，已在原 useFileRevision 注释说明。
