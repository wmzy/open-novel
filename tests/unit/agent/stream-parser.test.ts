import { describe, it, expect } from 'vitest';
import { createClaudeStreamHandler } from '@/agent/stream-parser';

describe('createClaudeStreamHandler', () => {
  it('parses text_delta events', () => {
    const events: any[] = [];
    const handler = createClaudeStreamHandler((e) => events.push(e));

    handler.feed(JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'msg1' } },
    }) + '\n');

    handler.feed(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    }) + '\n');

    handler.flush();

    expect(events.some((e) => e.type === 'text_delta' && e.delta === 'Hello')).toBe(true);
  });

  it('result 事件同时发 usage 和 runtime_usage', () => {
    const events: any[] = [];
    const handler = createClaudeStreamHandler((e) => events.push(e));

    handler.feed(JSON.stringify({
      type: 'result',
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 12500, output_tokens: 567 },
      total_cost_usd: 0.05,
    }) + '\n');

    handler.flush();

    // usage 事件持久化到 AgentEvent
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toBeDefined();
    expect(usage.usage).toEqual({ input_tokens: 12500, output_tokens: 567 });
    expect(usage.costUsd).toBe(0.05);

    // runtime_usage 推前端上下文指示条（used = input_tokens，size 从模型推断）
    const rt = events.find((e) => e.type === 'runtime_usage');
    expect(rt).toBeDefined();
    expect(rt.used).toBe(12500);
    expect(rt.size).toBe(200_000); // claude-sonnet-4 → 200k
    expect(rt.costUsd).toBe(0.05);
  });
});
