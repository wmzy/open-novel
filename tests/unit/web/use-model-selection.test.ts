import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useModelSelection } from '../../../src/web/hooks/useModels';

describe('useModelSelection', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('无存储值时返回 default', () => {
    const { result } = renderHook(() => useModelSelection(['m1', 'm2']));
    expect(result.current[0]).toBe('default');
  });

  it('存储值在可用列表中时返回该值', () => {
    localStorage.setItem('open-novel:modelId', 'm2');
    const { result } = renderHook(() => useModelSelection(['m1', 'm2']));
    expect(result.current[0]).toBe('m2');
  });

  it('default 始终有效（即使不在可用列表）', () => {
    localStorage.setItem('open-novel:modelId', 'default');
    const { result } = renderHook(() => useModelSelection(['m1', 'm2']));
    expect(result.current[0]).toBe('default');
  });

  it('存储值不在可用列表中时回退 default（切 agent 场景）', () => {
    localStorage.setItem('open-novel:modelId', 'old-model');
    const { result } = renderHook(() => useModelSelection(['m1', 'm2']));
    expect(result.current[0]).toBe('default');
  });

  it('setSelectedModel 写入 localStorage 并更新返回值', () => {
    const { result } = renderHook(() => useModelSelection(['m1', 'm2']));
    act(() => result.current[1]('m1'));
    expect(result.current[0]).toBe('m1');
    expect(localStorage.getItem('open-novel:modelId')).toBe('m1');
  });

  it('setSelectedModel 写 default 也持久化', () => {
    localStorage.setItem('open-novel:modelId', 'm1');
    const { result } = renderHook(() => useModelSelection(['m1', 'm2']));
    act(() => result.current[1]('default'));
    expect(localStorage.getItem('open-novel:modelId')).toBe('default');
  });

  it('可用列表更新后自动恢复之前被隐藏的选择（切回原 agent）', () => {
    // 用户在 agent A 选了 a-model，切到 agent B（列表不含 a-model → 显示 default）
    localStorage.setItem('open-novel:modelId', 'a-model');
    const { result, rerender } = renderHook(
      ({ ids }) => useModelSelection(ids),
      { initialProps: { ids: ['b-model'] } },
    );
    expect(result.current[0]).toBe('default');

    // 切回 agent A，列表恢复含 a-model → 自动恢复显示
    rerender({ ids: ['a-model', 'b-model'] });
    expect(result.current[0]).toBe('a-model');
  });

  it('跨 hook 实例同步（自定义事件）', () => {
    const a = renderHook(() => useModelSelection(['m1', 'm2']));
    const b = renderHook(() => useModelSelection(['m1', 'm2']));
    act(() => a.result.current[1]('m2'));
    // b 实例通过 MODEL_CHANGE_EVENT 同步
    expect(b.result.current[0]).toBe('m2');
  });

  it('storage 事件触发同步（模拟另一窗口修改 localStorage）', () => {
    const { result } = renderHook(() => useModelSelection(['m1', 'm2']));
    act(() => {
      // 真实浏览器中 storage 事件触发时 localStorage 已被另一窗口修改
      localStorage.setItem('open-novel:modelId', 'm1');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'open-novel:modelId',
        newValue: 'm1',
      }));
    });
    expect(result.current[0]).toBe('m1');
  });
});
