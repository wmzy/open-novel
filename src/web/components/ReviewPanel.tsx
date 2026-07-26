import { useState } from 'react';
import { css } from '@linaria/core';
import RevisionDiffPanel from './RevisionDiffPanel';
import type { ReviewResult } from '../hooks/useReview';

interface Props {
  review: ReviewResult | undefined;
  onMerge: () => void;
  onDiscard: () => void;
  merging: boolean;
  discarding: boolean;
  onClose: () => void;
}

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
`;

const panel = css`
  background: var(--haze-color-bg, #fff);
  border-radius: 8px;
  width: 80vw;
  max-width: 900px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
`;

const headerBar = css`
  padding: 1rem;
  border-bottom: 1px solid var(--haze-color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const title = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const summary = css`
  color: var(--haze-color-text-secondary, #888);
  font-size: 0.85rem;
`;

const body = css`
  padding: 1rem;
  overflow-y: auto;
  flex: 1;
`;

const fileRow = css`
  padding: 0.5rem;
  cursor: pointer;
  border-bottom: 1px solid var(--haze-color-border);
  display: flex;
  justify-content: space-between;
  &:hover {
    background: var(--haze-color-bg-hover);
  }
`;

const fileName = css`
  display: flex;
  align-items: center;
`;

const statusBadge = css`
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  margin-right: 0.5rem;
  background: var(--haze-color-bg-secondary);
`;

const statsGap = css`
  display: inline-flex;
  gap: 0.25rem;
`;

const addedCount = css`
  color: var(--haze-color-success, #16a34a);
`;

const removedCount = css`
  color: var(--haze-color-error, #dc2626);
`;

const footer = css`
  padding: 1rem;
  border-top: 1px solid var(--haze-color-border);
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  align-items: center;
`;

const mergeBtn = css`
  background: var(--haze-color-success, #16a34a);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const discardBtn = css`
  background: var(--haze-color-error, #dc2626);
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const ghostBtn = css`
  background: transparent;
  border: 1px solid var(--haze-color-border);
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--haze-color-text);
`;

const closeBtn = css`
  background: transparent;
  border: 1px solid var(--haze-color-border);
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--haze-color-text);
`;

const confirmText = css`
  margin-right: auto;
  font-size: 0.85rem;
  color: var(--haze-color-text-secondary, #888);
`;

const statusLabel = (s: string): string =>
  ({ added: '新增', modified: '修改', deleted: '删除' } as Record<string, string>)[s] || s;

/**
 * 审阅面板：列出 draft 相对 main 的待审阅改动，复用 RevisionDiffPanel 展示逐文件 diff。
 * 合并 = ff main 到 draft；丢弃 = reset draft 到 main（需二次确认）。
 */
export default function ReviewPanel({ review, onMerge, onDiscard, merging, discarding, onClose }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const empty = !review || review.commits.length === 0;

  return (
    <div className={overlay} onClick={onClose}>
      <div className={panel} onClick={(e) => e.stopPropagation()}>
        <div className={headerBar}>
          <div className={title}>
            <strong>审阅待合并</strong>
            {!empty && (
              <span className={summary}>
                {review!.commits.length} 个提交 · {review!.files.length} 个文件 · +{review!.totalAdded} -{review!.totalRemoved}
              </span>
            )}
          </div>
          <button className={closeBtn} onClick={onClose}>✕</button>
        </div>
        <div className={body}>
          {empty ? (
            <div>无待审阅</div>
          ) : (
            review!.files.map((f) => (
              <div key={f.path}>
                <div className={fileRow} onClick={() => setExpanded(expanded === f.path ? null : f.path)}>
                  <span className={fileName}>
                    <span className={statusBadge}>{statusLabel(f.status)}</span>
                    {f.path}
                  </span>
                  <span className={statsGap}>
                    <span className={addedCount}>+{f.addedLines}</span>
                    <span className={removedCount}>-{f.removedLines}</span>
                  </span>
                </div>
                {expanded === f.path && (
                  <RevisionDiffPanel
                    targetFile={f.path}
                    diff={f.diff}
                    addedLines={f.addedLines}
                    removedLines={f.removedLines}
                  />
                )}
              </div>
            ))
          )}
        </div>
        {!empty && (
          <div className={footer}>
            {confirmDiscard ? (
              <>
                <span className={confirmText}>将丢弃所有未审阅改动（含未提交手改），确认？</span>
                <button className={discardBtn} onClick={() => { onDiscard(); setConfirmDiscard(false); }} disabled={discarding}>
                  {discarding ? '丢弃中...' : '确认丢弃'}
                </button>
                <button className={ghostBtn} onClick={() => setConfirmDiscard(false)}>取消</button>
              </>
            ) : (
              <>
                <button className={discardBtn} onClick={() => setConfirmDiscard(true)} disabled={discarding || merging}>丢弃</button>
                <button className={mergeBtn} onClick={onMerge} disabled={merging || discarding}>
                  {merging ? '合并中...' : '合并'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
