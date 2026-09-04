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

/** 重写 runId 的会话级持久化键：刷新页面/切换视图后追回进行中或已完成的重写结果。
 * run 事件已落盘（run_events），重连走 GET /runs/:id/events 重放。 */
function rewriteRunKey(projectId: string, chapterNum: number): string {
  return `rewrite-run:${projectId}:${chapterNum}`;
}

/**
 * 章节局部重写 hook。
 *
 * 复用 useRun 的 SSE 机制（consumeSseStream + /api/runs/:id/events），
 * 但只关心 text_delta 的累加结果——重写只需拿到重写后的文本段落，
 * 不需要消息列表、对话持久化等 ChatPanel 语义。
 *
 * 刷新恢复：runId 写入 sessionStorage；挂载时 resumeRewrite 重放事件流，
 * 修复「重写进行中/完成后刷新页面或切换视图，结果永远追不回」的旧缺陷。
 */
export function useRewrite() {
  const [result, setResult] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef('');
  const resumeStartedRef = useRef(false);
  /** 当前重写对应的 sessionStorage 键（取消/接受/拒绝时清除）。 */
  const storageKeyRef = useRef<string | null>(null);

  /** 消费 run 事件流：累加 text_delta 到 result，遇 end 或流结束返回。 */
  const consumeRunEvents = useCallback(async (rid: string, controller: AbortController) => {
    const sseRes = await fetch(`/api/runs/${rid}/events`, { signal: controller.signal });
    if (!sseRes.ok || !sseRes.body) {
      throw new Error('无法连接到重写事件流');
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
  }, []);

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
      const key = rewriteRunKey(params.projectId, params.chapterNum);
      storageKeyRef.current = key;
      sessionStorage.setItem(key, rid);

      const controller = new AbortController();
      abortRef.current = controller;
      await consumeRunEvents(rid, controller);
      // 完成/失败均保留 sessionStorage 记录：刷新后仍可重放恢复结果文本
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
  }, [consumeRunEvents]);

  /** 挂载时恢复：sessionStorage 有 runId 则重放事件流（进行中=重连，已完成=还原结果）。 */
  const resumeRewrite = useCallback(async (projectId: string, chapterNum: number) => {
    if (resumeStartedRef.current) return;
    const key = rewriteRunKey(projectId, chapterNum);
    const rid = sessionStorage.getItem(key);
    if (!rid) return;
    resumeStartedRef.current = true;
    storageKeyRef.current = key;
    try {
      const stRes = await fetch(`/api/runs/${rid}/status`);
      if (!stRes.ok) {
        sessionStorage.removeItem(key);
        return;
      }
      const st = (await stRes.json()) as { status?: string };
      if (!st.status) {
        sessionStorage.removeItem(key);
        return;
      }
      resultRef.current = '';
      setResult('');
      setError(null);
      setRunId(rid);
      setIsRunning(true);
      setStatus(st.status === 'running' ? '恢复上次重写…' : '载入上次重写结果…');
      const controller = new AbortController();
      abortRef.current = controller;
      await consumeRunEvents(rid, controller);
    } catch {
      setError('恢复上次重写失败');
      setIsRunning(false);
      setStatus('');
    } finally {
      resumeStartedRef.current = false;
    }
  }, [consumeRunEvents]);

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    if (runId) {
      try { await fetch(`/api/runs/${runId}`, { method: 'DELETE' }); } catch { /* ignore */ }
    }
    // 取消不保留：刷新后不再恢复被放弃的重写
    if (storageKeyRef.current) {
      sessionStorage.removeItem(storageKeyRef.current);
      storageKeyRef.current = null;
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
    resumeStartedRef.current = false;
    // 接受/拒绝后清除恢复记录：该次重写已了结
    if (storageKeyRef.current) {
      sessionStorage.removeItem(storageKeyRef.current);
      storageKeyRef.current = null;
    }
  }, []);

  return { result, isRunning, status, error, runId, startRewrite, resumeRewrite, cancel, reset };
}
