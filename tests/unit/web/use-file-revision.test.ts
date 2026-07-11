import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileRevision, REVISE_TO_CHAT_EVENT } from '../../../src/web/hooks/useFileRevision';

// RenameDialog 内部 useQuery 会拉 state.json；mock 掉避免网络
vi.mock('../../../src/web/components/RenameDialog', () => ({
  default: () => null, // 占位组件
}));

describe('useFileRevision', () => {
  const baseOpts = {
    projectId: 'proj_1',
    targetFile: 'concept.md',
    stage: 'concept',
  };

  let lastDetail: unknown = undefined;
  let detailCount = 0;
  const handler = (e: Event) => {
    if (e.type === REVISE_TO_CHAT_EVENT) {
      lastDetail = (e as CustomEvent).detail;
      detailCount += 1;
    }
  };

  beforeEach(() => {
    lastDetail = undefined;
    detailCount = 0;
    window.addEventListener(REVISE_TO_CHAT_EVENT, handler);
  });
  afterEach(() => {
    window.removeEventListener(REVISE_TO_CHAT_EVENT, handler);
  });

  it('初始状态：renameDialog 为 null', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    expect(result.current.renameDialog).toBeNull();
  });

  it('openRevise() dispatch revise-to-chat 事件，含 targetFile', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openRevise());
    expect(detailCount).toBe(1);
    expect(lastDetail).toEqual({
      targetFile: 'concept.md',
      sectionTitle: undefined,
    });
  });

  it('openRevise(cardPath) 直接指定卡片路径', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openRevise('concept/核心冲突.md'));
    expect((lastDetail as { targetFile: string }).targetFile).toBe('concept/核心冲突.md');
  });

  it('openRevise(targetFile?) 覆盖默认 targetFile', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openRevise('chapters/第3章.md'));
    expect((lastDetail as { targetFile: string }).targetFile).toBe('chapters/第3章.md');
  });

  it('openRevise() 在 targetFile 为空时静默不 dispatch（防 WritingView 空路径）', () => {
    const { result } = renderHook(() =>
      useFileRevision({ ...baseOpts, targetFile: '' }),
    );
    act(() => result.current.openRevise());
    expect(detailCount).toBe(0);
  });

  it('openRename / closeRename 不报错', () => {
    const { result } = renderHook(() => useFileRevision(baseOpts));
    act(() => result.current.openRename());
    act(() => result.current.closeRename());
    expect(result.current.renameDialog).toBeNull();
  });

  it('closeRename 触发 onClose 回调', () => {
    const onClose = vi.fn();
    const { result } = renderHook(() =>
      useFileRevision({ ...baseOpts, onClose }),
    );
    act(() => result.current.openRename());
    act(() => result.current.closeRename());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
