import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'open-novel:chat-panel-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 280;
const MAX_WIDTH = 760;

function clamp(v: number) {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v));
}

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const n = Number(raw);
    return Number.isFinite(n) ? clamp(n) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/**
 * 右侧会话面板宽度，支持拖拽调整并持久化到 localStorage。
 *
 * - 初始值取 localStorage（缺失/越界回退 400）
 * - 通过分隔条的 PointerEvent 调整：向左拖 → 变宽
 * - 拖动期间禁用 body 文本选中、固定 col-resize 光标
 */
export function useChatPanelWidth() {
  const [width, setWidth] = useState<number>(readStored);
  const [isResizing, setIsResizing] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  // 持久化（每次变化都存）
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(width)); } catch { /* ignore */ }
  }, [width]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: width };
    setIsResizing(true);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = dragState.current;
    if (!s) return;
    const dx = s.startX - e.clientX; // 向左拖 → chat 变宽
    setWidth(clamp(s.startWidth + dx));
  }, []);

  const endDrag = useCallback((e?: React.PointerEvent) => {
    if (!dragState.current) return;
    dragState.current = null;
    setIsResizing(false);
    if (e) {
      try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  // 组件卸载时兜底清理
  useEffect(() => () => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  return {
    width,
    isResizing,
    resizeHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
