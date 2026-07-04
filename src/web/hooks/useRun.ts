import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentEvent } from '@/agent/types';
import { consumeSseStream, MAX_RECONNECT_ATTEMPTS } from './sse-stream';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  events?: AgentEvent[];
  startedAt?: number;
  endedAt?: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  error?: string;
  artifacts?: { count: number; paths: string[] };
}



export function useRun(conversationId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const activeRunsRef = useRef(new Set<string>());
  const abortControllerRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId || null);
  const assistantContentRef = useRef<string>('');
  const assistantEventsRef = useRef<AgentEvent[] | null>(null);
  const assistantArtifactsRef = useRef<{ count: number; paths: string[] } | null>(null);

  // Load existing messages when conversationId is provided on mount
  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setMessages(data.messages.map((m: { role: string; content: string; events?: AgentEvent[]; artifacts?: { count: number; paths: string[] } }) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          events: m.events ?? undefined,
          artifacts: m.artifacts ?? undefined,
        })));
      } catch { /* ignore load errors */ }
    })();
    return () => { cancelled = true; };
  }, [conversationId]);

  const sendMessage = useCallback(async (params: {
    projectId: string;
    agentId: string;
    skillId: string;
    stage: string;
    message: string;
    model?: string;
  }) => {
    // Add user message
    setMessages((prev) => [...prev, { role: 'user', content: params.message }]);
    setIsRunning(true);
    setStatus('starting');

    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...params, conversationId: conversationIdRef.current }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        let errorMsg = 'Request failed';
        if (errBody) {
          try { errorMsg = JSON.parse(errBody).error || errorMsg; }
          catch { errorMsg = errBody; }
        }
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            last.error = errorMsg;
            last.endedAt = Date.now();
          } else {
            updated.push({ role: 'assistant', content: '', error: errorMsg, endedAt: Date.now() });
          }
          return updated;
        });
        setIsRunning(false);
        setStatus('');
        return;
      }

      const { runId, conversationId: returnedConvId } = await res.json();
      activeRunsRef.current.add(runId);
      if (returnedConvId) conversationIdRef.current = returnedConvId;

      // Add assistant message placeholder
      const startedAt = Date.now();
      assistantContentRef.current = '';
      assistantEventsRef.current = null;
      assistantArtifactsRef.current = null;
      setMessages((prev) => [...prev, { role: 'assistant', content: '', events: [], startedAt }]);

      // Connect to SSE stream with reconnection support
      let lastEventId: string | undefined;
      let attempts = 0;

      while (attempts <= MAX_RECONNECT_ATTEMPTS) {
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const sseHeaders: Record<string, string> = {};
        if (lastEventId) sseHeaders['Last-Event-ID'] = lastEventId;

        const sseRes = await fetch(`/api/runs/${runId}/events`, { headers: sseHeaders, signal: controller.signal });

        if (!sseRes.ok) {
          const errBody = await sseRes.text().catch(() => '');
          let errorMsg = `SSE connection failed (${sseRes.status})`;
          if (errBody) {
            try { errorMsg = JSON.parse(errBody).error || errorMsg; }
            catch { errorMsg = errBody.slice(0, 200); }
          }
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant' && !last.endedAt) {
              last.error = errorMsg;
              last.endedAt = Date.now();
            }
            return updated;
          });
          cleanup(runId);
          return;
        }

        const body = sseRes.body;
        if (!body) {
          cleanup(runId);
          return;
        }

        const reader = body.getReader();
        let streamEnded = false;
        let receivedEvents = false;

        try {
          for await (const frame of consumeSseStream(reader, controller.signal)) {
            receivedEvents = true;
            lastEventId = frame.id;
            const data = frame.data as Record<string, unknown>;

            switch (frame.event) {
              case 'agent':
                handleAgentEvent(data);
                // Agent-level error (crash, quota exhausted) ends the stream
                if (data.type === 'error') {
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') last.endedAt = Date.now();
                    return updated;
                  });
                  streamEnded = true;
                }
                break;
              case 'artifacts':
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    last.artifacts = {
                      count: Number(data.count || 0),
                      paths: Array.isArray(data.paths) ? data.paths : [],
                    };
                    assistantArtifactsRef.current = last.artifacts;
                  }
                  return updated;
                });
                break;
              case 'end':
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') last.endedAt = Date.now();
                  return updated;
                });
                streamEnded = true;
                break;
              case 'stderr':
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    last.events = [...(last.events || []), { kind: 'raw', line: String(data.text || '') }];
                  }
                  return updated;
                });
                break;
            }

            if (streamEnded) break;
          }
        } catch (readErr) {
          if (controller.signal.aborted) {
            // Intentional cancel
            cleanup(runId);
            return;
          }
          // Unexpected read error - attempt reconnect
          if (attempts < MAX_RECONNECT_ATTEMPTS && lastEventId) {
            attempts++;
            setStatus(`Reconnecting (${attempts}/${MAX_RECONNECT_ATTEMPTS})...`);
            await new Promise((r) => setTimeout(r, 1000 * attempts));
            continue;
          }
          // Exhausted retries
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === 'assistant' && !last.endedAt) {
              last.error = readErr instanceof Error ? readErr.message : 'Connection lost';
              last.endedAt = Date.now();
            }
            return updated;
          });
          cleanup(runId);
          return;
        } finally {
          reader.releaseLock();
        }

        if (streamEnded || !receivedEvents) break;

        // Stream closed without an 'end' event - reconnect
        if (attempts < MAX_RECONNECT_ATTEMPTS && lastEventId) {
          attempts++;
          setStatus(`Reconnecting (${attempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          await new Promise((r) => setTimeout(r, 1000 * attempts));
          continue;
        }

        break;
      }

      cleanup(runId);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: '',
        error: err instanceof Error ? err.message : 'Unknown error',
        endedAt: Date.now(),
      }]);
      setIsRunning(false);
      setStatus('');
    }
  }, []);

  // Batch text_delta updates to reduce re-renders
  let pendingTextDelta = '';
  let pendingThinkingDelta = '';
  let rafId: number | null = null;

  function flushDeltas() {
    if (!pendingTextDelta && !pendingThinkingDelta) return;

    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role !== 'assistant') return updated;

      if (pendingTextDelta) {
        last.events = [...(last.events || []), { kind: 'text', text: pendingTextDelta }];
        pendingTextDelta = '';
      }
      if (pendingThinkingDelta) {
        last.events = [...(last.events || []), { kind: 'thinking', text: pendingThinkingDelta }];
        pendingThinkingDelta = '';
      }

      assistantEventsRef.current = last.events ?? null;
      return updated;
    });

    rafId = null;
  }

  function handleAgentEvent(event: Record<string, unknown>) {
    const type = event.type as string;

    // Handle text/thinking deltas with batching
    if (type === 'text_delta') {
      const delta = String(event.delta || '');
      pendingTextDelta += delta;
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant') {
          last.content += delta;
          assistantContentRef.current = last.content;
        }
        return updated;
      });
      if (!rafId) rafId = requestAnimationFrame(flushDeltas);
      return;
    }

    if (type === 'thinking_delta') {
      const delta = String(event.delta || '');
      pendingThinkingDelta += delta;
      if (!rafId) rafId = requestAnimationFrame(flushDeltas);
      return;
    }

    // Flush any pending deltas before other event types
    if (rafId) {
      cancelAnimationFrame(rafId);
      flushDeltas();
    }

    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role !== 'assistant') return updated;

      const events = last.events || [];

      switch (type) {
        case 'status': {
          const label = String(event.label || '');
          setStatus(label);
          last.events = [...events, { kind: 'status', label, detail: event.detail as string | undefined }];
          break;
        }
        case 'thinking_delta': {
          // Already handled above
          break;
        }
        case 'tool_use': {
          last.events = [...events, {
            kind: 'tool_use',
            id: String(event.id || ''),
            name: String(event.name || ''),
            input: event.input,
          }];
          break;
        }
        case 'tool_result': {
          last.events = [...events, {
            kind: 'tool_result',
            toolUseId: String(event.toolUseId || ''),
            content: String(event.content || ''),
            isError: event.isError === true,
          }];
          break;
        }
        case 'usage': {
          const usage = event.usage as Record<string, unknown> | null;
          last.usage = {
            inputTokens: usage?.input_tokens as number | undefined,
            outputTokens: usage?.output_tokens as number | undefined,
            costUsd: event.costUsd as number | undefined,
          };
          last.events = [...events, {
            kind: 'usage',
            inputTokens: usage?.input_tokens as number | undefined,
            outputTokens: usage?.output_tokens as number | undefined,
            costUsd: event.costUsd as number | undefined,
          }];
          break;
        }
        case 'error': {
          last.error = String(event.message || 'Unknown error');
          last.events = [...events, { kind: 'raw', line: String(event.message || '') }];
          break;
        }
        case 'raw': {
          last.events = [...events, { kind: 'raw', line: String(event.line || '') }];
          break;
        }
      }

      assistantEventsRef.current = last.events ?? null;
      return updated;
    });
  }

  function cleanup(runId?: string) {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (runId) activeRunsRef.current.delete(runId);
    if (activeRunsRef.current.size === 0) {
      setIsRunning(false);
      setStatus('');
    }
  }

  const cancel = useCallback(async () => {
    // Cancel all active runs
    for (const rid of activeRunsRef.current) {
      try { await fetch(`/api/runs/${rid}`, { method: 'DELETE' }); }
      catch { /* ignore */ }
    }
    activeRunsRef.current.clear();
    setIsRunning(false);
    setStatus('');
  }, []);

  const resetConversation = useCallback(() => {
    conversationIdRef.current = null;
    setMessages([]);
  }, []);

  const loadConversation = useCallback(async (convId: string) => {
    conversationIdRef.current = convId;
    try {
      const res = await fetch(`/api/conversations/${convId}/messages`);
      if (!res.ok) return;
      const data = await res.json();
      setMessages(data.messages.map((m: { role: string; content: string; events?: AgentEvent[]; artifacts?: { count: number; paths: string[] } }) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        events: m.events ?? undefined,
        artifacts: m.artifacts ?? undefined,
      })));
    } catch { /* ignore */ }
  }, []);

  return {
    messages,
    isRunning,
    status,
    activeRunCount: activeRunsRef.current.size,
    sendMessage,
    cancel,
    conversationId: conversationIdRef.current,
    resetConversation,
    loadConversation,
  };
}
