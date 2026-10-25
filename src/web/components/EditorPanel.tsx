import { useState, useEffect, useRef, useCallback } from 'react';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';
import RewritePanel from './RewritePanel';
import { useEntityDict } from '@/web/hooks/useEntityDict';
import { EntityMarkdown } from './EntityMarkdown';
import { useInlineEdit } from '@/web/hooks/useInlineEdit';
import { useModels, useModelSelection } from '@/web/hooks/useModels';
import {
  applyParagraphMerge,
  splitParagraphs,
  INLINE_ACTION_LABELS,
  type InlineAction,
  type ParagraphMergePlan,
} from '@/shared/inline-edit';

const editorContainer = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const editorToolbar = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
`;

const toolbarLeft = css`
  display: flex;
  align-items: center;
  gap: 1rem;
`;

const toolbarRight = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
`;

const saveStatus = css`
  font-size: 0.7rem;
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
`;

const saveStatusSaving = css`
  background: var(--haze-color-warning, #f59e0b);
  color: white;
`;

const saveStatusSaved = css`
  background: var(--haze-color-success, #22c55e);
  color: white;
`;

const saveStatusError = css`
  background: var(--haze-color-error, #ef4444);
  color: white;
`;

const toggleBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.7rem;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  &:hover { background: var(--haze-color-bg-secondary); }
  &[data-active="true"] { background: var(--haze-color-primary); color: white; border-color: var(--haze-color-primary); }
`;

const textarea = css`
  flex: 1;
  border: none;
  padding: 1rem;
  resize: none;
  font-family: var(--haze-font-mono);
  font-size: 0.9rem;
  line-height: 1.6;
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  &:focus { outline: none; }
`;

const preview = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  font-size: 0.9rem;
  line-height: 1.8;
`;

/* ---- 内联 AI 工具条（润色/扩写/续写）---- */

const inlineBar = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.75rem;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.7rem;
  color: var(--haze-color-text-secondary);
  flex-wrap: wrap;
`;

const inlineBtn = css`
  background: none;
  border: 1px solid var(--haze-color-primary);
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.7rem;
  cursor: pointer;
  color: var(--haze-color-primary);
  &:hover { background: var(--haze-color-primary); color: white; }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const inlineApplyBtn = css`
  background: var(--haze-color-success, #22c55e);
  border: 1px solid var(--haze-color-success, #22c55e);
  border-radius: 4px;
  padding: 0.125rem 0.75rem;
  font-size: 0.7rem;
  cursor: pointer;
  color: white;
`;

const inlineHint = css`
  font-size: 0.68rem;
  opacity: 0.75;
`;

const inlineError = css`
  font-size: 0.68rem;
  color: var(--haze-color-error, #ef4444);
  cursor: pointer;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const inlineSelect = css`
  margin-left: auto;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  font-size: 0.68rem;
  padding: 0.125rem 0.25rem;
  color: var(--haze-color-text);
`;

const inlinePreview = css`
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem 1rem;
  font-size: 0.85rem;
  line-height: 1.8;
`;

const inlineReplaceGroup = css`
  margin-bottom: 0.75rem;
  border-left: 2px solid var(--haze-color-border);
  padding-left: 0.5rem;
`;

const inlineParaFrom = css`
  color: var(--haze-color-text-secondary);
  text-decoration: line-through;
  text-decoration-color: var(--haze-color-error, #ef4444);
  margin-bottom: 0.25rem;
`;

const inlineParaTo = css`
  color: var(--haze-color-text);
  border-left: 2px solid var(--haze-color-success, #22c55e);
  padding-left: 0.5rem;
  margin-bottom: 0.25rem;
`;

const wordCount = css`
  font-variant-numeric: tabular-nums;
`;

interface Props {
  projectId: string;
  chapterNum: number;
  agentId?: string;
  skillId?: string;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type EditorMode = 'edit' | 'preview' | 'rewrite';

export default function EditorPanel({ projectId, chapterNum, agentId = 'pi', skillId = 'novel' }: Props) {
  const { data: chapter } = useQuery({
    queryKey: ['chapter-content', projectId, chapterNum],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterNum}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.chapter;
    },
  });
  const { dict } = useEntityDict(projectId);

  const [content, setContent] = useState('');
  const [charCount, setCharCount] = useState(0);
  const [saveStatusState, setSaveStatus] = useState<SaveStatus>('idle');
  const [mode, setMode] = useState<EditorMode>('edit');
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  // ---- 内联 AI（润色/扩写/续写）----
  const inlineMut = useInlineEdit(projectId);
  const { data: modelsData } = useModels(agentId);
  const availableModels = modelsData ?? [];
  // 模型选择与 ChatPanel 共用同一 localStorage 值（跨面板记住上次选择）
  const [selectedModel, setSelectedModel] = useModelSelection(availableModels.map((m) => m.id));
  const [cursor, setCursor] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  // 结果不直接覆盖：先暂存 plan 供 diff 预览，用户「应用」才写入 textarea
  const [pendingInline, setPendingInline] = useState<{
    action: InlineAction;
    start: number;
    end: number;
    selection: string;
    plan: ParagraphMergePlan;
  } | null>(null);

  const hasSelection = cursor.start < cursor.end;
  // 光标「文末附近」：折叠选区且落在末段有效字符之后（容忍尾部空白/换行）
  const nearEnd = !hasSelection && cursor.end >= content.trimEnd().length;

  useEffect(() => {
    if (chapter?.content) setContent(chapter.content);
  }, [chapter]);

  useEffect(() => {
    const chinese = (content.match(/[一-鿿]/g) || []).length;
    const english = (content.match(/[a-zA-Z]+/g) || []).length;
    setCharCount(chinese + english);
  }, [content]);

  const saveContent = useCallback(async (value: string, count: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSaveStatus('saving');
    try {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterNum}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value, wordCount: count }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err: unknown) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        setSaveStatus('error');
      }
    }
  }, [projectId, chapterNum]);

  const handleChange = (value: string) => {
    setContent(value);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const chinese = (value.match(/[一-鿿]/g) || []).length;
      const english = (value.match(/[a-zA-Z]+/g) || []).length;
      saveContent(value, chinese + english);
    }, 1000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      clearTimeout(saveTimer.current);
      saveContent(content, charCount);
    }
  };

  /** 触发内联 AI：捕获触发时刻的选区/光标，与结果一起暂存用于回填。 */
  const runInline = (action: InlineAction) => {
    if (inlineMut.isPending) return;
    const start = cursor.start;
    const end = cursor.end;
    const selection = content.slice(start, end);
    if (action !== 'continue' && !selection.trim()) return;
    inlineMut.mutate(
      {
        chapter: chapterNum,
        action,
        selection,
        selectionStart: start,
        model: selectedModel !== 'default' ? selectedModel : undefined,
      },
      { onSuccess: (data) => setPendingInline({ action, start, end, selection, plan: data.plan }) },
    );
  };

  /** 应用预览结果：按 plan 合并进正文，走既有 handleChange（防抖保存） */
  const applyInline = () => {
    if (!pendingInline) return;
    const { action, start, end, selection, plan } = pendingInline;
    let next: string;
    let caret: number;
    if (action === 'continue') {
      // 追加在光标处（通常是文末）：补空行分隔，避免与末段粘连
      const merged = applyParagraphMerge([], plan);
      const head = content.slice(0, end);
      const sep = head.trim() === '' ? '' : head.endsWith('\n') ? (head.endsWith('\n\n') ? '' : '\n') : '\n\n';
      next = head + sep + merged + content.slice(end);
      caret = (head + sep + merged).length;
    } else {
      const merged = applyParagraphMerge(splitParagraphs(selection), plan);
      next = content.slice(0, start) + merged + content.slice(end);
      caret = start + merged.length;
    }
    setPendingInline(null);
    setCursor({ start: caret, end: caret });
    handleChange(next);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimeout(saveTimer.current);
      abortRef.current?.abort();
    };
  }, []);

  const statusLabel = {
    idle: null,
    saving: 'Saving...',
    saved: 'Saved',
    error: 'Error',
  };

  return (
    <div className={editorContainer} onKeyDown={handleKeyDown}>
      <div className={editorToolbar}>
        <div className={toolbarLeft}>
          <span>第 {chapterNum} 章 {chapter?.title || ''}</span>
          {saveStatusState !== 'idle' && (
            <span className={`${saveStatus} ${
              saveStatusState === 'saving' ? saveStatusSaving :
              saveStatusState === 'saved' ? saveStatusSaved :
              saveStatusError
            }`}>
              {statusLabel[saveStatusState]}
            </span>
          )}
        </div>
        <div className={toolbarRight}>
          <span className={wordCount}>{charCount} 字</span>
          <button
            className={toggleBtn}
            data-active={mode === 'edit'}
            onClick={() => setMode('edit')}
          >
            编辑
          </button>
          <button
            className={toggleBtn}
            data-active={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            预览
          </button>
          <button
            className={toggleBtn}
            data-active={mode === 'rewrite'}
            onClick={() => setMode('rewrite')}
          >
            局部重写
          </button>
        </div>
      </div>
      {mode === 'preview' ? (
        <div className={preview}>
          <EntityMarkdown content={content} dict={dict} projectId={projectId} />
        </div>
      ) : mode === 'rewrite' ? (
        <RewritePanel projectId={projectId} chapterNum={chapterNum} agentId={agentId} skillId={skillId} />
      ) : (
        <>
          <div className={inlineBar}>
            {pendingInline ? (
              <>
                <span>{INLINE_ACTION_LABELS[pendingInline.action]}结果预览 —— 确认后写入正文</span>
                <button className={inlineApplyBtn} onClick={applyInline}>应用</button>
                <button className={toggleBtn} onClick={() => setPendingInline(null)}>放弃</button>
              </>
            ) : (
              <>
                {hasSelection && (
                  <>
                    <button className={inlineBtn} disabled={inlineMut.isPending} onClick={() => runInline('polish')}>润色</button>
                    <button className={inlineBtn} disabled={inlineMut.isPending} onClick={() => runInline('expand')}>扩写</button>
                  </>
                )}
                {nearEnd && (
                  <button className={inlineBtn} disabled={inlineMut.isPending} onClick={() => runInline('continue')}>续写</button>
                )}
                {!hasSelection && !nearEnd && (
                  <span className={inlineHint}>选中文本可润色/扩写；光标移到文末可续写</span>
                )}
                {inlineMut.isPending && <span className={inlineHint}>AI 处理中…</span>}
                {inlineMut.isError && (
                  <span
                    className={inlineError}
                    title={`${(inlineMut.error as Error).message}（点击清除）`}
                    onClick={() => inlineMut.reset()}
                  >
                    {(inlineMut.error as Error).message}
                  </span>
                )}
                <select
                  className={inlineSelect}
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={inlineMut.isPending}
                  title={selectedModel === 'default' ? '默认模型：使用设置中的全局模型' : '选择模型'}
                >
                  <option value="default">默认（全局模型）</option>
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </>
            )}
          </div>
          {pendingInline ? (
            <div className={inlinePreview} data-testid="inline-preview">
              {pendingInline.plan.whole ? (
                <>
                  <div className={inlineParaFrom}>{pendingInline.plan.whole.from}</div>
                  <div className={inlineParaTo}>{pendingInline.plan.whole.to}</div>
                </>
              ) : (
                <>
                  {pendingInline.plan.replaced.map((r) => (
                    <div key={`r-${r.index}`} className={inlineReplaceGroup}>
                      <div className={inlineParaFrom}>{r.from}</div>
                      <div className={inlineParaTo}>{r.to}</div>
                    </div>
                  ))}
                  {pendingInline.plan.appended.map((p, i) => (
                    <div key={`a-${i}`} className={inlineParaTo}>{p}</div>
                  ))}
                  {!pendingInline.plan.replaced.length && !pendingInline.plan.appended.length && (
                    <div className={inlineHint}>AI 返回内容与原文一致，无改动</div>
                  )}
                </>
              )}
            </div>
          ) : (
            <textarea
              className={textarea}
              value={content}
              onChange={(e) => handleChange(e.target.value)}
              onSelect={(e) => setCursor({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
              placeholder="开始写作... (Ctrl+S 保存)"
            />
          )}
        </>
      )}
    </div>
  );
}
