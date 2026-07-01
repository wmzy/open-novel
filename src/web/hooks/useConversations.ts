import { useQuery } from '@tanstack/react-query';

export interface Conversation {
  id: string;
  projectId: string;
  agentId: string;
  stage: string | null;
  createdAt: string;
}

export interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

export function useConversations(projectId: string) {
  return useQuery({
    queryKey: ['conversations', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/conversations`);
      if (!res.ok) throw new Error('Failed to fetch conversations');
      const data = await res.json();
      return data.conversations as Conversation[];
    },
    enabled: !!projectId,
  });
}

export function useConversationMessages(conversationId: string | null) {
  return useQuery({
    queryKey: ['conversation-messages', conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const res = await fetch(`/api/conversations/${conversationId}/messages`);
      if (!res.ok) throw new Error('Failed to fetch messages');
      const data = await res.json();
      return data.messages as ConversationMessage[];
    },
    enabled: !!conversationId,
  });
}
