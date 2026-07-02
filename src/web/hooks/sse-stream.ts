/** SSE (Server-Sent Events) 流解析工具——纯函数，零 React 依赖，可独立测试。 */

export const MAX_RECONNECT_ATTEMPTS = 3;

export interface SseFrame {
  event: string;
  data: unknown;
  id?: string;
}

/** Parse a single SSE frame (block separated by \n\n) into its constituent fields. */
export function parseSseFrame(frame: string): SseFrame | null {
  const lines = frame.split('\n');
  let event = 'message';
  let id: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('id: ')) id = line.slice(4).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) return null;
  return { event, data: JSON.parse(dataLines.join('\n')), id };
}

/** Consume an SSE response body reader, yielding parsed frames until the stream ends or aborts. */
export async function* consumeSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop()!; // keep incomplete tail
    for (const part of parts) {
      if (!part.trim()) continue;
      const frame = parseSseFrame(part);
      if (frame) yield frame;
    }
  }

  // Flush any remaining buffer
  if (buffer.trim()) {
    const frame = parseSseFrame(buffer);
    if (frame) yield frame;
  }
}
