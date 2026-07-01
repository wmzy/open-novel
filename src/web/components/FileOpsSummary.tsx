import { useState } from 'react';
import { css } from '@linaria/core';
import DiffView from './DiffView';
import type { DiffHunk } from '@/agent/artifacts';

const container = css`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 0.5rem;
`;

const badge = css`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 500;
  background: var(--haze-color-bg-secondary);
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  user-select: none;
  &:hover { background: var(--haze-color-border); }
`;

const chevron = css`
  display: inline-block;
  transition: transform 0.15s;
  &[data-expanded="true"] { transform: rotate(90deg); }
`;

const fileList = css`
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  padding-left: 0.5rem;
`;

const fileItem = css`
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  font-family: var(--haze-font-mono);
`;

const iconDone = css`
  color: var(--haze-color-success, #22c55e);
`;

const iconRunning = css`
  color: var(--haze-color-primary);
  animation: pulse 1s infinite;
  @keyframes pulse { 50% { opacity: 0.5; } }
`;

const iconError = css`
  color: var(--haze-color-error, #ef4444);
`;

interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  totalAdded: number;
  totalRemoved: number;
}

interface Props {
  count: number;
  paths: string[];
  diffs?: FileDiff[];
}

export default function FileOpsSummary({ count, paths, diffs }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (count === 0) return null;

  return (
    <div className={container}>
      <span className={badge} onClick={() => setExpanded(!expanded)}>
        <span className={chevron} data-expanded={expanded}>&#9654;</span>
        {count} file{count > 1 ? 's' : ''} modified
      </span>
      {expanded && (
        <div className={fileList}>
          {paths.map((p) => {
            const diff = diffs?.find((d) => d.path === p);
            return (
              <div key={p}>
                <span className={fileItem}>
                  <span className={iconDone}>&#10003;</span>
                  {p}
                </span>
                {diff && diff.hunks.length > 0 && (
                  <DiffView
                    filePath={diff.path}
                    hunks={diff.hunks}
                    totalAdded={diff.totalAdded}
                    totalRemoved={diff.totalRemoved}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
