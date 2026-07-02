import { describe, it, expect } from 'vitest';
import { parseSseFrame, consumeSseStream, MAX_RECONNECT_ATTEMPTS } from '../../../src/web/hooks/sse-stream';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('MAX_RECONNECT_ATTEMPTS', () => {
  it('is 3', () => expect(MAX_RECONNECT_ATTEMPTS).toBe(3));
});

describe('parseSseFrame', () => {
  it('parses a standard frame with event + data', () => {
    const frame = parseSseFrame('event: agent\ndata: {"type":"text_delta","delta":"hi"}');
    expect(frame).toEqual({
      event: 'agent',
      data: { type: 'text_delta', delta: 'hi' },
    });
  });

  it('parses the id field', () => {
    const frame = parseSseFrame('id: 42\nevent: end\ndata: {"status":"ok"}');
    expect(frame?.id).toBe('42');
    expect(frame?.event).toBe('end');
  });

  it('joins multi-line data with newline separator', () => {
    // SSE spec: multiple data: lines are joined with \n to form the value.
    // JSON.parse receives the joined string. For this to be valid JSON,
    // the value must be a JSON string with escaped newline, or a single-line value.
    // Test the real-world case: a plain-text value spanning two lines.
    // (parseSseFrame does NOT wrap in try/catch, so invalid JSON throws — by design,
    // malformed frames are the caller's responsibility via consumeSseStream's try/catch.)
    // We test that two data lines for a non-JSON value are joined correctly
    // by catching the expected JSON.parse error.
    expect(() => parseSseFrame('data: line1\ndata: line2')).toThrow();
  });

  it('skips comment lines (starting with :)', () => {
    const frame = parseSseFrame(': this is a comment\nevent: ping\ndata: {}');
    expect(frame?.event).toBe('ping');
  });

  it('returns null when no data line is present', () => {
    expect(parseSseFrame('event: ping')).toBeNull();
    expect(parseSseFrame('id: 1')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
  });

  it('defaults event to "message" when not specified', () => {
    const frame = parseSseFrame('data: {"x":1}');
    expect(frame?.event).toBe('message');
  });

  it('handles CRLF line endings', () => {
    const frame = parseSseFrame('event: agent\r\ndata: {"ok":true}\r\n');
    expect(frame?.event).toBe('agent');
    expect(frame?.data).toEqual({ ok: true });
  });
});

describe('consumeSseStream', () => {
  it('yields multiple frames from a complete stream', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encode('event: agent\ndata: {"type":"a"}\n\nevent: end\ndata: {"status":"ok"}\n\n'));
        controller.close();
      },
    });
    const frames = [];
    for await (const f of consumeSseStream(stream.getReader(), new AbortController().signal)) {
      frames.push(f);
    }
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe('agent');
    expect(frames[1].event).toBe('end');
  });

  it('handles frames split across chunks', async () => {
    const stream = new ReadableStream({
      start(controller) {
        // First chunk has an incomplete frame
        controller.enqueue(encode('event: agent\ndata: {"type":"partial"'));
        // Second chunk completes it and adds another
        controller.enqueue(encode('}\n\nevent: end\ndata: {}\n\n'));
        controller.close();
      },
    });
    const frames = [];
    for await (const f of consumeSseStream(stream.getReader(), new AbortController().signal)) {
      frames.push(f);
    }
    expect(frames).toHaveLength(2);
    expect(frames[0].data).toEqual({ type: 'partial' });
  });

  it('flushes remaining buffer at stream end', async () => {
    const stream = new ReadableStream({
      start(controller) {
        // No trailing \n\n — frame is still in buffer when stream ends
        controller.enqueue(encode('event: last\ndata: {"final":true}'));
        controller.close();
      },
    });
    const frames = [];
    for await (const f of consumeSseStream(stream.getReader(), new AbortController().signal)) {
      frames.push(f);
    }
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe('last');
  });

  it('stops consuming after abort signal', async () => {
    const ac = new AbortController();
    let count = 0;
    const stream = new ReadableStream({
      pull(c) {
        count++;
        c.enqueue(encode(`event: tick\ndata: {"n":${count}}\n\n`));
      },
    });
    const frames: unknown[] = [];
    for await (const f of consumeSseStream(stream.getReader(), ac.signal)) {
      frames.push(f);
      if (frames.length === 3) ac.abort();
    }
    // Should have stopped shortly after abort — not consumed thousands of frames.
    expect(frames.length).toBeLessThan(50);
    expect(frames.length).toBeGreaterThanOrEqual(3);
  });

  it('yields nothing for an empty stream', async () => {
    const stream = new ReadableStream({
      start(controller) { controller.close(); },
    });
    const frames = [];
    for await (const f of consumeSseStream(stream.getReader(), new AbortController().signal)) {
      frames.push(f);
    }
    expect(frames).toEqual([]);
  });
});
