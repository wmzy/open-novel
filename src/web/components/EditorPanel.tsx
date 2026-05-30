import { useState, useEffect, useRef, useCallback } from 'react';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

const wordCount = css`
  font-variant-numeric: tabular-nums;
`;

interface Props {
  projectId: string;
  chapterNum: number;
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function EditorPanel({ projectId, chapterNum }: Props) {
  const { data: chapter } = useQuery({
    queryKey: ['chapter-content', projectId, chapterNum],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters/${chapterNum}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.chapter;
    },
  });

  const [content, setContent] = useState('');
  const [charCount, setCharCount] = useState(0);
  const [saveStatusState, setSaveStatus] = useState<SaveStatus>('idle');
  const [showPreview, setShowPreview] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | null>(null);

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
            data-active={showPreview}
            onClick={() => setShowPreview(!showPreview)}
          >
            {showPreview ? 'Edit' : 'Preview'}
          </button>
        </div>
      </div>
      {showPreview ? (
        <div className={preview}>
          <Markdown remarkPlugins={[remarkGfm]}>{content || '*No content*'}</Markdown>
        </div>
      ) : (
        <textarea
          className={textarea}
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="开始写作... (Ctrl+S 保存)"
        />
      )}
    </div>
  );
}
