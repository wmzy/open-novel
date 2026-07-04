import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useCallback } from 'react';
import type { DetectedAgent } from '@/agent/types';

export function useAgents() {
  return useQuery<DetectedAgent[]>({
    queryKey: ['agents'],
    queryFn: async () => {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error('Failed to fetch agents');
      const data = await res.json();
      return data.agents;
    },
    staleTime: 30_000,
  });
}

/** 首个可用 agent（优先序 claude → opencode → omp），无可用回退 'claude'。 */
export function useDefaultAgent(): string {
  const { data: agents } = useAgents();
  const order = ['claude', 'opencode', 'omp'];
  const avail = agents?.filter((a) => a.available) ?? [];
  for (const id of order) {
    if (avail.some((a) => a.id === id)) return id;
  }
  return 'claude';
}

const AGENT_STORAGE_KEY = 'open-novel:agentId';
const AGENT_CHANGE_EVENT = 'open-novel:agent-change';

/**
 * 用户可手动选择的 agent，持久化到 localStorage，跨组件同步。
 *
 * - 首次使用（无存储值或存储的 agent 已不可用）→ 回退 useDefaultAgent
 * - setAgentId 写 localStorage 并 dispatch 事件，所有调用方同步
 * - 选中的 agent 变不可用（卸载）→ 自动回退 default
 */
export function useAgentSelection(): [string, (id: string) => void] {
  const { data: agents } = useAgents();
  const defaultAgent = useDefaultAgent();
  const [stored, setStored] = useState<string | null>(() => {
    try { return localStorage.getItem(AGENT_STORAGE_KEY); } catch { return null; }
  });

  // 跨组件/跨窗口同步
  useEffect(() => {
    const handler = () => {
      try { setStored(localStorage.getItem(AGENT_STORAGE_KEY)); } catch { /* ignore */ }
    };
    window.addEventListener('storage', handler);
    window.addEventListener(AGENT_CHANGE_EVENT, handler);
    return () => {
      window.removeEventListener('storage', handler);
      window.removeEventListener(AGENT_CHANGE_EVENT, handler);
    };
  }, []);

  const setAgentId = useCallback((id: string) => {
    try { localStorage.setItem(AGENT_STORAGE_KEY, id); } catch { /* ignore */ }
    setStored(id);
    window.dispatchEvent(new Event(AGENT_CHANGE_EVENT));
  }, []);

  // 校验：存储的 agent 是否仍可用，否则回退 default
  const avail = agents?.filter((a) => a.available) ?? [];
  const valid = stored !== null && avail.some((a) => a.id === stored);
  return [valid ? stored : defaultAgent, setAgentId];
}
