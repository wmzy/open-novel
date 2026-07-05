import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatPanelWidth } from '../../../src/web/hooks/useChatPanelWidth';

const STORAGE_KEY = 'open-novel:chat-panel-width';

/** 构造一个最小可用的 PointerEvent 子集，传给 hook 的回调。 */
function fakePointerEvent(clientX: number) {
  return {
    preventDefault: vi.fn(),
    currentTarget: {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    },
    pointerId: 1,
    clientX,
  } as unknown as React.PointerEvent;
}

describe('useChatPanelWidth', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it('无存储值时返回默认宽度 400', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    expect(result.current.width).toBe(400);
    expect(result.current.isResizing).toBe(false);
  });

  it('存储值有效时恢复该值', () => {
    localStorage.setItem(STORAGE_KEY, '520');
    const { result } = renderHook(() => useChatPanelWidth());
    expect(result.current.width).toBe(520);
  });

  it('存储值超过上限时 clamp 到 760', () => {
    localStorage.setItem(STORAGE_KEY, '9999');
    const { result } = renderHook(() => useChatPanelWidth());
    expect(result.current.width).toBe(760);
  });

  it('存储值低于下限时 clamp 到 280', () => {
    localStorage.setItem(STORAGE_KEY, '50');
    const { result } = renderHook(() => useChatPanelWidth());
    expect(result.current.width).toBe(280);
  });

  it('存储值非数字时回退默认 400', () => {
    localStorage.setItem(STORAGE_KEY, 'NaN-ish');
    const { result } = renderHook(() => useChatPanelWidth());
    expect(result.current.width).toBe(400);
  });

  it('宽度变化后写入 localStorage', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
      result.current.resizeHandleProps.onPointerMove(fakePointerEvent(700));
      result.current.resizeHandleProps.onPointerUp(fakePointerEvent(700));
    });
    // 起始 400，向左拖 100px → 500
    expect(localStorage.getItem(STORAGE_KEY)).toBe('500');
  });

  it('onPointerDown 进入 resizing 状态并锁定 body 光标与选中', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
    });
    expect(result.current.isResizing).toBe(true);
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
  });

  it('向左拖（clientX 减小）→ 宽度增加', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
    });
    act(() => {
      result.current.resizeHandleProps.onPointerMove(fakePointerEvent(750));
    });
    expect(result.current.width).toBe(450); // +50
  });

  it('向右拖（clientX 增大）→ 宽度减小', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
    });
    act(() => {
      result.current.resizeHandleProps.onPointerMove(fakePointerEvent(850));
    });
    expect(result.current.width).toBe(350); // -50
  });

  it('拖动不超过上限 760', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
    });
    act(() => {
      // 起始 400，向左拖 9999px → 应 clamp 到 760
      result.current.resizeHandleProps.onPointerMove(fakePointerEvent(-9199));
    });
    expect(result.current.width).toBe(760);
  });

  it('拖动不低于下限 280', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
    });
    act(() => {
      // 起始 400，向右拖 9999px → 应 clamp 到 280
      result.current.resizeHandleProps.onPointerMove(fakePointerEvent(10799));
    });
    expect(result.current.width).toBe(280);
  });

  it('未按下时 onPointerMove 不改变宽度', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerMove(fakePointerEvent(100));
    });
    expect(result.current.width).toBe(400);
  });

  it('onPointerUp 退出 resizing 并清理 body 样式', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
    });
    expect(result.current.isResizing).toBe(true);

    act(() => {
      result.current.resizeHandleProps.onPointerUp(fakePointerEvent(800));
    });
    expect(result.current.isResizing).toBe(false);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('onPointerCancel 等同 onPointerUp（异常中断也清理）', () => {
    const { result } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
    });
    act(() => {
      result.current.resizeHandleProps.onPointerCancel(fakePointerEvent(800));
    });
    expect(result.current.isResizing).toBe(false);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });

  it('组件卸载时清理 body 样式', () => {
    const { result, unmount } = renderHook(() => useChatPanelWidth());
    act(() => {
      result.current.resizeHandleProps.onPointerDown(fakePointerEvent(800));
    });
    expect(document.body.style.cursor).toBe('col-resize');
    unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
  });
});
