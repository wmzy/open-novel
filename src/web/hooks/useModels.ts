import { useQuery } from '@tanstack/react-query';

export interface ModelOption {
  id: string;
  label: string;
}

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
