import type { StreamEvent } from './types';

type EventSink = (event: StreamEvent) => void;
type BlockState = { type?: unknown; name?: unknown; id?: unknown; input: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createClaudeStreamHandler(onEvent: EventSink) {
  let buffer = '';
  const blocks = new Map<string, BlockState>();
  const streamedToolUseIds = new Set<string>();
  let currentMessageId: string | null = null;
  const textStreamed = new Set<string>();

  function blockKey(index: unknown): string {
    return `${currentMessageId ?? 'anon'}:${index}`;
  }

  function feed(chunk: string) {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try { handleObject(JSON.parse(line)); }
      catch { onEvent({ type: 'raw', line }); }
    }
  }

  function flush() {
    const rem = buffer.trim();
    buffer = '';
    if (!rem) return;
    try { handleObject(JSON.parse(rem)); }
    catch { onEvent({ type: 'raw', line: rem }); }
  }

  function handleObject(obj: unknown) {
    if (!isRecord(obj)) return;

    if (obj.type === 'system' && obj.subtype === 'init') {
      onEvent({ type: 'status', label: 'initializing', model: obj.model ?? null });
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'status') {
      onEvent({ type: 'status', label: obj.status ?? 'working' });
      return;
    }
    if (obj.type === 'stream_event' && isRecord(obj.event)) {
      handleStreamEvent(obj.event);
      return;
    }
    if (obj.type === 'assistant' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      currentMessageId = typeof obj.message.id === 'string' ? obj.message.id : currentMessageId;
      const msgId = typeof obj.message.id === 'string' ? obj.message.id : null;
      const alreadyStreamed = msgId ? textStreamed.has(msgId) : false;
      for (const block of obj.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_use') {
          if (typeof block.id === 'string' && streamedToolUseIds.has(block.id)) {
            streamedToolUseIds.delete(block.id);
            continue;
          }
          onEvent({ type: 'tool_use', id: block.id, name: block.name, input: block.input ?? null });
        } else if (!alreadyStreamed && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          onEvent({ type: 'text_delta', delta: block.text });
        } else if (!alreadyStreamed && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
          onEvent({ type: 'thinking_delta', delta: block.thinking });
        }
      }
      return;
    }
    if (obj.type === 'result') {
      onEvent({ type: 'usage', usage: obj.usage ?? null, costUsd: obj.total_cost_usd ?? null });
      return;
    }
  }

  function handleStreamEvent(ev: Record<string, unknown>) {
    if (ev.type === 'message_start') {
      currentMessageId = isRecord(ev.message) && typeof ev.message.id === 'string' ? ev.message.id : null;
      return;
    }
    if (ev.type === 'content_block_start' && isRecord(ev.content_block)) {
      blocks.set(blockKey(ev.index), { type: ev.content_block.type, name: ev.content_block.name, id: ev.content_block.id, input: '' });
      return;
    }
    if (ev.type === 'content_block_delta' && isRecord(ev.delta)) {
      const state = blocks.get(blockKey(ev.index));
      const delta = ev.delta;
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'text_delta', delta: delta.text });
        return;
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        if (currentMessageId) textStreamed.add(currentMessageId);
        onEvent({ type: 'thinking_delta', delta: delta.thinking });
        return;
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        if (state && state.type === 'tool_use') state.input += delta.partial_json;
        return;
      }
    }
    if (ev.type === 'content_block_stop') {
      const key = blockKey(ev.index);
      const state = blocks.get(key);
      if (state && state.type === 'tool_use' && typeof state.id === 'string' && state.input.trim()) {
        try {
          onEvent({ type: 'tool_use', id: state.id, name: state.name, input: JSON.parse(state.input) });
          streamedToolUseIds.add(state.id);
        } catch { /* malformed JSON, skip */ }
      }
      blocks.delete(key);
    }
  }

  return { feed, flush };
}

export function createJsonEventHandler(onEvent: EventSink) {
  let buffer = '';
  return {
    feed(chunk: string) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          onEvent({ type: obj.type || 'raw', ...obj });
        } catch {
          onEvent({ type: 'raw', line });
        }
      }
    },
    flush() {
      const rem = buffer.trim();
      buffer = '';
      if (!rem) return;
      try { onEvent({ type: 'raw', ...JSON.parse(rem) }); }
      catch { onEvent({ type: 'raw', line: rem }); }
    },
  };
}
