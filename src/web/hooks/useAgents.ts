import { useQuery } from '@tanstack/react-query';
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
