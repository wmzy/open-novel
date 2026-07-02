import { useState, useCallback, useRef } from 'react';
import { consumeSseStream } from './sse-stream';

export interface RewriteState {
  /** 当前流式累加的重写结果文本 */
  result: string;
  isRunning: boolean;
  /** 运行状态文案（starting / 重连中等） */
  status: string;
  /** 错误信息，运行失败时填充 */
  error: string | null;
  /** 当前 runId，便于取消 */
  runId: string | null;
}

export interface RewriteParams {
  projectId: string;
  chapterNum: number;
  selectedText: string;
  instruction: string;
  agentId: string;
  skillId?: string;
  model?: string;
}

/**
 * 章节局部重写 hook。
 *
 * 复用 useRun 的 SSE 机制（consumeSseStream + /api/runs/:id/events），
 * 但只关心 text_delta 的累加结果——重写只需拿到重写后的文本段落，
 * 不需要消息列表、对话持久化等 ChatPanel 语义。
 */
export function useRewrite() {
  const [result, setResult] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef('');

  const startRewrite = useCallback(async (params: RewriteParams) => {
    // 重置上一次结果
    resultRef.current = '';
    setResult('');
    setError(null);
    setRunId(null);
    setIsRunning(true);
    setStatus('starting');

    try {
      const res = await fetch(`/api/projects/${params.projectId}/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chapterNum: params.chapterNum,
          selectedText: params.selectedText,
          instruction: params.instruction,
          agentId: params.agentId,
          skillId: params.skillId,
          model: params.model,
        }),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        let msg = '重写请求失败';
        try { msg = JSON.parse(errBody).error || msg; } catch { /* 保留默认 */ }
        setError(msg);
        setIsRunning(false);
        setStatus('');
        return;
      }

      const { runId: rid } = await res.json();
      setRunId(rid);

      const controller = new AbortController();
      abortRef.current = controller;

      const sseRes = await fetch(`/api/runs/${rid}/events`, { signal: controller.signal });
      if (!sseRes.ok || !sseRes.body) {
        setError('无法连接到重写事件流');
        setIsRunning(false);
        setStatus('');
        return;
      }

      const reader = sseRes.body.getReader();
      try {
        for await (const frame of consumeSseStream(reader, controller.signal)) {
          const data = frame.data as Record<string, unknown>;
          switch (frame.event) {
            case 'agent': {
              const type = data.type as string;
              // 累加文本增量，得到重写后的段落
              if (type === 'text_delta') {
                const delta = String(data.delta || '');
                resultRef.current += delta;
                setResult(resultRef.current);
              } else if (type === 'status') {
                setStatus(String(data.label || ''));
              } else if (type === 'error') {
                setError(String(data.message || '重写出错'));
              }
              break;
            }
            case 'end':
              setIsRunning(false);
              setStatus('');
              return;
            default:
              break;
          }
        }
        // 流自然结束但未收到 end 事件
        setIsRunning(false);
        setStatus('');
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (abortRef.current?.signal.aborted) {
        // 用户主动取消，非错误
        setIsRunning(false);
        setStatus('');
        return;
      }
      setError(err instanceof Error ? err.message : '重写失败');
      setIsRunning(false);
      setStatus('');
    }
  }, []);

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    if (runId) {
      try { await fetch(`/api/runs/${runId}`, { method: 'DELETE' }); } catch { /* ignore */ }
    }
    setIsRunning(false);
    setStatus('');
  }, [runId]);

  const reset = useCallback(() => {
    resultRef.current = '';
    setResult('');
    setError(null);
    setStatus('');
    setRunId(null);
  }, []);

  return { result, isRunning, status, error, runId, startRewrite, cancel, reset };
}
