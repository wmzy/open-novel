import { useState, useCallback, useRef, useEffect } from 'react';
import type { AgentEvent, AgentCommand, AskPrompt } from '@/agent/types';
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
  /** revise run 成功后携带的修订 diff（由 revision-applied 事件填充）。 */
  revisionDiff?: { targetFile: string; diff: string; addedLines: number; removedLines: number };
}



export function useRun(conversationId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [availableCommands, setAvailableCommands] = useState<AgentCommand[]>([]);
  const [pendingAsk, setPendingAsk] = useState<AskPrompt | null>(null);
  const activeRunsRef = useRef(new Set<string>());
  const abortControllerRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId || null);
  const assistantContentRef = useRef<string>('');
  const assistantEventsRef = useRef<AgentEvent[] | null>(null);
  const assistantArtifactsRef = useRef<{ count: number; paths: string[] } | null>(null);

  // mount/刷新时连 conversation 流——一次性排空历史 messages + 活跃 run 事件。
  // 刷新后自动追回错过的响应内容，无需轮询。
  // sendMessage 保持独立的 per-run SSE（用户发新消息时的实时跟随）。
  useEffect(() => {
    if (!conversationId) return;
    let aborted = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`/api/runs/conversations/${conversationId}/stream`, {
          signal: controller.signal,
        });
        if (!res.ok || aborted) return;
        const body = res.body;
        if (!body) return;
        const reader = body.getReader();

        for await (const frame of consumeSseStream(reader, controller.signal)) {
          if (aborted) break;
          const data = frame.data as Record<string, unknown>;
          switch (frame.event) {
            case 'message': {
              // 历史/固化的完整消息
              setMessages((prev) => [...prev, {
                role: data.role as 'user' | 'assistant',
                content: data.content as string,
                events: data.events as AgentEvent[] | undefined,
                artifacts: data.artifacts as { count: number; paths: string[] } | undefined,
                endedAt: data.role === 'assistant' ? Date.now() : undefined,
              }]);
              break;
            }
            case 'agent': {
              // 确保有 assistant 占位消息来累加 delta
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last?.role !== 'assistant') {
                  return [...prev, { role: 'assistant', content: '', events: [], startedAt: Date.now() }];
                }
                return prev;
              });
              setIsRunning(true);
              handleAgentEvent(data);
              if (data.type === 'error') {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') last.endedAt = Date.now();
                  return updated;
                });
              }
              break;
            }
            case 'artifacts': {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  last.artifacts = {
                    count: Number(data.count || 0),
                    paths: Array.isArray(data.paths) ? data.paths : [],
                  };
                }
                return updated;
              });
              break;
            }
            case 'end': {
              setIsRunning(false);
              setStatus('');
              break;
            }
            case 'stderr': {
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
          }
        }
      } catch { /* abort or load error */ }
    })();

    return () => {
      aborted = true;
      controller.abort();
    };
    // handleAgentEvent / flushDeltas 是函数声明（hoisted），在 effect 闭包中可用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const sendMessage = useCallback(async (params: {
    projectId: string;
    agentId: string;
    skillId: string;
    stage: string;
    message: string;
    model?: string;
    /** 运行模式：generate（默认）或 revise（修订已有文件）。 */
    mode?: 'generate' | 'revise';
    /** revise 模式：目标文件相对 .novel/ 的路径。 */
    targetFile?: string;
    /** revise 模式：用户修订意见（后端注入 prompt）。 */
    revisionNote?: string;
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

    // 同步捕获并重置：原先把 pendingTextDelta='' 写在 setMessages 的 updater 里（延迟执行），
    // 与新到达的 delta 竞态——updater 未跑时新 delta 追加到同一 pending，导致错位合并。
    const text = pendingTextDelta;
    const thinking = pendingThinkingDelta;
    pendingTextDelta = '';
    pendingThinkingDelta = '';
    rafId = null;

    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role !== 'assistant') return updated;

      const events = [...(last.events || [])];
      if (text) events.push({ kind: 'text', text });
      if (thinking) events.push({ kind: 'thinking', text: thinking });
      last.events = events;
      assistantEventsRef.current = events;
      return updated;
    });
  }

  function handleAgentEvent(event: Record<string, unknown>) {
    const type = event.type as string;

    // commands 是临时 UI 状态，不挂到消息上
    if (type === 'commands') {
      setAvailableCommands((event.commands as AgentCommand[]) ?? []);
      return;
    }

    // ask（elicitiation）：agent 向用户提问，推给前端渲染选择框
    if (type === 'ask') {
      setPendingAsk(event.ask as AskPrompt);
      return;
    }

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
        case 'revision-applied': {
          last.revisionDiff = {
            targetFile: String(event.targetFile || ''),
            diff: String(event.diffPreview || ''),
            addedLines: Number(event.addedLines || 0),
            removedLines: Number(event.removedLines || 0),
          };
          break;
        }
      }

      assistantEventsRef.current = last.events ?? null;
      return updated;
    });
  }

  function cleanup(runId?: string) {
    // 流结束时强制 flush：最后一批经 rAF 排队但尚未触发的文本/thinking delta，
    // 若不在此处 flush 会丢失——实时视图渲染 events[]（非空时忽略 content），
    // 而后端持久化完整，故表现为「刷新后才看到完整消息」。
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    flushDeltas();

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (runId) activeRunsRef.current.delete(runId);
    if (activeRunsRef.current.size === 0) {
      setIsRunning(false);
      setStatus('');
    }
  }

  const resolveAsk = useCallback(async (action: 'accept' | 'cancel', value?: unknown) => {
    const ask = pendingAsk;
    if (!ask) return;
    setPendingAsk(null);
    // 取任意一个 active run（同一时刻只会有一个 ask）
    const runId = [...activeRunsRef.current][0];
    if (!runId) return;
    try {
      await fetch(`/api/runs/${runId}/ask/${ask.askId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, value }),
      });
    } catch { /* ignore */ }
  }, [pendingAsk]);

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
      setMessages(data.map((m: { role: string; content: string; events?: AgentEvent[]; artifacts?: { count: number; paths: string[] } }) => ({
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
    availableCommands,
    pendingAsk,
    resolveAsk,
    activeRunCount: activeRunsRef.current.size,
    sendMessage,
    cancel,
    conversationId: conversationIdRef.current,
    resetConversation,
    loadConversation,
  };
}
