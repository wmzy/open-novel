/**
 * useRun hook 行为测试。
 *
 * 来源：chat 中 agent 回复实时截断、刷新后才完整的 bug——根因是流结束时未 flush
 * 经 requestAnimationFrame 排队的最后一批 text_delta。修复：cleanup 入口取消 rAF 并
 * 同步 flushDeltas；flushDeltas 同步捕获/重置 pending，消除 updater 延迟重置竞态。
 *
 * 归并建议：未来若新增 useRun 行为测试（重连、ask 流程、cancel 等），追加到本文件。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRun } from '@/web/hooks/useRun';

/** 构造一个 SSE Response：一次性 enqueue 全部帧后关闭流。 */
function sseResponse(frames: Array<{ event: string; data: unknown }>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) {
        controller.enqueue(enc.encode(`event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** 把若干文本片段拼成一串 agent text_delta 帧。 */
function textFrames(...chunks: string[]) {
  return chunks.map((delta) => ({ event: 'agent', data: { type: 'text_delta', delta } }));
}

/** 拼接一条 assistant 消息里所有 text 事件的文本（与 AgentMessage 的渲染口径一致）。 */
function assistantText(events: { kind: string; text?: string }[] | undefined): string {
  return (events ?? []).filter((e) => e.kind === 'text').map((e) => e.text ?? '').join('');
}

describe('useRun — 流结束时 flush 最后一批 text_delta', () => {
  beforeEach(() => {
    // 关键：把 requestAnimationFrame 设为 no-op，模拟 bug 条件——
    // 排队的 flushDeltas 回调永远不会被浏览器触发。这样唯一的 flush 途径就是 cleanup。
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('纯文本流：end 前的最后一批 delta 不丢失', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = url.toString();
      if (init?.method === 'POST' && u.endsWith('/api/runs')) {
        return new Response(JSON.stringify({ runId: 'r1', conversationId: 'c1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/api/runs/r1/events')) {
        return sseResponse([...textFrames('Hello', ' World'), { event: 'end', data: {} }]);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRun());
    await act(async () => {
      await result.current.sendMessage({ projectId: 'p1', agentId: 'omp', skillId: 's', stage: 'writing', message: 'hi' });
    });

    const last = result.current.messages[result.current.messages.length - 1];
    expect(last.role).toBe('assistant');
    // 旧代码：cleanup 不 flush → events 文本为空（修复前会失败）。
    // 新代码：cleanup flush → "Hello World" 完整。
    expect(assistantText(last.events)).toBe('Hello World');
  });

  it('工具调用后的尾部文本：随流结束一并 flush', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = url.toString();
      if (init?.method === 'POST' && u.endsWith('/api/runs')) {
        return new Response(JSON.stringify({ runId: 'r2', conversationId: 'c2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/api/runs/r2/events')) {
        return sseResponse([
          ...textFrames('工具前的文本'),
          { event: 'agent', data: { type: 'tool_use', id: 't1', name: 'Read', input: {} } },
          ...textFrames('工具后的尾文本'),
          { event: 'end', data: {} },
        ]);
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRun());
    await act(async () => {
      await result.current.sendMessage({ projectId: 'p1', agentId: 'omp', skillId: 's', stage: 'writing', message: 'hi' });
    });

    const last = result.current.messages[result.current.messages.length - 1];
    expect(last.role).toBe('assistant');
    // "工具前的文本" 由 tool_use 的「flush before other events」落盘（新旧代码皆有）；
    // "工具后的尾文本" 仅由 cleanup flush 落盘（新代码）。两者合起来必须完整。
    expect(assistantText(last.events)).toBe('工具前的文本工具后的尾文本');
  });
});

describe('useRun — mount 连 conversation 流追回历史 + 活跃 run', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('有历史但无活跃 run：一次性推完历史后流关闭，isRunning 保持 false', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = url.toString();
      if (u.includes('/conversations/conv1/stream')) {
        // 一次性排空：历史 messages + 无活跃 run → 直接关闭
        return sseResponse([
          { event: 'message', data: { id: 'm1', role: 'user', content: '写第一章' } },
          { event: 'message', data: { id: 'm2', role: 'assistant', content: '已完成的内容' } },
        ]);
      }
      return new Response('404', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRun('conv1'));
    // 等待 SSE 流消费完成
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].content).toBe('写第一章');
    expect(result.current.messages[1].content).toBe('已完成的内容');
    expect(result.current.isRunning).toBe(false);
  });

  it('有活跃 run：历史 messages + agent 事件实时跟随', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = url.toString();
      if (u.includes('/conversations/conv2/stream')) {
        // 历史 + 活跃 run 的 agent 事件 + end
        return sseResponse([
          { event: 'message', data: { id: 'm1', role: 'user', content: '继续写' } },
          ...textFrames('流式增量'),
          { event: 'end', data: {} },
        ]);
      }
      return new Response('404', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useRun('conv2'));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    // 历史 user 消息 + 流式 assistant 消息
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[0].role).toBe('user');
    // assistant 消息通过 agent 事件构建
    expect(result.current.messages[1].role).toBe('assistant');
    expect(result.current.messages[1].content).toBe('流式增量');
    expect(result.current.isRunning).toBe(false); // end 事件触发
  });
});
