# 设计：三视图卡片级修订（section 级定向修订入口）

**日期**：2026-07-05
**范围**：ConceptView / WorldView / CharacterView 三视图的卡片级 ✎ 入口；`useFileRevision` hook 扩展
**动机**：上一轮交付了文件级修订入口（视图头部一个 ✎，注入整个文件 + 修订意见）。作者反馈想做更细粒度的定向修订——「只改核心冲突那张卡」「只改力量体系那张卡」。当前必须靠在意见里手写卡名定位，体验粗糙。给每张卡片单独一个 ✎，让定向锚点自动注入。

---

## 1. 设计概览

在每张卡片标题栏加一个紧凑 ✎ 按钮（新样式 `cardReviseBtn`）。点击 → 复用现有 `useFileRevision` + `RevisionDialog`，但多传一个 `sectionTitle`，hook 在拼装 fetch body 时把 section 标题作为定向锚点前置进 `revisionNote`。

文件级头部 ✎ 保留不变（粗修订入口仍存在）。

```
卡片标题栏：[ ## 标题文字 ........... ✎ ]
                          ↓ onClick
revision.openDialog(undefined, s.title)
                          ↓ onSubmit (revise)
revisionNote 前置定向锚点 → POST /api/runs (mode: 'revise')
                          ↓
buildReviseInstructions 收到带锚点的意见，agent 用 Edit 改对应 section
```

**粒度决策（已与用户确认）**：section 级统一。`parseSections()` 把 md 文件的 `##` 标题切成 `MdSection`，每段一张卡。
- ConceptView：section = 概念要素（核心冲突、一句话梗概、主角成长弧线…）→ 精准对应一张概念卡
- WorldView：section = 类别（地理、社会、力量体系…）→ 精准对应一张类别卡
- CharacterView：section = 角色分组（核心角色、师门、敌对势力…）→ 对应一组角色；单角色靠意见里写「改主角」定位（与上一轮决策一致）

---

## 2. hook 扩展：`useFileRevision`

### 2.1 接口变更（向后兼容，加性扩展）

```typescript
export interface UseFileRevisionResult {
  /** 打开弹窗。
   *  @param targetFile 可选，覆盖 options.targetFile（WritingView 选完章节后传具体路径）
   *  @param sectionTitle 可选，section 级定向锚点（卡片级 ✎ 传入 section 标题） */
  openDialog: (targetFile?: string, sectionTitle?: string) => void;
  closeDialog: () => void;
  dialog: ReactNode;
}
```

### 2.2 内部状态新增

- `useState<string | undefined>` 管理 `activeSectionTitle`（初始 `undefined`）
- `openDialog` 第二参写入该 state
- `closeDialog` 重置为 `undefined`（避免下次打开串味）

### 2.3 onSubmit（revise 分支）锚点注入

`activeSectionTitle` 非空时，`revisionNote` 前置定向提示：

```typescript
const note = activeSectionTitle
  ? `【定向修订：仅修改「${activeSectionTitle}」这一节（## 标题），其余原封不动】\n${data.revisionNote}`
  : data.revisionNote;

// fetch body:
{
  projectId, agentId, stage,
  message: note,        // ← 用拼接后的 note
  mode: 'revise',
  targetFile: activeTargetFile,
  revisionNote: note,   // ← 同上，对话记录里也带锚点（用户友好：一眼知道改的哪张卡）
}
```

rename 分支不受影响（卡片级只走 revise）。

### 2.4 为什么前端拼，不改后端

| | 方案 A：前端拼意见 | 方案 B：后端 targetSection 参数 |
|---|---|---|
| 改动范围 | 仅 `useFileRevision` + 三视图接线 | 还要改 `buildReviseInstructions` + fetch body schema + runs 路由 |
| agent 定位 | 靠注入全文 + 意见里的 `## 标题` 锚点；`buildReviseInstructions` 已有「只改与意见直接相关的段落」规则，锚点是更强的定位信号 | 靠后端独立 section 指令字段 |
| 对话记录 | revisionNote 带【定向修订】前缀 → 用户一眼看到改的是哪张卡（**正向收益**） | revisionNote 干净，但定向信息藏在后端指令里，用户看对话记录不知道改了哪 |
| 风险 | 低，agent 行为已被 WritingView 章节修订验证（注入全文 + 定向意见 → Edit 局部改） | 中，动后端 + 破坏上一轮「零后端改动」原则 |

选 **A**。B 的唯一收益（对话记录干净）不抵其后端复杂度，且 A 的「对话记录带锚点」反而是用户友好特性。

---

## 3. 卡片标题栏布局

现状（`viewShared.tsx:97-104`）：`cardTitle` 是带分隔线的标题 div——
```css
font-size: 0.95rem; font-weight: 600; color: var(--haze-color-text);
margin: 0 0 0.75rem; padding-bottom: 0.5rem;
border-bottom: 1px solid var(--haze-color-border);
```

改动：`cardTitle` 自身升级为 flex 容器（保留全部分隔线/字重样式），内部标题文字包一层 `<span>` 占满剩余空间，✎ 按钮靠右。**不新增 `cardTitleRow`**——分隔线必须横跨整行，若拆成单独的 row 容器，分隔线只会跟在 span 文字下方，破坏视觉。

```tsx
<div className={cardTitle}>           {/* 现有 div，加 display:flex */}
  <span className={cardTitleText}>{s.title}</span>
  <button className={cardReviseBtn} onClick={() => revision.openDialog(undefined, s.title)}>✎</button>
</div>
```

**样式变更（viewShared.tsx）**：

```typescript
/** 卡片标题：升级为 flex 容器（标题文字 + 修订按钮）。保留原分隔线。 */
export const cardTitle = css`
  display: flex;           /* 新增 */
  align-items: baseline;   /* 新增 */
  gap: 0.5rem;             /* 新增 */
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--haze-color-text);
  margin: 0 0 0.75rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

/** 卡片标题文字：占满剩余空间，把按钮推到最右。 */
export const cardTitleText = css`
  flex: 1;
`;

/** 卡片级修订按钮：紧凑、低视觉权重，不抢卡片主信息。 */
export const cardReviseBtn = css`
  flex-shrink: 0;
  margin-left: auto;       /* 在 flex 容器里推到最右；兄弟有 flex:1 时为 no-op */
  font-size: 0.7rem;
  padding: 0.1rem 0.35rem;
  color: var(--haze-color-text-secondary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.15s, background 0.15s;
  &:hover { opacity: 1; background: var(--haze-color-bg-hover, rgba(255,255,255,0.05)); }
`;
```

CharacterView 用的是独立的 `charHeader`（非 `cardTitle`），按钮直接加进 `charHeader`，不受此改动影响。

---

## 4. 三视图接线

### 4.1 ConceptView

`renderElement` 内，当前：
```tsx
<div className={cardTitle + (highlight ? ' ' + conceptHighlightTitle : '')}>{s.title}</div>
```
改为：
```tsx
<div className={cardTitle + (highlight ? ' ' + conceptHighlightTitle : '')}>
  <span className={cardTitleText}>{s.title}</span>
  <button className={cardReviseBtn} onClick={() => revision.openDialog(undefined, s.title)}>✎</button>
</div>
```

### 4.2 WorldView

`renderCategory` 内，当前：
```tsx
<div className={cardTitle}>{s.title}</div>
```
改为：
```tsx
<div className={cardTitle}>
  <span className={cardTitleText}>{s.title}</span>
  <button className={cardReviseBtn} onClick={() => revision.openDialog(undefined, s.title)}>✎</button>
</div>
```

### 4.3 CharacterView

分组卡片 `charHeader` 内加按钮。当前：
```tsx
<div className={charHeader}>
  <span className={roleBadge} style={{ background: role.color }}>{role.label}</span>
  {name && <span className={charName}>{name}</span>}
</div>
```
改为：
```tsx
<div className={charHeader}>
  <span className={roleBadge} style={{ background: role.color }}>{role.label}</span>
  {name && <span className={charName}>{name}</span>}
  <button className={cardReviseBtn} onClick={() => revision.openDialog(undefined, s.title)}>✎</button>
</div>
```
（`charHeader` 已是 flex，`cardReviseBtn` 自带 `margin-left: auto` 把按钮推到最右。）

CharacterView 的 section 标题是分组名（如「核心角色」），单角色定向靠意见里写角色名——符合上一轮 section 级统一的决策。

---

## 5. WritingView

不变。章节级修订无 section 概念，继续用文件级入口。

---

## 6. 边界情况

| 场景 | 处理 |
|---|---|
| 视图显示 EmptyState（`!data` / `sections.length===0`） | 早返回，根本走不到卡片渲染，无 ✎ 按钮——天然安全 |
| section 标题含特殊字符（`## 一、主角姓名（主角）`） | 原样拼进锚点提示，agent 按 markdown `##` 标题匹配，特殊字符不影响 |
| 卡片 ✎ 打开弹窗后切视图 | `closeDialog` 在 unmount 时不会主动调，但 `isOpen` state 随组件销毁消失，无残留 |
| 用户在卡片弹窗里清空意见提交 | RevisionDialog 自身有 required 校验（沿用现有行为） |
| sectionTitle 串味 | `closeDialog` 重置 `activeSectionTitle = undefined`，下次打开默认无锚点 |
| CharacterView 分组名重复（如多个「其他」分组） | 锚点提示用第一个匹配的 section，agent 行为合理；不在 spec 范围内做去重 |

---

## 7. 验证方式

1. `npm run typecheck` → `npm run test` → `npm run build`（项目铁律）
2. 单元测试扩展：
   - `useFileRevision` 新增用例：`openDialog(undefined, '核心冲突')` 后提交，断言 fetch body 的 `revisionNote` 含【定向修订：仅修改「核心冲突」…】前缀
   - 关闭后重置：再次 `openDialog()`（不带 sectionTitle）提交，断言无前缀
3. 接线冒烟测试扩展：`revision-dialog-wiring.test.tsx` 加用例——ConceptView/WorldView/CharacterView 卡片标题栏渲染 ✎ 按钮，点击打开弹窗
4. 手动 E2E：
   - 打开任一已有项目 → 概念视图 → 任选一张概念卡 → 点 ✎ → 填「把这一节改得更具体」→ 确认 agent 用 Edit 改了 `concept.md` 的对应 section，其余不动 → 视图自动刷新
   - 同样验证世界观、角色视图
   - 回归：文件级头部 ✎ 仍正常工作

---

## 8. 不做的事（YAGNI）

- ❌ 后端改动（`buildReviseInstructions` / fetch body schema / runs 路由）——前端拼锚点足够
- ❌ CharacterView 角色级（解析分组内角色条目 + 映射 `profiles/*.md`）——section 级统一已满足「定向修订」核心诉求，角色级是过度工程
- ❌ diff 预览——`RevisionDiffPanel` 全局监听已覆盖
- ❌ 卡片多选批量修订——超出范围

---

## 9. 影响文件清单

| 文件 | 改动 |
|---|---|
| `src/web/hooks/useFileRevision.ts` | 扩展 `openDialog` 第二参 `sectionTitle`；onSubmit revise 分支锚点注入；closeDialog 重置 |
| `src/web/components/views/viewShared.tsx` | 新增 `cardTitleRow` / `cardTitle`（拆分）/ `cardReviseBtn` 样式导出 |
| `src/web/components/views/ConceptView.tsx` | `renderElement` 卡片标题栏接线 |
| `src/web/components/views/WorldView.tsx` | `renderCategory` 卡片标题栏接线 |
| `src/web/components/views/CharacterView.tsx` | `charHeader` 加按钮 |

零后端改动，零数据库改动。

---

## 10. 对话记录示例（用户体验）

**文件级修订（头部 ✎）**：
> 修订意见：把核心一节改得更具体，补充细节

**卡片级修订（某概念卡 ✎）**：
> 修订意见：【定向修订：仅修改「核心一节」这一节（## 标题），其余原封不动】
> 把这一节改得更具体，补充细节

用户在 ChatPanel 看对话记录时，一眼知道第二条改的是哪张卡。这是方案 A 相对方案 B 的额外用户友好收益。
