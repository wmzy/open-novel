import { useState, useCallback, useRef } from 'react';
import type { StreamEvent } from '@/agent/types';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  toolUse?: Array<{ id: string; name: string; input: unknown }>;
  thinking?: string;
}

export function useRun() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (params: {
    projectId: string;
    agentId: string;
    skillId: string;
    stage: string;
    message: string;
  }) => {
    setMessages((prev) => [...prev, { role: 'user', content: params.message }]);
    setIsRunning(true);
    setStatus('starting');

    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const { runId } = await res.json();

    const eventSource = new EventSource(`/api/runs/${runId}/events`);
    abortRef.current = new AbortController();

    let assistantContent = '';
    let thinkingContent = '';
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];

    eventSource.onmessage = () => {};
    eventSource.addEventListener('agent', ((e: MessageEvent) => {
      const event: StreamEvent = JSON.parse(e.data);
      switch (event.type) {
        case 'status':
          setStatus(String(event.label));
          break;
        case 'text_delta':
          assistantContent += String(event.delta);
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant') {
              last.content = assistantContent;
            } else {
              updated.push({ role: 'assistant', content: assistantContent, toolUse: [...toolUses], thinking: thinkingContent });
            }
            return updated;
          });
          break;
        case 'thinking_delta':
          thinkingContent += String(event.delta);
          break;
        case 'tool_use':
          toolUses.push({ id: String(event.id), name: String(event.name), input: event.input });
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant') {
              last.toolUse = [...toolUses];
              last.thinking = thinkingContent;
            }
            return updated;
          });
          break;
      }
    }) as EventListener);

    eventSource.addEventListener('end', () => {
      eventSource.close();
      setIsRunning(false);
      setStatus('');
      if (assistantContent) {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            last.content = assistantContent;
            last.toolUse = [...toolUses];
            last.thinking = thinkingContent;
          }
          return updated;
        });
      }
    });

    eventSource.onerror = () => {
      eventSource.close();
      setIsRunning(false);
      setStatus('error');
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setIsRunning(false);
  }, []);

  return { messages, isRunning, status, sendMessage, cancel };
}
