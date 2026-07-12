import type { StreamEvent } from './types';

type EventSink = (event: StreamEvent) => void;
type BlockState = { type?: string; name?: string; id?: string; input: string };

/**
 * 从 claude 模型名推断上下文窗口大小（tokens）。
 * Claude Code stream-json 不在 result 事件中提供窗口大小，需从模型名映射。
 */
function claudeContextWindow(model: string): number {
  const m = model.toLowerCase();
  // Claude 4 系列（Sonnet/Opus）— API 默认 200k
  if (m.includes('sonnet-4') || m.includes('opus-4')) return 200_000;
  // Claude 3.7 Sonnet — 200k
  if (m.includes('sonnet-3') || m.includes('3-7')) return 200_000;
  // Claude 3.5 系列 — 200k
  if (m.includes('3-5')) return 200_000;
  // Claude 3 系列（Haiku 3k 窗口较小）
  if (m.includes('haiku-3') && !m.includes('3-5')) return 200_000;
  // 未知模型：保守返回 200k（Claude 平台默认）
  return 200_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function createClaudeStreamHandler(onEvent: EventSink, onComplete?: () => void) {
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
      onEvent({ type: 'status', label: 'initializing', model: typeof obj.model === 'string' ? obj.model : null });
      return;
    }
    if (obj.type === 'system' && obj.subtype === 'status') {
      onEvent({ type: 'status', label: str(obj.status) || 'working' });
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
          const id = str(block.id);
          if (id && streamedToolUseIds.has(id)) {
            streamedToolUseIds.delete(id);
            continue;
          }
          onEvent({ type: 'tool_use', id, name: str(block.name), input: block.input ?? null });
        } else if (!alreadyStreamed && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          onEvent({ type: 'text_delta', delta: block.text });
        } else if (!alreadyStreamed && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
          onEvent({ type: 'thinking_delta', delta: block.thinking });
        }
      }
      return;
    }
    // Handle user messages containing tool_result blocks
    if (obj.type === 'user' && isRecord(obj.message) && Array.isArray(obj.message.content)) {
      for (const block of obj.message.content) {
        if (!isRecord(block)) continue;
        if (block.type === 'tool_result') {
          onEvent({
            type: 'tool_result',
            toolUseId: str(block.tool_use_id),
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
            isError: block.is_error === true,
          });
        }
      }
      return;
    }
    if (obj.type === 'result') {
      const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
      const usage = obj.usage as Record<string, unknown> | null;
      onEvent({ type: 'usage', usage: usage ?? null, costUsd: cost });
      // 额外发 runtime_usage：input_tokens ≈ 当前上下文 token，size 从模型推断
      const used = (usage?.input_tokens as number) ?? 0;
      if (used > 0) {
        const model = typeof obj.model === 'string' ? obj.model : '';
        onEvent({ type: 'runtime_usage', used, size: claudeContextWindow(model), costUsd: cost });
      }
      onComplete?.();
      return;
    }
  }

  function handleStreamEvent(ev: Record<string, unknown>) {
    if (ev.type === 'message_start') {
      currentMessageId = isRecord(ev.message) && typeof ev.message.id === 'string' ? ev.message.id : null;
      return;
    }
    if (ev.type === 'content_block_start' && isRecord(ev.content_block)) {
      blocks.set(blockKey(ev.index), {
        type: str(ev.content_block.type),
        name: str(ev.content_block.name),
        id: str(ev.content_block.id),
        input: '',
      });
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
      if (state && state.type === 'tool_use' && state.id && state.input.trim()) {
        try {
          onEvent({ type: 'tool_use', id: state.id, name: state.name ?? '', input: JSON.parse(state.input) });
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
