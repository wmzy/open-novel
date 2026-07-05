# 修订改造：提交到对话框 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 视图/卡片的 ✎ 修订从 fire-and-forget POST 改为进入右侧 ChatPanel「修订模式」，用户在对话框写意见、手动发送，复用已有流式渲染 + diff 面板；rename 拆出独立轻量弹窗。

**Architecture:** 事件总线 `open-novel:revise-to-chat`（window CustomEvent）连接 useFileRevision 与 ChatPanel，复用项目已有 `open-novel:agent-change` 模式。useRun.sendMessage 扩展可选 `mode/targetFile/revisionNote` 透传给后端（后端零改动）。RevisionDialog 拆出 rename 部分为 RenameDialog，revise 部分删除。

**Tech Stack:** React 19、@linaria/core、@tanstack/react-query、vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-07-05-revision-to-chat-design.md`

---

## File Structure

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/web/hooks/useRun.ts` | sendMessage 签名扩展，透传 mode/targetFile/revisionNote | 修改 |
| `src/web/hooks/useFileRevision.ts` | openRevise(openRename dispatch + rename fetch) | 重构 |
| `src/web/components/ChatPanel.tsx` | 监听 revise 事件 + 修订模式 UI | 修改 |
| `src/web/components/RenameDialog.tsx` | rename 轻量弹窗（从 RevisionDialog 拆出） | 新建 |
| `src/web/components/RevisionDialog.tsx` | 删除 | 删除 |
| `src/web/components/views/viewShared.tsx` | 新增 renameBtn 样式 | 修改 |
| `src/web/components/views/ConceptView.tsx` | 按钮拆分接线 | 修改 |
| `src/web/components/views/WorldView.tsx` | 按钮拆分接线 | 修改 |
| `src/web/components/views/CharacterView.tsx` | 按钮拆分接线 | 修改 |
| `src/web/components/views/WritingView.tsx` | 章节级 revise 接线 | 修改 |
| `tests/unit/web/use-file-revision.test.ts` | 改断言 dispatch 事件 | 修改 |
| `tests/unit/web/revision-dialog-wiring.test.tsx` | 改断言（无弹窗，dispatch 事件） | 修改 |
| `tests/unit/web/rename-dialog.test.tsx` | RenameDialog 测试 | 新建 |
| `tests/unit/web/chat-panel-revise-mode.test.tsx` | ChatPanel 修订模式测试 | 新建 |

---

## Task 1: useRun.sendMessage 扩展 revise 字段

**Files:**
- Modify: `src/web/hooks/useRun.ts`（sendMessage 签名 + fetch body）
- Test: `tests/unit/web/use-file-revision.test.ts`（暂不动，本任务只扩展签名）

- [ ] **Step 1: 扩展 sendMessage 签名**

`src/web/hooks/useRun.ts` 约 54 行，`sendMessage` 的 `params` 类型增加三个可选字段：

```ts
const sendMessage = useCallback(async (params: {
  projectId: string;
  agentId: string;
  skillId: string;
  stage: string;
  message: string;
  model?: string;
  mode?: 'generate' | 'revise';
  targetFile?: string;
  revisionNote?: string;
}) => {
```

- [ ] **Step 2: 透传新字段到 fetch body**

同函数内 `fetch('/api/runs', ...)` 的 body（约 62 行），从 `{ ...params, conversationId: ... }` 改为显式展开，确保新字段传入：

```ts
body: JSON.stringify({
  projectId: params.projectId,
  agentId: params.agentId,
  skillId: params.skillId,
  stage: params.stage,
  message: params.message,
  model: params.model,
  mode: params.mode,
  targetFile: params.targetFile,
  revisionNote: params.revisionNote,
  conversationId: conversationIdRef.current,
}),
```

- [ ] **Step 3: typecheck 验证签名扩展不破坏现有调用**

Run: `cd ~/projects/open-novel && npm run typecheck 2>&1 | grep -v mermaid | tail -5`
Expected: 无新错误（ChatPanel 现有调用不传新字段，可选字段不报错）

- [ ] **Step 4: Commit**

```bash
cd ~/projects/open-novel && git add src/web/hooks/useRun.ts && git commit -m "feat(revise): useRun.sendMessage 扩展 mode/targetFile/revisionNote 透传"
```

---

## Task 2: useFileRevision 重构——openRevise/openRename

**Files:**
- Modify: `src/web/hooks/useFileRevision.ts`（完整重构返回值）
- Modify: `tests/unit/web/use-file-revision.test.ts`（改断言）

- [ ] **Step 1: 重写 useFileRevision.ts**

整个文件重写。openRevise dispatch 事件，openRename 开 RenameDialog（Task 3 创建，本任务先 import 占位 TS 会报错——先写 rename fetch 逻辑，RenameDialog 在 Task 3 接入）。为避免 Task 2 完成前 RenameDialog 不存在导致编译失败，本任务的 hook 只保留 rename 的状态+fetch 逻辑，renameDialog 渲染延到 Task 3。

完整新内容：

```ts
import { useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createElement } from 'react';

export const REVISE_TO_CHAT_EVENT = 'open-novel:revise-to-chat';

export interface ReviseToChatDetail {
  targetFile: string;
  sectionTitle?: string;
}

export interface UseFileRevisionOptions {
  /** 项目 ID。 */
  projectId: string;
  /** 相对 .novel/ 的默认目标文件路径，如 'concept.md'。可为 ''（延迟指定场景）。 */
  targetFile: string;
  /** 语义 stage，写入 conversation 记录（不影响 agent 指令）。 */
  stage: string;
  /** rename 弹窗关闭回调。 */
  onClose?: () => void;
}

export interface UseFileRevisionResult {
  /** 进入修订模式：dispatch open-novel:revise-to-chat 事件，ChatPanel 监听后聚焦输入框。
   *  @param targetFile 可选，覆盖 options.targetFile
   *  @param sectionTitle 可选，section 级定向锚点（卡片级 ✎ 传入 section 标题） */
  openRevise: (targetFile?: string, sectionTitle?: string) => void;
  /** 打开 rename 弹窗。 */
  openRename: (targetFile?: string) => void;
  /** 关闭 rename 弹窗。 */
  closeRename: () => void;
  /** 已挂载的 rename 弹窗；未打开时为 null。 */
  renameDialog: ReactNode;
}

/**
 * 封装视图/卡片的修订与重命名入口。
 *
 * - revise：不再独立 POST，而是 dispatch open-novel:revise-to-chat 事件，
 *   ChatPanel 监听后进入「修订模式」，用户在对话框写意见手动发送，
 *   复用流式渲染 + diff 面板。agent 由 ChatPanel 提供，本 hook 不再读 useAgentSelection。
 * - rename：保留独立轻量弹窗（RenameDialog），走 /api/projects/:id/rename 机械改名。
 *
 * 刷新由 ProjectPage 的 SSE file-changed 监听统一处理。
 */
export function useFileRevision(options: UseFileRevisionOptions): UseFileRevisionResult {
  const { projectId, targetFile: defaultTargetFile, onClose } = options;
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTargetFile, setRenameTargetFile] = useState(defaultTargetFile);

  const openRevise = useCallback(
    (targetFile?: string, sectionTitle?: string) => {
      const targetFile2 = targetFile ?? defaultTargetFile;
      if (!targetFile2) return;
      const detail: ReviseToChatDetail = { targetFile: targetFile2, sectionTitle };
      window.dispatchEvent(new CustomEvent(REVISE_TO_CHAT_EVENT, { detail }));
    },
    [defaultTargetFile],
  );

  const openRename = useCallback((targetFile?: string) => {
    if (targetFile !== undefined) setRenameTargetFile(targetFile);
    setRenameOpen(true);
  }, []);

  const closeRename = useCallback(() => {
    setRenameOpen(false);
    onClose?.();
  }, [onClose]);

  const renameDialog = useMemo<ReactNode>(() => {
    if (!renameOpen || !renameTargetFile) return null;
    // RenameDialog 在 Task 3 创建；此处先返回 null 占位，Task 3 接入 createElement(RenameDialog, ...)
    return null;
  }, [renameOpen, renameTargetFile, projectId, closeRename]);

  return { openRevise, openRename, closeRename, renameDialog };
}
```

注意：`useMemo` 的依赖数组故意包含 `projectId, closeRename`（为 Task 3 接入预留），TS 可能警告未使用——暂用 `void projectId; void closeRename;` 不优雅。**改法**：Task 3 接入后自然消除。本步先让 hook 编译通过。

实际为避免未使用变量错误，本步 renameDialog 写成：

```ts
const renameDialog = useMemo<ReactNode>(() => {
  void projectId;
  void closeRename;
  if (!renameOpen || !renameTargetFile) return null;
  return null;
}, [renameOpen, renameTargetFile, projectId, closeRename]);
```

- [ ] **Step 2: 重写 use-file-revision.test.ts**

旧测试基于 openDialog/closeDialog/dialog/revise-fetch，全部作废。新测试覆盖：openRevise dispatch 事件、openRename 状态、rename fetch（renameDialog 占位时跳过 fetch 测试，留到 Task 3）。

完整新内容：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileRevision, REVISE_TO_CHAT_EVENT } from '../../../src/web/hooks/useFileRevision';

describe('useFileRevision', () => {
  const baseOpts = {
    projectId: 'proj_1',
    targetFile: 'concept.md',
    stage: 'concept',
  };

  let dispatchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dispatchSpy = vi.spyOn(window, 'dispatchEvent');
  });
  afterEach(() => {
    dispatchSpy.mockRestore();
  });

  it('初始状态：renameDialog 为 null', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    expect(result.current.renameDialog).toBeNull();
  });

  it('openRevise() dispatch open-novel:revise-to-chat 事件，含 targetFile', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openRevise());
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(REVISE_TO_CHAT_EVENT);
    expect(event.detail).toEqual({ targetFile: 'concept.md', sectionTitle: undefined });
  });

  it('openRevise(undefined, sectionTitle) payload 含 sectionTitle', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openRevise(undefined, '核心冲突'));
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ targetFile: 'concept.md', sectionTitle: '核心冲突' });
  });

  it('openRevise(targetFile?) 覆盖默认 targetFile', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openRevise('chapters/第3章.md'));
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent;
    expect(event.detail.targetFile).toBe('chapters/第3章.md');
  });

  it('openRevise() 在 targetFile 为空时静默不 dispatch（防 WritingView 空路径）', () => {
    const { result } = renderHook(() => useFileRevision({ ...baseOpts, targetFile: '' }));
    act(() => result.current.openRevise());
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('openRename() / closeRename() 切换 renameDialog 状态（占位 null）', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    // 占位实现下 renameDialog 始终 null，但 openRename/closeRename 不报错
    act(() => result.current.openRename());
    act(() => result.current.closeRename());
    expect(result.current.renameDialog).toBeNull();
  });

  it('closeRename 触发 onClose 回调', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useFileRevision({ ...baseOpts, onClose }));
    act(() => result.current.openRename());
    act(() => result.current.closeRename());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: 运行测试验证**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/use-file-revision.test.ts 2>&1 | tail -6`
Expected: 7 passed

- [ ] **Step 4: Commit**

```bash
cd ~/projects/open-novel && git add src/web/hooks/useFileRevision.ts tests/unit/web/use-file-revision.test.ts && git commit -m "feat(revise): useFileRevision 改为 dispatch revise-to-chat 事件 + openRename 状态"
```

---

## Task 3: RenameDialog 组件 + useFileRevision 接入

**Files:**
- Create: `src/web/components/RenameDialog.tsx`
- Modify: `src/web/hooks/useFileRevision.ts`（renameDialog 渲染接入）
- Create: `tests/unit/web/rename-dialog.test.tsx`

- [ ] **Step 1: 创建 RenameDialog.tsx**

从 RevisionDialog.tsx 拆出 rename 部分（oldName 输入+下拉、newName 输入、checkName 预检、scope 选择）。Props 简化：去掉 mode/onSubmit 包装，直接调 rename API。

```tsx
import { useState } from 'react';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';

interface Props {
  projectId: string;
  targetFile: string;
  onClose: () => void;
}

const overlay = css`
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
`;
const dialog = css`
  background: var(--haze-color-bg, #fff); border-radius: 8px; padding: 1.5rem;
  width: 480px; max-width: 90vw; box-shadow: 0 8px 32px rgba(0,0,0,0.15);
`;
const btn = css`
  padding: 0.4rem 1rem; border: 1px solid var(--haze-color-border); border-radius: 6px;
  background: transparent; cursor: pointer; font-size: 0.85rem;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;
const primaryBtn = css`
  ${btn}; background: var(--haze-color-primary, #3b82f6); color: white; border-color: var(--haze-color-primary, #3b82f6);
`;
const input = css`
  width: 100%; padding: 0.4rem 0.5rem; border: 1px solid var(--haze-color-border);
  border-radius: 6px; font-size: 0.85rem; box-sizing: border-box;
`;
const label = css`
  display: block; font-size: 0.8rem; font-weight: 600; margin-bottom: 0.3rem; color: var(--haze-color-text);
`;
const warning = css`color: #dc2626; font-size: 0.78rem; margin-top: 0.3rem;`;
const actions = css`display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem;`;
const titleCls = css`font-size: 1rem; font-weight: 700; margin-bottom: 0.75rem; color: var(--haze-color-text);`;
const field = css`margin-bottom: 0.75rem;`;

interface StateFile { characters?: Array<{ name?: string }>; }

/** 重命名弹窗：确定性改名引擎，走 /api/projects/:id/rename，不走 agent。 */
export default function RenameDialog({ projectId, targetFile, onClose }: Props) {
  const [oldName, setOldName] = useState('');
  const [newName, setNewName] = useState('');
  const [nameWarning, setNameWarning] = useState('');
  const [scopeAll, setScopeAll] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const { data: characters } = useQuery<string[]>({
    queryKey: ['state-characters', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('state.json')}`);
      if (!res.ok) return [];
      const data = (await res.json()) as StateFile;
      return (data.characters || []).map((c) => c.name).filter((n): n is string => !!n);
    },
  });

  async function checkNewName(name: string) {
    if (!name || name.length < 2) { setNameWarning(''); return; }
    try {
      const res = await fetch(`/api/projects/${projectId}/naming/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, existingNames: characters || [] }),
      });
      const data = await res.json();
      setNameWarning(data.warnings?.length ? data.warnings.join('；') : '');
    } catch { setNameWarning(''); }
  }

  async function handleSubmit() {
    if (!oldName || !newName) return;
    setSubmitting(true);
    try {
      await fetch(`/api/projects/${projectId}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldName, newName, scope: scopeAll ? undefined : [targetFile] }),
      });
      onClose();
    } finally { setSubmitting(false); }
  }

  const canSubmit = !!(oldName && newName) && !submitting;

  return (
    <div className={overlay} onClick={onClose}>
      <div className={dialog} onClick={(e) => e.stopPropagation()}>
        <div className={titleCls}>重命名 · {targetFile}</div>
        <div className={field}>
          <label className={label}>原名字</label>
          <input className={input} list="char-list" value={oldName} onChange={(e) => setOldName(e.target.value)} placeholder="选择或输入要改的实体名" autoFocus />
          <datalist id="char-list">
            {(characters || []).map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div className={field}>
          <label className={label}>新名字（至少 2 个字）</label>
          <input className={input} value={newName} onChange={(e) => setNewName(e.target.value)} onBlur={(e) => checkNewName(e.target.value)} placeholder="新名字" />
          {nameWarning && <div className={warning}>{nameWarning}</div>}
        </div>
        <div className={field}>
          <label className={label}>
            <input type="checkbox" checked={scopeAll} onChange={(e) => setScopeAll(e.target.checked)} /> 全项目替换（不勾选则仅改此文件）
          </label>
        </div>
        <div className={actions}>
          <button className={btn} onClick={onClose} disabled={submitting}>取消</button>
          <button className={primaryBtn} onClick={handleSubmit} disabled={!canSubmit}>确认重命名</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: useFileRevision renameDialog 接入 RenameDialog**

修改 `src/web/hooks/useFileRevision.ts`：
- 顶部加 `import RenameDialog from '../components/RenameDialog';`
- renameDialog useMemo 改为：

```ts
const renameDialog = useMemo<ReactNode>(() => {
  if (!renameOpen || !renameTargetFile) return null;
  return createElement(RenameDialog, {
    projectId,
    targetFile: renameTargetFile,
    onClose: closeRename,
  });
}, [renameOpen, renameTargetFile, projectId, closeRename]);
```

- 删除占位的 `void projectId; void closeRename;`

- [ ] **Step 3: 写 rename-dialog.test.tsx**

```tsx
/**
 * RenameDialog 测试：从 RevisionDialog 拆出后的独立组件。
 * 覆盖：渲染、oldName/newName 输入、checkName 预检、提交调 /rename API。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import RenameDialog from '../../../src/web/components/RenameDialog';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(global, 'fetch');
  fetchSpy.mockImplementation(async (url: string, opts?: RequestInit) => {
    const u = String(url);
    if (u.includes('state.json')) {
      return { ok: true, json: async () => ({ content: '{"characters":[{"name":"剑平"},{"name":"剑臣"}]}' }) } as Response;
    }
    if (u.includes('/naming/check')) {
      return { ok: true, json: async () => ({ warnings: [] }) } as Response;
    }
    if (u.includes('/rename')) {
      return { ok: true, json: async () => ({}) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
});
afterEach(() => { fetchSpy.mockRestore(); cleanup(); });

describe('RenameDialog', () => {
  it('渲染标题含 targetFile', () => {
    render(createElement(RenameDialog, { projectId: 'p1', targetFile: 'concept.md', onClose: vi.fn() }));
    expect(screen.getByText(/重命名 · concept\.md/)).toBeInTheDocument();
  });

  it('点击 overlay 触发 onClose', () => {
    const onClose = vi.fn();
    render(createElement(RenameDialog, { projectId: 'p1', targetFile: 'concept.md', onClose }));
    fireEvent.click(screen.getByText(/重命名 · concept\.md/).parentElement!.parentElement!);
    // overlay 是最外层，点它应触发；这里点对话框内部不应触发，验证逻辑：直接点 overlay
  });

  it('填 oldName+newName 后点确认调 /rename', async () => {
    const onClose = vi.fn();
    const { container } = render(createElement(RenameDialog, { projectId: 'p1', targetFile: 'concept.md', onClose }));
    const inputs = container.querySelectorAll('input[type="text"], input:not([type])');
    fireEvent.change(inputs[0], { target: { value: '剑平' } });
    fireEvent.change(inputs[1], { target: { value: '剑萍' } });
    fireEvent.blur(inputs[1]);
    fireEvent.click(screen.getByText('确认重命名'));
    await waitFor(() => {
      const renameCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/rename'));
      expect(renameCall).toBeDefined();
      const body = JSON.parse(renameCall![1].body as string);
      expect(body.oldName).toBe('剑平');
      expect(body.newName).toBe('剑萍');
    });
  });
});
```

- [ ] **Step 4: 运行测试**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/rename-dialog.test.tsx 2>&1 | tail -6`
Expected: 3 passed

- [ ] **Step 5: 删除 RevisionDialog.tsx**

确认无其他引用后删除：

```bash
cd ~/projects/open-novel && grep -rn "RevisionDialog" src/ && echo "仍有引用，需处理" || rm src/web/components/RevisionDialog.tsx
```

若有引用（Task 4-6 会清除 views 的引用），先暂缓删除，留到 Task 6 后。

- [ ] **Step 6: Commit**

```bash
cd ~/projects/open-novel && git add src/web/components/RenameDialog.tsx src/web/hooks/useFileRevision.ts tests/unit/web/rename-dialog.test.tsx && git commit -m "feat(revise): RenameDialog 组件从 RevisionDialog 拆出 + useFileRevision 接入"
```

---

## Task 4: viewShared 加 renameBtn 样式

**Files:**
- Modify: `src/web/components/views/viewShared.tsx`

- [ ] **Step 1: 新增 renameBtn 样式**

在 `reviseBtn` 样式附近（约 74 行）新增 `renameBtn`，复用 reviseBtn 视觉但稍区分（如不同 emoji 已在按钮文字体现，样式可共用）。实际新增导出：

```ts
/** 重命名按钮样式。与 reviseBtn 同视觉，按钮文字用 ⇄ 区分。 */
export const renameBtn = css`
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  &:hover { background: var(--haze-color-bg-secondary); color: var(--haze-color-text); }
`;
```

- [ ] **Step 2: Commit**

```bash
cd ~/projects/open-novel && git add src/web/components/views/viewShared.tsx && git commit -m "feat(revise): viewShared 新增 renameBtn 样式"
```

---

## Task 5: ConceptView 按钮拆分接线

**Files:**
- Modify: `src/web/components/views/ConceptView.tsx`
- Modify: `tests/unit/web/revision-dialog-wiring.test.tsx`（ConceptView 部分）

- [ ] **Step 1: ConceptView 按钮拆分**

ConceptView 约 137-142 行：
- import 改：`reviseBtn` → 加 `renameBtn`，删除 `cardReviseBtn`（卡片级改用文字按钮或保留图标，下面详述）
- 视图顶部按钮区（约 138 行）从单个 `<button className={reviseBtn} onClick={() => revision.openDialog()}>✎ 修订</button>` 改为：

```tsx
<button className={reviseBtn} onClick={() => revision.openRevise()}>✎ 修订</button>
<button className={renameBtn} onClick={() => revision.openRename()}>⇄ 重命名</button>
{revision.renameDialog}
```

- 卡片级按钮（约 109 行）从 `<button className={cardReviseBtn} onClick={() => revision.openDialog(undefined, s.title)}>` 拆为两个：

```tsx
<button className={cardReviseBtn} onClick={() => revision.openRevise(undefined, s.title)} title="修订这一节">✎</button>
<button className={cardRenameBtn} onClick={() => revision.openRename()} title="重命名">⇄</button>
```

`cardRenameBtn` 样式可复用 cardReviseBtn（视觉一致），或 viewShared 新增。本任务直接复用 `cardReviseBtn` 类名（import 已有），避免新增样式。

- `{revision.dialog}`（约 142 行）→ `{revision.renameDialog}`

- [ ] **Step 2: 更新 revision-dialog-wiring.test.tsx ConceptView 部分**

旧断言「点击 ✎ 修订打开 RevisionDialog 标题含 concept.md」作废。新断言：点击 ✎ 修订 dispatch revise-to-chat 事件。

找到 ConceptView 相关 it 块（约 74-81 行、126 行卡片级），改为：

```tsx
it('点击 ConceptView「✎ 修订」dispatch revise-to-chat 事件', async () => {
  const handler = vi.fn();
  window.addEventListener('open-novel:revise-to-chat', handler);
  wrap(createElement(ConceptView, { projectId: 'proj_1' }));
  fireEvent.click(screen.getByText('✎ 修订'));
  expect(handler).toHaveBeenCalledTimes(1);
  const detail = handler.mock.calls[0][0].detail;
  expect(detail.targetFile).toBe('concept.md');
  window.removeEventListener('open-novel:revise-to-chat', handler);
});

it('点击 ConceptView「⇄ 重命名」打开 RenameDialog', async () => {
  wrap(createElement(ConceptView, { projectId: 'proj_1' }));
  fireEvent.click(screen.getByText('⇄ 重命名'));
  await waitFor(() => {
    expect(screen.getByText(/重命名 · concept\.md/)).toBeInTheDocument();
  });
});

it('点击 ConceptView 卡片 ✎ dispatch revise-to-chat 含 sectionTitle', async () => {
  const handler = vi.fn();
  window.addEventListener('open-novel:revise-to-chat', handler);
  wrap(createElement(ConceptView, { projectId: 'proj_1' }));
  const cardBtn = screen.getAllByTitle('修订这一节')[0];
  fireEvent.click(cardBtn);
  expect(handler).toHaveBeenCalledTimes(1);
  const detail = handler.mock.calls[0][0].detail;
  expect(detail.sectionTitle).toBeTruthy();
  window.removeEventListener('open-novel:revise-to-chat', handler);
});
```

- [ ] **Step 3: 运行 ConceptView 相关测试**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/revision-dialog-wiring.test.tsx 2>&1 | tail -10`
Expected: ConceptView 3 个新测试 pass（WorldView/CharacterView 旧测试此时仍失败，Task 6 修）

- [ ] **Step 4: Commit**

```bash
cd ~/projects/open-novel && git add src/web/components/views/ConceptView.tsx tests/unit/web/revision-dialog-wiring.test.tsx && git commit -m "feat(revise): ConceptView 按钮拆分 revise→对话框 / rename→弹窗"
```

---

## Task 6: WorldView + CharacterView + WritingView 按钮接线

**Files:**
- Modify: `src/web/components/views/WorldView.tsx`
- Modify: `src/web/components/views/CharacterView.tsx`
- Modify: `src/web/components/views/WritingView.tsx`
- Modify: `tests/unit/web/revision-dialog-wiring.test.tsx`（World/Character 部分）

- [ ] **Step 1: WorldView 按钮拆分**

同 Task 5 模式：
- 视图顶部（约 89 行）：`✎ 修订` → `revision.openRevise()` + `⇄ 重命名` → `revision.openRename()` + `{revision.renameDialog}`
- 卡片级（约 74 行）：`✎` → `revision.openRevise(undefined, s.title)` + `⇄` → `revision.openRename()`

- [ ] **Step 2: CharacterView 按钮拆分**

- 视图顶部（约 137 行）：同 WorldView
- 卡片级（约 164 行）：`✎` → `revision.openRevise(undefined, s.title)` + `⇄` → `revision.openRename()`
- import 加 `renameBtn`、`cardReviseBtn`（已有）

- [ ] **Step 3: WritingView 章节级 revise**

WritingView 约 152-159 行，章节级 ✎ 修订按钮：
- `onClick` 从 `revision.openDialog(\`chapters/第${c.number}章.md\`)` 改为 `revision.openRevise(\`chapters/第${c.number}章.md\`)`
- 删除 rename 按钮（章节文件名不通过此入口改）
- `{revision.dialog}` → `{revision.renameDialog}`（WritingView 不开 rename，但保留渲染入口一致；实际为 null）

- [ ] **Step 4: 更新 revision-dialog-wiring.test.tsx World/Character 部分**

World/Character 视图级 + 卡片级测试同 Task 5 Step 2 模式改写（dispatch 事件断言 + rename 弹窗断言）。

- [ ] **Step 5: 删除 RevisionDialog.tsx（若 Task 3 未删）**

```bash
cd ~/projects/open-novel && grep -rn "RevisionDialog" src/ tests/ || rm src/web/components/RevisionDialog.tsx
```

- [ ] **Step 6: 运行全部相关测试**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/revision-dialog-wiring.test.tsx tests/unit/web/use-file-revision.test.ts tests/unit/web/rename-dialog.test.tsx 2>&1 | tail -8`
Expected: 全 pass

- [ ] **Step 7: Commit**

```bash
cd ~/projects/open-novel && git add -A && git commit -m "feat(revise): WorldView/CharacterView/WritingView 按钮接线 + 删除 RevisionDialog"
```

---

## Task 7: ChatPanel 修订模式监听 + UI

**Files:**
- Modify: `src/web/components/ChatPanel.tsx`
- Create: `tests/unit/web/chat-panel-revise-mode.test.tsx`

- [ ] **Step 1: ChatPanel 加修订模式状态与监听**

`src/web/components/ChatPanel.tsx`：
- import `REVISE_TO_CHAT_EVENT` from `@/web/hooks/useFileRevision`
- 顶部组件内（约 useState 区）加：

```tsx
const [pendingRevise, setPendingRevise] = useState<{
  targetFile: string;
  sectionTitle?: string;
} | null>(null);
```

- 加 useEffect 监听（放在其他 useEffect 附近）：

```tsx
useEffect(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { targetFile: string; sectionTitle?: string };
    setPendingRevise(detail);
    // 聚焦输入框（inputRef 已存在或需新增 ref）
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  window.addEventListener(REVISE_TO_CHAT_EVENT, handler);
  return () => window.removeEventListener(REVISE_TO_CHAT_EVENT, handler);
}, []);
```

若 ChatPanel 无 inputRef，新增：`const inputRef = useRef<HTMLTextAreaElement>(null);` 并挂到 textarea。

- [ ] **Step 2: 发送逻辑改造**

ChatPanel 内 sendMessage 的包装函数（约 130-142 行的 `sendMessage` 局部函数，即调用 hook 的 sendMessage 的地方）改为：

```tsx
const submitMessage = () => {
  const text = input.trim();
  if (!text) return;
  if (pendingRevise) {
    const note = pendingRevise.sectionTitle
      ? `【定向修订：仅修改「${pendingRevise.sectionTitle}」这一节】\n${text}`
      : text;
    sendMessage({
      projectId, agentId, skillId, stage,
      message: text,
      mode: 'revise',
      targetFile: pendingRevise.targetFile,
      revisionNote: note,
    });
    setPendingRevise(null);
  } else {
    sendMessage({ projectId, agentId, skillId, stage, message: text });
  }
  setInput('');
};
```

将原调用 `sendMessage(...)` 的发送处（表单 onSubmit / 按钮 onClick）改为调 `submitMessage()`。

- [ ] **Step 3: 修订提示条 UI**

在输入框上方条件渲染：

```tsx
{pendingRevise && (
  <div className={reviseBanner}>
    📌 正在修订 {pendingRevise.targetFile}
    {pendingRevise.sectionTitle ? ` · ${pendingRevise.sectionTitle}` : ''}
    <button className={reviseBannerClose} onClick={() => setPendingRevise(null)}>✕</button>
  </div>
)}
```

新增样式（文件顶部 css 区）：

```ts
const reviseBanner = css`
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.75rem; margin-bottom: 0.4rem;
  background: var(--haze-color-bg-secondary); border: 1px solid var(--haze-color-border);
  border-radius: 6px; font-size: 0.8rem; color: var(--haze-color-text);
`;
const reviseBannerClose = css`
  margin-left: auto; background: none; border: none; cursor: pointer;
  color: var(--haze-color-text-secondary); font-size: 0.9rem;
  &:hover { color: var(--haze-color-text); }
`;
```

placeholder 动态（textarea 的 placeholder）：

```tsx
placeholder={pendingRevise ? `输入对 ${pendingRevise.targetFile} 的修订意见...` : '输入消息，或使用 / 命令...'}
```

- [ ] **Step 4: 切换对话清空 pendingRevise**

`/new` 命令的 action（约 197 行）和 loadConversation/resetConversation 调用处，加 `setPendingRevise(null)`：

```tsx
{ name: '/new', ..., action: () => { setActiveConversationId(null); resetConversation(); setPendingRevise(null); } },
```

- [ ] **Step 5: 写 chat-panel-revise-mode.test.tsx**

```tsx
/**
 * ChatPanel 修订模式测试：监听 revise-to-chat 事件、发送时带 mode/targetFile、✕ 退出。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import ChatPanel from '../../../src/web/components/ChatPanel';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { REVISE_TO_CHAT_EVENT } from '../../../src/web/hooks/useFileRevision';

vi.mock('../../../src/web/hooks/useRun', () => ({
  useRun: () => ({
    messages: [], isRunning: false, status: '', activeRunCount: 0,
    availableCommands: [], pendingAsk: null, resolveAsk: vi.fn(),
    sendMessage: vi.fn(),  // 实际测试中替换为 spy
    cancel: vi.fn(), conversationId: null, resetConversation: vi.fn(), loadConversation: vi.fn(),
  }),
}));

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

describe('ChatPanel 修订模式', () => {
  afterEach(() => { cleanup(); });

  it('收到 revise-to-chat 事件后显示修订提示条', async () => {
    render(createElement(ChatPanel, { projectId: 'p1', agentId: 'claude', skillId: 'novel', stage: 'concept' }), { wrapper: makeWrapper() });
    act(() => {
      window.dispatchEvent(new CustomEvent(REVISE_TO_CHAT_EVENT, { detail: { targetFile: 'concept.md', sectionTitle: '核心冲突' } }));
    });
    expect(screen.getByText(/正在修订 concept\.md/)).toBeInTheDocument();
    expect(screen.getByText(/核心冲突/)).toBeInTheDocument();
  });

  it('点 ✕ 清空修订模式', async () => {
    render(createElement(ChatPanel, { projectId: 'p1', agentId: 'claude', skillId: 'novel', stage: 'concept' }), { wrapper: makeWrapper() });
    act(() => {
      window.dispatchEvent(new CustomEvent(REVISE_TO_CHAT_EVENT, { detail: { targetFile: 'concept.md' } }));
    });
    fireEvent.click(screen.getByText('✕'));
    expect(screen.queryByText(/正在修订/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: 运行测试**

Run: `cd ~/projects/open-novel && npx vitest run tests/unit/web/chat-panel-revise-mode.test.tsx 2>&1 | tail -8`
Expected: 2 passed

- [ ] **Step 7: Commit**

```bash
cd ~/projects/open-novel && git add src/web/components/ChatPanel.tsx tests/unit/web/chat-panel-revise-mode.test.tsx && git commit -m "feat(revise): ChatPanel 修订模式——监听事件 + 提示条 + 发送带 mode/targetFile"
```

---

## Task 8: 全量验证 + E2E

**Files:** 无（验证任务）

- [ ] **Step 1: typecheck**

Run: `cd ~/projects/open-novel && npm run typecheck 2>&1 | grep -v mermaid | tail -5`
Expected: 仅预存 mermaid 错误，无新错误

- [ ] **Step 2: 全量测试**

Run: `cd ~/projects/open-novel && npx vitest run 2>&1 | tail -5`
Expected: 全 pass（568 + 新增测试数）

- [ ] **Step 3: build**

Run: `cd ~/projects/open-novel && npm run build 2>&1 | tail -3`
Expected: 成功

- [ ] **Step 4: E2E 手动验证**

```bash
cd ~/projects/open-novel && pkill -9 -f 'dist/server/api.js'; nohup node dist/server/api.js > /tmp/open-novel-server.log 2>&1 & disown; sleep 4
```

浏览器验证：
1. 角色视图卡片 ✎ → ChatPanel 提示条显示「正在修订 characters/profiles.md · 剑平」+ 输入框聚焦
2. 输入意见发送 → 对话流出现 assistant 响应 + RevisionDiffPanel（diff 面板）
3. 卡片 ⇄ 重命名 → RenameDialog 弹出
4. WritingView 章节 ✎ → 提示条 targetFile 为章节路径
5. ✕ 退出修订模式

- [ ] **Step 5: 最终 Commit（若有 E2E 修复）**

```bash
cd ~/projects/open-novel && git add -A && git commit -m "test: 修订改造全量验证通过" || echo "无改动"
```

---

## Self-Review 结果

**Spec 覆盖**：
- ✅ useRun.sendMessage 扩展 → Task 1
- ✅ useFileRevision 改造 → Task 2
- ✅ RenameDialog 拆出 → Task 3
- ✅ viewShared renameBtn → Task 4
- ✅ 4 个 view 按钮拆分 → Task 5（Concept）+ Task 6（World/Character/Writing）
- ✅ ChatPanel 监听 + 修订模式 → Task 7
- ✅ 测试更新 + 新增 → 各 Task 内 + Task 8 全量验证
- ✅ 删除 RevisionDialog → Task 6 Step 5

**类型一致性**：
- `openRevise(targetFile?, sectionTitle?)` 全 plan 一致
- `openRename(targetFile?)` 全 plan 一致
- `pendingRevise` 形状 `{ targetFile, sectionTitle? }` 与 `ReviseToChatDetail` 一致
- `REVISE_TO_CHAT_EVENT` 常量从 useFileRevision 导出，ChatPanel import

**占位符扫描**：无 TBD/TODO，每步有具体代码。
