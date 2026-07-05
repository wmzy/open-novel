import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, render, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { useFileRevision } from '../../../src/web/hooks/useFileRevision';

// mock useAgentSelection，避免触碰 localStorage / agents 查询
vi.mock('../../../src/web/hooks/useAgents', () => ({
  useAgentSelection: () => ['agent_x', vi.fn()],
}));

// 捕获 fetch 调用
const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

beforeEach(() => {
  fetchSpy.mockReset();
  // RevisionDialog rename 模式 useQuery 拉 state.json 取角色列表；
  // 其他请求（runs/rename/checkName）返回空对象即可。
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
    const { result } = renderHook(() => useFileRevision(baseOpts), { wrapper: makeWrapper() });
    expect(result.current.dialog).toBeNull();
  });

  it('openDialog() 后 dialog 非空（使用 options.targetFile）', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts), { wrapper: makeWrapper() });
    act(() => result.current.openDialog());
    expect(result.current.dialog).not.toBeNull();
  });

  it('closeDialog() 后 dialog 回到 null', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts), { wrapper: makeWrapper() });
    act(() => result.current.openDialog());
    act(() => result.current.closeDialog());
    expect(result.current.dialog).toBeNull();
  });

  it('openDialog(targetFile?) 覆盖 options.targetFile', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts), { wrapper: makeWrapper() });
    act(() => result.current.openDialog('chapters/第3章.md'));
    const { queryByText } = render(result.current.dialog as ReactNode, { wrapper: makeWrapper() });
    // RevisionDialog 标题格式「修订 · {targetFile}」
    expect(queryByText(/修订 · chapters\/第3章\.md/)).not.toBeNull();
    cleanup();
  });

  it('onClose 回调在 closeDialog 时触发', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useFileRevision({ ...baseOpts, onClose }), {
      wrapper: makeWrapper(),
    });
    act(() => result.current.openDialog());
    act(() => result.current.closeDialog());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('targetFile 为空字符串时不渲染 dialog', () => {
    const { result } = renderHook(
      () => useFileRevision({ ...baseOpts, targetFile: '' }),
      { wrapper: makeWrapper() },
    );
    act(() => result.current.openDialog());
    // targetFile 为空 → dialog 渲染规则要求非空才渲染
    expect(result.current.dialog).toBeNull();
  });

  it('revise 模式：onSubmit 发 POST /api/runs，body 含 mode/targetFile/revisionNote', async () => {
    const { result } = renderHook(() => useFileRevision(baseOpts), { wrapper: makeWrapper() });
    act(() => result.current.openDialog());

    const { container } = render(result.current.dialog as ReactNode, { wrapper: makeWrapper() });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '把核心冲突改为复仇' } });
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('执行修订'),
    )!;
    await act(async () => {
      fireEvent.click(submitBtn);
    });

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
    cleanup();
  });

  it('rename 模式：onSubmit 发 POST /api/projects/:id/rename', async () => {
    const { result } = renderHook(() => useFileRevision(baseOpts), { wrapper: makeWrapper() });
    act(() => result.current.openDialog());

    const { container } = render(result.current.dialog as ReactNode, { wrapper: makeWrapper() });
    // 切到「重命名」tab
    const renameTab = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.trim() === '重命名',
    )!;
    await act(async () => {
      fireEvent.click(renameTab);
    });

    // 等角色列表 useQuery 解析出 option
    await waitFor(() => {
      expect(container.querySelector('option[value="旧角色"]')).not.toBeNull();
    });
    const select = container.querySelector('select')!;
    await act(async () => {
      fireEvent.change(select, { target: { value: '旧角色' } });
    });
    const nameInput = container.querySelector('input:not([type="checkbox"])')!;
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '新角色' } });
    });

    const submitBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('执行修订'),
    )!;
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    const renameCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes('/rename'),
    )!;
    expect(renameCall).toBeTruthy();
    const callBody = JSON.parse(renameCall[1].body);
    expect(callBody).toMatchObject({ oldName: '旧角色', newName: '新角色' });
    cleanup();
  });

  it('提交成功后自动关闭弹窗并触发 onClose', async () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useFileRevision({ ...baseOpts, onClose }), {
      wrapper: makeWrapper(),
    });
    act(() => result.current.openDialog());
    expect(result.current.dialog).not.toBeNull();

    const { container } = render(result.current.dialog as ReactNode, { wrapper: makeWrapper() });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '改一下' } });
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('执行修订'),
    )!;
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    expect(onClose).toHaveBeenCalled();
    expect(result.current.dialog).toBeNull();
    cleanup();
  });

  it('卡片级：openDialog(undefined, sectionTitle) 提交时 revisionNote 前置定向锚点', async () => {
    const { result } = renderHook(() => useFileRevision(baseOpts), { wrapper: makeWrapper() });
    act(() => result.current.openDialog(undefined, '核心冲突'));

    const { container } = render(result.current.dialog as ReactNode, { wrapper: makeWrapper() });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '把冲突改得更尖锐' } });
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('执行修订'),
    )!;
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody.revisionNote).toContain('【定向修订：仅修改「核心冲突」这一节');
    expect(callBody.revisionNote).toContain('把冲突改得更尖锐');
    expect(callBody.message).toBe(callBody.revisionNote);
    expect(callBody.targetFile).toBe('concept.md');
    cleanup();
  });

  it('卡片级：closeDialog 重置 sectionTitle，再次 openDialog() 无锚点前缀', async () => {
    const { result } = renderHook(() => useFileRevision(baseOpts), { wrapper: makeWrapper() });
    // 先以 sectionTitle 打开，再关闭（模拟用户改主意）
    act(() => result.current.openDialog(undefined, '核心冲突'));
    act(() => result.current.closeDialog());
    // 再次以无 sectionTitle 打开并提交
    act(() => result.current.openDialog());

    const { container } = render(result.current.dialog as ReactNode, { wrapper: makeWrapper() });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '整体调整' } });
    });
    const submitBtn = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('执行修订'),
    )!;
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    const callBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(callBody.revisionNote).toBe('整体调整');
    expect(callBody.revisionNote).not.toContain('【定向修订');
    cleanup();
  });
});
