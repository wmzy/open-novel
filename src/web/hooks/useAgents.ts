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

/**
 * 默认 agent 解析：优先用户「设置 → 首选 Agent」（DB 持久化），
 * 其次按 claude → opencode → omp 顺序取首个可用，无可用回退 'claude'。
 * 前提：此前「首选 Agent」仅写库从不读取，是无效果的死配置——现接入为默认来源。
 * 显式选择（localStorage open-novel:agentId）仍由 useAgentSelection 优先，不受影响。
 */
export function useDefaultAgent(): string {
  const { data: agents } = useAgents();
  const { data: settings } = useQuery<{ preferred_agent?: string }>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to fetch settings');
      const data = await res.json();
      return data.settings as { preferred_agent?: string };
    },
    staleTime: 60_000,
  });
  const avail = agents?.filter((a) => a.available) ?? [];
  const preferred = settings?.preferred_agent;
  // 首选 agent 已卸载/不可用 → 静默回退优先级顺序，不阻塞默认解析。
  if (preferred && avail.some((a) => a.id === preferred)) return preferred;
  const order = ['claude', 'opencode', 'omp'];
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
