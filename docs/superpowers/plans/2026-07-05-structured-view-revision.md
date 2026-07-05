# 概念/世界观/角色视图修订入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ConceptView / WorldView / CharacterView 补「✎ 修订」入口，复用现有 `mode:'revise'` 链路；同时用公共 hook 收敛 WritingView 的内联修订实现。

**Architecture:** 新建 `useFileRevision` hook 封装「弹窗状态 + RevisionDialog 渲染 + onSubmit fetch」。三个结构化视图各加一个文件级修订按钮调用 hook。WritingView 用同一 hook（通过 `openDialog(targetFile?)` 的可选参数 + `onClose` 回调收敛"先选章节再开弹窗"逻辑）。`reviseBtn` 样式提取到 `viewShared.tsx` 共享。零后端改动——刷新靠现有 SSE `file-changed` 监听。

**Tech Stack:** React 19, @linaria/core, @tanstack/react-query, vitest, @testing-library/react

**Spec:** `docs/superpowers/specs/2026-07-05-structured-view-revision-design.md`

---

## 文件结构

| 文件 | 责任 | 操作 |
|---|---|---|
| `src/web/hooks/useFileRevision.ts` | 公共 hook：封装修订弹窗状态 + RevisionDialog 渲染 + onSubmit fetch | **新建** |
| `tests/unit/web/use-file-revision.test.ts` | hook 单测：开/关、targetFile 覆盖、revise/rename fetch、onClose 回调 | **新建** |
| `src/web/components/views/viewShared.tsx` | 新增共享 `reviseBtn` 样式导出 | 修改 |
| `src/web/components/views/ConceptView.tsx` | 接入 hook + 修订按钮 | 修改 |
| `src/web/components/views/WorldView.tsx` | 接入 hook + 修订按钮 | 修改 |
| `src/web/components/views/CharacterView.tsx` | 接入 hook + 修订按钮 | 修改 |
| `src/web/components/views/WritingView.tsx` | 内联实现收敛为 hook 调用；删除本地 `reviseBtn`、`RevisionDialog`、`useAgentSelection` 直接依赖 | 修改 |
| `tests/unit/web/revision-dialog-wiring.test.tsx` | 视图接线冒烟测试：按钮渲染、点击开弹窗 | **新建** |

**约定**：提交直接到 main（项目无 feature 分支策略，见项目记忆）。每个 Task 末尾 `git commit`。

---

## Task 1: 创建 `useFileRevision` hook（TDD）

**Files:**
- Create: `src/web/hooks/useFileRevision.ts`
- Test: `tests/unit/web/use-file-revision.test.ts`

- [ ] **Step 1: 写失败的 hook 测试**

Create `tests/unit/web/use-file-revision.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement } from 'react';
import { useFileRevision } from '../../../src/web/hooks/useFileRevision';

// mock useAgentSelection，避免触碰 localStorage / agents 查询
vi.mock('../../../src/web/hooks/useAgents', () => ({
  useAgentSelection: () => ['agent_x', vi.fn()],
}));

// renderHook 默认不渲染 children；hook 返回的 dialog 是 ReactNode，
// 需通过 renderHook 的 wrapper 渲染出来才能查 RevisionDialog 行为。
// 这里我们只测 hook 的状态与 fetch 调用，dialog 节点的渲染留给接线测试。
import { render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// 捕获 fetch 调用
const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

beforeEach(() => {
  fetchSpy.mockReset();
  // RevisionDialog 的 rename 模式会 fetch state.json 取角色列表；
  // 其他请求（runs/rename）返回空对象即可。
  fetchSpy.mockImplementation(async (url: string) => {
    if (String(url).includes('state.json')) {
      return {
        ok: true,
        json: async () => ({ characters: [{ name: '旧角色' }] }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
});

describe('useFileRevision', () => {
  const baseOpts = {
    projectId: 'proj_1',
    targetFile: 'concept.md',
    stage: 'concept',
  };

  it('初始状态：dialog 为 null', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    expect(result.current.dialog).toBeNull();
  });

  it('openDialog() 后 dialog 非空（使用 options.targetFile）', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openDialog());
    expect(result.current.dialog).not.toBeNull();
  });

  it('closeDialog() 后 dialog 回到 null', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openDialog());
    act(() => result.current.closeDialog());
    expect(result.current.dialog).toBeNull();
  });

  it('openDialog(targetFile?) 覆盖 options.targetFile', async () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openDialog('chapters/第3章.md'));

    // 通过渲染 dialog 并触发 onSubmit 来验证内部 targetFile
    const { queryByText } = render(result.current.dialog as ReturnType<typeof createElement>);
    // RevisionDialog 标题包含 targetFile
    expect(queryByText(/chapters\/第3章\.md/)).not.toBeNull();
  });

  it('onClose 回调在 closeDialog 时触发', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      useFileRevision({ ...baseOpts, onClose }),
    );
    act(() => result.current.openDialog());
    act(() => result.current.closeDialog());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('targetFile 为空字符串时不渲染 dialog', () => {
    const { result } = renderHook(() =>
      useFileRevision({ ...baseOpts, targetFile: '' }),
    );
    act(() => result.current.openDialog());
    // targetFile 仍为空 → dialog 渲染规则要求非空才渲染
    expect(result.current.dialog).toBeNull();
  });

  it('revise 模式：onSubmit 发 POST /api/runs，body 含 mode/targetFile/revisionNote', async () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openDialog());

    const { container } = render(result.current.dialog as ReturnType<typeof createElement>);
    // 找到 textarea 填修订意见，再点「执行修订」按钮
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      // 模拟用户输入修订意见
      textarea.value = '把核心冲突改为复仇';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('执行修订'),
    )!;
    await act(async () => submitBtn.click());

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/runs',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"mode":"revise"'),
      }),
    );
    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      projectId: 'proj_1',
      agentId: 'agent_x',
      stage: 'concept',
      mode: 'revise',
      targetFile: 'concept.md',
      revisionNote: '把核心冲突改为复仇',
      message: '把核心冲突改为复仇',
    });
  });

  it('rename 模式：onSubmit 发 POST /api/projects/:id/rename', async () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openDialog());

    const { container } = render(result.current.dialog as ReturnType<typeof createElement>);
    // 切到「重命名」tab
    const renameTab = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('重命名'),
    )!;
    await act(async () => renameTab.click());

    // select 选旧名，input 填新名
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = '旧角色';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const nameInput = container.querySelector('input[type="text"]')!;
    await act(async () => {
      nameInput.value = '新角色';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('执行修订'),
    )!;
    await act(async () => submitBtn.click());

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/projects/proj_1/rename',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"oldName":"旧角色"'),
      }),
    );
    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody).toMatchObject({
      oldName: '旧角色',
      newName: '新角色',
    });
  });

  it('提交成功后自动关闭弹窗并触发 onClose', async () => {
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      useFileRevision({ ...baseOpts, onClose }),
    );
    act(() => result.current.openDialog());
    expect(result.current.dialog).not.toBeNull();

    const { container } = render(result.current.dialog as ReturnType<typeof createElement>);
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      textarea.value = '改一下';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('执行修订'),
    )!;
    await act(async () => submitBtn.click());

    expect(onClose).toHaveBeenCalled();
    expect(result.current.dialog).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/web/use-file-revision.test.ts`
Expected: FAIL — `Cannot find module '../../../src/web/hooks/useFileRevision'`

- [ ] **Step 3: 实现 hook**

Create `src/web/hooks/useFileRevision.ts`:

```typescript
import { useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import RevisionDialog from '../components/RevisionDialog';
import { useAgentSelection } from './useAgents';

export interface UseFileRevisionOptions {
  /** 项目 ID。 */
  projectId: string;
  /** 相对 .novel/ 的默认目标文件路径，如 'concept.md'。可为 ''（延迟指定场景）。 */
  targetFile: string;
  /** 语义 stage，写入 conversation 记录（revise 模式下不影响 agent 指令）。 */
  stage: string;
  /** 弹窗关闭回调。WritingView 用来清空 reviseChapter；三视图不传。 */
  onClose?: () => void;
}

export interface UseFileRevisionResult {
  /** 打开弹窗。可选参数覆盖 options.targetFile（WritingView 选完章节后传具体路径）。 */
  openDialog: (targetFile?: string) => void;
  /** 关闭弹窗。 */
  closeDialog: () => void;
  /** 已挂载的 <RevisionDialog>；未打开或 targetFile 为空时为 null。 */
  dialog: ReactNode;
}

/**
 * 封装「修订某个 .novel/ 文件」的完整逻辑：弹窗状态 + RevisionDialog 渲染 + onSubmit fetch。
 * 复用于 ConceptView / WorldView / CharacterView（文件级）与 WritingView（章节级，延迟指定 targetFile）。
 *
 * 刷新由 ProjectPage 的 SSE file-changed 监听统一处理，hook 内不重复。
 */
export function useFileRevision(options: UseFileRevisionOptions): UseFileRevisionResult {
  const { projectId, targetFile: defaultTargetFile, stage, onClose } = options;
  const [isOpen, setIsOpen] = useState(false);
  const [activeTargetFile, setActiveTargetFile] = useState(defaultTargetFile);
  const [agentId] = useAgentSelection();

  const openDialog = useCallback((targetFile?: string) => {
    if (targetFile !== undefined) setActiveTargetFile(targetFile);
    setIsOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setIsOpen(false);
    onClose?.();
  }, [onClose]);

  const handleSubmit = useCallback(
    async (mode: 'revise' | 'rename', data: { revisionNote?: string; oldName?: string; newName?: string; scope?: string[] | undefined }) => {
      if (mode === 'revise') {
        await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId,
            agentId,
            stage,
            message: data.revisionNote,
            mode: 'revise',
            targetFile: activeTargetFile,
            revisionNote: data.revisionNote,
          }),
        });
      } else {
        await fetch(`/api/projects/${projectId}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            oldName: data.oldName,
            newName: data.newName,
            scope: data.scope,
          }),
        });
      }
      closeDialog();
    },
    [projectId, agentId, stage, activeTargetFile, closeDialog],
  );

  const dialog = useMemo<ReactNode>(() => {
    // 渲染规则：仅在打开且 targetFile 非空时渲染（防止空 targetFile 触发无效 run）
    if (!isOpen || !activeTargetFile) return null;
    return createElement(RevisionDialog, {
      projectId,
      targetFile: activeTargetFile,
      onClose: closeDialog,
      onSubmit: handleSubmit,
    });
  }, [isOpen, activeTargetFile, projectId, closeDialog, handleSubmit]);

  return { openDialog, closeDialog, dialog };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/web/use-file-revision.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/web/hooks/useFileRevision.ts tests/unit/web/use-file-revision.test.ts
git commit -m "feat: 新增 useFileRevision hook 封装文件修订逻辑"
```

---

## Task 2: 提取 `reviseBtn` 样式到 viewShared.tsx

**Files:**
- Modify: `src/web/components/views/viewShared.tsx`（新增导出）
- Modify: `src/web/components/views/WritingView.tsx`（删除本地定义，改用导入）

- [ ] **Step 1: 在 viewShared.tsx 新增 reviseBtn 导出**

在 `viewShared.tsx` 末尾（`useViewMode` 函数附近）追加：

```typescript
/** 修订按钮样式。ConceptView/WorldView/CharacterView/WritingView 共用。 */
export const reviseBtn = css`
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--haze-color-text);
  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`;
```

- [ ] **Step 2: WritingView 删除本地 reviseBtn 定义，改用导入**

在 `WritingView.tsx`：
- 删除文件内 `const reviseBtn = css\`...\`` 整段（约 13 行）
- 在 import 区把 `viewShared` 的导入补上 `reviseBtn`：

```typescript
// WritingView 现有从 viewShared 的导入（如有）；若无则新增此行
import { reviseBtn } from './viewShared';
```

> 注：当前 WritingView 未从 viewShared 导入任何东西。新增一行 import 即可。

- [ ] **Step 3: typecheck + 测试**

Run: `npm run typecheck && npx vitest run tests/unit/web/`
Expected: 通过，无回归

- [ ] **Step 4: 提交**

```bash
git add src/web/components/views/viewShared.tsx src/web/components/views/WritingView.tsx
git commit -m "refactor: 提取 reviseBtn 样式到 viewShared 共享"
```

---

## Task 3: 接线 ConceptView

**Files:**
- Modify: `src/web/components/views/ConceptView.tsx`

- [ ] **Step 1: 接入 hook + 修订按钮**

在 `ConceptView.tsx`：

1. 新增 import（文件顶部，与现有 import 同区）：
```typescript
import { useFileRevision } from '@/web/hooks/useFileRevision';
import { reviseBtn } from './viewShared';
```

2. 在组件函数体 `useViewMode()` 之后加 hook：
```typescript
const revision = useFileRevision({ projectId, targetFile: 'concept.md', stage: 'concept' });
```

3. 修改 `return` 的 JSX（在 `viewHeaderRow` 内 `<ViewToolbar>` 之前加按钮；在最外层 `<div>` 闭合前加 `{revision.dialog}`）：
```tsx
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

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/web/components/views/ConceptView.tsx
git commit -m "feat: ConceptView 接入修订入口"
```

---

## Task 4: 接线 WorldView

**Files:**
- Modify: `src/web/components/views/WorldView.tsx`

- [ ] **Step 1: 接入 hook + 修订按钮**

在 `WorldView.tsx`（结构同 ConceptView）：

1. 新增 import：
```typescript
import { useFileRevision } from '@/web/hooks/useFileRevision';
import { reviseBtn } from './viewShared';
```

2. 组件体内 `useViewMode()` 之后加：
```typescript
const revision = useFileRevision({ projectId, targetFile: 'world-building.md', stage: 'world' });
```

3. 修改 `return` 的 JSX（当前结构是 `viewHeaderRow` + `worldGrid` 两块；在 `viewHeaderRow` 内加按钮，`worldGrid` 之后加 `{revision.dialog}`）：
```tsx
return (
  <div>
    <div className={viewHeaderRow}>
      <h3 className={pageHeading}>世界观</h3>
      <button className={reviseBtn} onClick={() => revision.openDialog()}>✎ 修订</button>
      <ViewToolbar mode={viewMode} onChange={setViewMode} />
    </div>
    <div className={worldGrid}>{sections.map(renderCategory)}</div>
    {revision.dialog}
  </div>
);
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/web/components/views/WorldView.tsx
git commit -m "feat: WorldView 接入修订入口"
```

---

## Task 5: 接线 CharacterView

**Files:**
- Modify: `src/web/components/views/CharacterView.tsx`

- [ ] **Step 1: 接入 hook + 修订按钮**

在 `CharacterView.tsx`：

1. 新增 import：
```typescript
import { useFileRevision } from '@/web/hooks/useFileRevision';
import { reviseBtn } from './viewShared';
```

2. 组件体内 `useViewMode()` 之后加 hook：
```typescript
const revision = useFileRevision({ projectId, targetFile: 'characters/profiles.md', stage: 'characters' });
```

3. 修改 `viewHeaderRow`（CharacterView 已有起名工具按钮 + ViewToolbar）。修订按钮放在 `<h3>` 之后、起名工具按钮之前（紧邻标题）：
```tsx
<div className={viewHeaderRow}>
  <h3 className={pageHeading}>角色</h3>
  <button className={reviseBtn} onClick={() => revision.openDialog()}>✎ 修订</button>
  <button className={namingToggleBtn} onClick={() => setShowNaming((v) => !v)}>
    {showNaming ? '▾ 收起起名工具' : '▸ 起名工具'}
  </button>
  <ViewToolbar mode={viewMode} onChange={setViewMode} />
</div>
```

4. 在组件 return 的 `charGrid` `<div>` 闭合之后、最外层 `<div>` 闭合之前，加 `{revision.dialog}`：
```tsx
      <div className={charGrid}>
        {sections.map((s, i) => { /* ...现有内容不变... */ })}
      </div>
      {revision.dialog}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/web/components/views/CharacterView.tsx
git commit -m "feat: CharacterView 接入修订入口"
```

---

## Task 6: 收敛 WritingView 用 hook

**Files:**
- Modify: `src/web/components/views/WritingView.tsx`

- [ ] **Step 1: 替换内联实现为 hook 调用**

在 `WritingView.tsx`：

1. 调整 import：
   - 删除 `import RevisionDialog from '../RevisionDialog';`
   - 删除 `import { useAgentSelection } from '@/web/hooks/useAgents';`
   - 新增 `import { useFileRevision } from '@/web/hooks/useFileRevision';`（`reviseBtn` 已在 Task 2 从 viewShared 导入）

2. 组件体内，把现有的：
```typescript
const [reviseChapter, setReviseChapter] = useState<number | null>(null);
const [agentId] = useAgentSelection();
```
替换为：
```typescript
const [reviseChapter, setReviseChapter] = useState<number | null>(null);
const revision = useFileRevision({
  projectId,
  targetFile: '',          // 延迟指定，openDialog 时传具体路径
  stage: 'writing',
  onClose: () => setReviseChapter(null),
});

// 选完章节后打开修订弹窗
useEffect(() => {
  if (reviseChapter !== null) {
    revision.openDialog(`chapters/第${reviseChapter}章.md`);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [reviseChapter]);
```

> 注：需在 import 区补 `useEffect`：`import { useState, useEffect } from 'react';`

3. 章节卡片的按钮不变（仍 `setReviseChapter(c.number)`）。

4. 删除文件末尾的内联 `{reviseChapter !== null && (<RevisionDialog .../>)}` 整块，替换为：
```tsx
{revision.dialog}
```

- [ ] **Step 2: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无错误（特别注意 `agentId` 不再未使用——已移入 hook）

- [ ] **Step 3: 回归测试**

Run: `npx vitest run tests/unit/web/`
Expected: 全部通过（无回归）

- [ ] **Step 4: 提交**

```bash
git add src/web/components/views/WritingView.tsx
git commit -m "refactor: WritingView 收敛内联修订实现为 useFileRevision 调用"
```

---

## Task 7: 视图接线冒烟测试

**Files:**
- Test: `tests/unit/web/revision-dialog-wiring.test.tsx`

- [ ] **Step 1: 写接线冒烟测试**

Create `tests/unit/web/revision-dialog-wiring.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// mock useAgentSelection
vi.mock('@/web/hooks/useAgents', () => ({
  useAgentSelection: () => ['agent_x', vi.fn()],
}));

// mock useNovelFile：返回带 sections 的 markdown，让视图走到 header 分支
vi.mock('@/web/components/views/viewShared', async () => {
  const actual = await vi.importActual<typeof import('@/web/components/views/viewShared')>(
    '@/web/components/views/viewShared',
  );
  return {
    ...actual,
    useNovelFile: () => ({
      data: '# 故事概念\n\n## 一句话梗概\n\n一个少年的复仇故事。\n',
      isLoading: false,
    }),
  };
});

// mock useQuery for state.json (CharacterView)
const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async (url: string) => {
    // CharacterView 拉 state.json
    if (String(url).includes('state.json')) {
      return { ok: true, json: async () => ({ content: '{"characters":[]}' }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
});

import ConceptView from '@/web/components/views/ConceptView';

describe('视图修订接线冒烟', () => {
  it('ConceptView 渲染「✎ 修订」按钮', () => {
    render(<ConceptView projectId="proj_1" />);
    expect(screen.getByText('✎ 修订')).toBeInTheDocument();
  });

  it('点击「✎ 修订」打开 RevisionDialog', async () => {
    render(<ConceptView projectId="proj_1" />);
    fireEvent.click(screen.getByText('✎ 修订'));
    // RevisionDialog 弹窗标题含「修订 · concept.md」
    await waitFor(() => {
      expect(screen.getByText(/修订 · concept\.md/)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run tests/unit/web/revision-dialog-wiring.test.tsx`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add tests/unit/web/revision-dialog-wiring.test.tsx
git commit -m "test: 视图修订接线冒烟测试"
```

---

## Task 8: 全量验证

**Files:** 无（仅运行验证命令）

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 2: 全量单元/集成测试**

Run: `npm test`
Expected: 全部通过，无回归

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 构建成功（client + server）

- [ ] **Step 4: 手动 E2E（可选但推荐）**

按 spec §7 验证清单执行：
1. 启动 dev server，创建/打开已有项目
2. 生成概念 → 切到概念视图 → 点「✎ 修订」→ 填修订意见 → 确认 agent 用 Edit 改了 `.novel/concept.md` → 视图自动刷新
3. 同样验证世界观、角色视图
4. 验证章节（WritingView）修订未破坏
