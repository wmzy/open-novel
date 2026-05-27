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
});
