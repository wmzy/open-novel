import { useQuery } from '@tanstack/react-query';
import type { AgentCommand } from '@/agent/types';

/**
 * 预取 agent 的 slash command 列表（首屏可见，无需先发消息）。
 *
 * - 仅 ACP agent（omp）有动态命令；非 ACP 返回空（后端兜底）。
 * - 与 useRun 的 availableCommands 互补：这里负责首屏预取，run 中实时推送会覆盖。
 */
export function useAgentCommands(agentId: string | undefined) {
  return useQuery<AgentCommand[]>({
    queryKey: ['agent-commands', agentId],
    queryFn: async () => {
      if (!agentId) return [];
      const res = await fetch(`/api/agents/${agentId}/commands`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.commands ?? [];
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!agentId,
  });
}
