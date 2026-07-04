import { useState } from 'react';
import { css } from '@linaria/core';

interface Props {
  targetFile: string;
  diff: string;
  addedLines: number;
  removedLines: number;
}

const container = css`
  margin-top: 0.75rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow: hidden;
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--haze-color-bg-secondary, #f6f6f6);
  font-size: 0.8rem;
  cursor: pointer;
  user-select: none;
`;

const fileName = css`
  font-weight: 600;
  color: var(--haze-color-text);
`;

const stats = css`
  display: flex;
  gap: 0.75rem;
  font-size: 0.72rem;
`;

const added = css`
  color: #16a34a;
`;

const removed = css`
  color: #dc2626;
`;

const diffBody = css`
  max-height: 400px;
  overflow-y: auto;
  padding: 0.5rem 0.75rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
`;

const lineAdded = css`
  color: #16a34a;
  background: rgba(22, 163, 74, 0.08);
`;

const lineRemoved = css`
  color: #dc2626;
  background: rgba(220, 38, 38, 0.08);
`;

const lineContext = css`
  color: var(--haze-color-text-secondary, #888);
`;

const MAX_LINES_BEFORE_COLLAPSE = 200;
const VISIBLE_LINES_WHEN_COLLAPSED = 50;

/**
 * 修订差异面板：展示 unified diff，可折叠。
 * 折叠态：一行摘要「第3章.md · +12 -8」
 * 展开态：unified diff 渲染，+ 绿 - 红上下文灰
 */
export default function RevisionDiffPanel({ targetFile, diff, addedLines, removedLines }: Props) {
  const [expanded, setExpanded] = useState(false);

  const lines = diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  const shouldCollapse = lines.length > MAX_LINES_BEFORE_COLLAPSE;
  const visibleLines = shouldCollapse && !expanded
    ? lines.slice(0, VISIBLE_LINES_WHEN_COLLAPSED)
    : lines;

  return (
    <div className={container}>
      <div className={header} onClick={() => setExpanded(!expanded)}>
        <span className={fileName}>{targetFile}</span>
        <span className={stats}>
          <span className={added}>+{addedLines}</span>
          <span className={removed}>-{removedLines}</span>
        </span>
      </div>
      <div className={diffBody}>
        {visibleLines.map((line, i) => {
          let cls = lineContext;
          if (line.startsWith('+')) cls = lineAdded;
          else if (line.startsWith('-')) cls = lineRemoved;
          return (
            <div key={i} className={cls}>{line || ' '}</div>
          );
        })}
        {shouldCollapse && !expanded && (
          <div
            className={lineContext}
            style={{ cursor: 'pointer', padding: '0.5rem', textAlign: 'center' }}
            onClick={() => setExpanded(true)}
          >
            ▾ 展开全部（共 {lines.length} 行）
          </div>
        )}
      </div>
    </div>
  );
}
