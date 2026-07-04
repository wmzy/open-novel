import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useCallback } from 'react';

export interface ModelOption {
  id: string;
  label: string;
}

const MODEL_STORAGE_KEY = 'open-novel:modelId';
const MODEL_CHANGE_EVENT = 'open-novel:model-change';

export function useModels(agentId: string) {
  return useQuery({
    queryKey: ['models', agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/models`);
      if (!res.ok) throw new Error('Failed to fetch models');
      const data = await res.json();
      return data.models as ModelOption[];
    },
    enabled: !!agentId,
  });
}

/**
 * 用户可手动选择的模型，持久化到 localStorage，跨组件/跨窗口同步。
 *
 * - 首次使用（无存储值）→ 'default'
 * - 存储值不在当前可用模型列表中（如切换 agent 后）→ 回退 'default'，
 *   但 localStorage 保留原值，切回原 agent 列表加载后自动恢复
 * - setSelectedModel 写 localStorage 并 dispatch 事件，所有调用方同步
 *
 * 与 useAgentSelection 同构，保证「刷新/重进项目后记住上次选择的模型」。
 */
export function useModelSelection(availableModelIds: string[]): [string, (id: string) => void] {
  const [stored, setStored] = useState<string>(() => {
    try { return localStorage.getItem(MODEL_STORAGE_KEY) ?? 'default'; } catch { return 'default'; }
  });

  // 跨组件/跨窗口同步
  useEffect(() => {
    const handler = () => {
      try { setStored(localStorage.getItem(MODEL_STORAGE_KEY) ?? 'default'); } catch { /* ignore */ }
    };
    window.addEventListener('storage', handler);
    window.addEventListener(MODEL_CHANGE_EVENT, handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(MODEL_CHANGE_EVENT, handler);
    };
  }, []);

  const setSelectedModel = useCallback((id: string) => {
    try { localStorage.setItem(MODEL_STORAGE_KEY, id); } catch { /* ignore */ }
    setStored(id);
    window.dispatchEvent(new Event(MODEL_CHANGE_EVENT));
  }, []);

  // 校验：存储值仍可用（或为 default），否则回退 default
  const valid = stored === 'default' || availableModelIds.includes(stored);
  return [valid ? stored : 'default', setSelectedModel];
}
