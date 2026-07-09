import { useState } from 'react';
import { css } from '@linaria/core';
import { EntityMarkdown } from './EntityMarkdown';
import { useEntityDict } from '@/web/hooks/useEntityDict';

const container = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow: hidden;
  height: 100%;
  display: flex;
  flex-direction: column;
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--haze-color-bg-secondary);
  border-bottom: 1px solid var(--haze-color-border);
  font-size: 0.8rem;
  font-family: var(--haze-font-mono);
  color: var(--haze-color-text-secondary);
`;

const rawContent = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  font-family: var(--haze-font-mono);
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--haze-color-text);
`;

const toggleBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.125rem 0.5rem;
  font-size: 0.7rem;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  &:hover { background: var(--haze-color-border); }
`;

const emptyState = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--haze-color-text-secondary);
  font-size: 0.875rem;
`;

interface Props {
  projectId: string;
  filePath: string | null;
  content: string | null;
  loading?: boolean;
}

export default function FilePreview({ projectId, filePath, content, loading }: Props) {
  const [raw, setRaw] = useState(false);
  const { dict } = useEntityDict(projectId);

  if (!filePath) {
    return (
      <div className={container}>
        <div className={emptyState}>选择文件以预览</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={container}>
        <div className={header}>{filePath}</div>
        <div className={emptyState}>加载中...</div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className={container}>
        <div className={header}>{filePath}</div>
        <div className={emptyState}>文件未找到</div>
      </div>
    );
  }

  const isMarkdown = filePath.endsWith('.md');

  return (
    <div className={container}>
      <div className={header}>
        <span>{filePath}</span>
        {isMarkdown && (
          <button className={toggleBtn} onClick={() => setRaw(!raw)}>
            {raw ? '预览' : '源码'}
          </button>
        )}
      </div>
      {isMarkdown && !raw ? (
        <div className={content}>
          <EntityMarkdown content={content} dict={dict} projectId={projectId} />
        </div>
      ) : (
        <div className={rawContent}>{content}</div>
      )}
    </div>
  );
}
