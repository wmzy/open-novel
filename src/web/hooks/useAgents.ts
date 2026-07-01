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
