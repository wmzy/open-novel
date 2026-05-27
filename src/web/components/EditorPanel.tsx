import { useState, useEffect, useRef } from 'react';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';

const editorContainer = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const editorToolbar = css`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem;
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
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

interface Props {
  projectId: string;
  chapterNum: number;
}

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
  const [wordCount, setWordCount] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (chapter?.content) setContent(chapter.content);
  }, [chapter]);

  useEffect(() => {
    // Count Chinese chars + English words
    const chinese = (content.match(/[一-鿿]/g) || []).length;
    const english = (content.match(/[a-zA-Z]+/g) || []).length;
    setWordCount(chinese + english);
  }, [content]);

  const handleChange = (value: string) => {
    setContent(value);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      fetch(`/api/projects/${projectId}/chapters/${chapterNum}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: value, wordCount }),
      });
    }, 1000);
  };

  return (
    <div className={editorContainer}>
      <div className={editorToolbar}>
        <span>第 {chapterNum} 章 {chapter?.title || ''}</span>
        <span>{wordCount} 字</span>
      </div>
      <textarea className={textarea} value={content} onChange={(e) => handleChange(e.target.value)} placeholder="开始写作..." />
    </div>
  );
}
