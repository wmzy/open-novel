import { useState } from 'react';
import { css } from '@linaria/core';
import type { DiffHunk } from '@/agent/artifacts';

const container = css`
  font-family: var(--haze-font-mono);
  font-size: 0.75rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  overflow: hidden;
  margin: 0.5rem 0;
`;

const header = css`
  background: var(--haze-color-bg-secondary);
  padding: 0.25rem 0.5rem;
  font-size: 0.7rem;
  color: var(--haze-color-text-secondary);
  border-bottom: 1px solid var(--haze-color-border);
`;

const hunk = css`
  border-bottom: 1px solid var(--haze-color-border);
  &:last-child { border-bottom: none; }
`;

const diffLine = css`
  padding: 0.125rem 0.5rem;
  white-space: pre-wrap;
  word-break: break-all;
`;

const removeDiffLine = css`
  background: #fef2f2;
  color: #991b1b;
  &::before { content: '- '; opacity: 0.5; }
`;

const addDiffLine = css`
  background: #f0fdf4;
  color: #166534;
  &::before { content: '+ '; opacity: 0.5; }
`;

const toggle = css`
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--haze-color-primary);
  padding: 0.25rem 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.25rem;
`;

interface Props {
  filePath: string;
  hunks: DiffHunk[];
  totalAdded: number;
  totalRemoved: number;
}

export default function DiffView({ filePath, hunks, totalAdded, totalRemoved }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (hunks.length === 0) return null;

  return (
    <div className={container}>
      <button className={toggle} onClick={() => setExpanded(!expanded)}>
        {expanded ? '[-]' : '[+]'}
        <span style={{ color: 'var(--haze-color-success, #22c55e)' }}>+{totalAdded}</span>
        <span style={{ color: 'var(--haze-color-error, #ef4444)' }}>-{totalRemoved}</span>
        <span>{filePath}</span>
      </button>
      {expanded && (
        <>
          <div className={header}>@@ {hunks.length} hunk{hunks.length > 1 ? 's' : ''} @@</div>
          {hunks.map((h, i) => (
            <div key={i} className={hunk}>
              {h.removes.map((text, j) => (
                <div key={`r-${j}`} className={`${diffLine} ${removeDiffLine}`}>{text}</div>
              ))}
              {h.adds.map((text, j) => (
                <div key={`a-${j}`} className={`${diffLine} ${addDiffLine}`}>{text}</div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
