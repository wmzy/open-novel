import { useState, useEffect } from 'react';
import { css } from '@linaria/core';

const container = css`
  display: flex;
  flex-direction: column;
  height: 100%;
`;

const header = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  border-bottom: 1px solid var(--haze-color-border);
  font-weight: 600;
`;

const list = css`
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem;
`;

const item = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  &:hover { background: var(--haze-color-bg-secondary); }
  margin-bottom: 0.25rem;
`;

const itemInfo = css`
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
`;

const itemHash = css`
  font-size: 0.75rem;
  font-family: var(--haze-font-mono);
  color: var(--haze-color-primary);
`;

const itemMessage = css`
  font-size: 0.875rem;
  color: var(--haze-color-text);
`;

const itemDate = css`
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
`;

const rollbackBtn = css`
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
  cursor: pointer;
  color: var(--haze-color-text-secondary);
  &:hover { background: var(--haze-color-error, #ef4444); color: white; border-color: var(--haze-color-error, #ef4444); }
`;

const emptyState = css`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--haze-color-text-secondary);
  font-size: 0.875rem;
`;

const milestoneItem = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  background: var(--haze-color-bg-secondary);
  border-left: 3px solid var(--haze-color-primary);
  margin-bottom: 0.25rem;
`;

const autoItem = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.75rem;
  border-radius: 6px;
  opacity: 0.7;
  &:hover { background: var(--haze-color-bg-secondary); opacity: 1; }
  margin-bottom: 0.125rem;
`;

const tagBadge = css`
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--haze-color-primary);
  background: var(--haze-color-bg);
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  margin-left: 0.4rem;
`;

const autoToggle = css`
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  padding: 0.4rem 0.75rem;
  width: 100%;
  text-align: left;
  &:hover { color: var(--haze-color-text); }
`;


interface Snapshot {
  hash: string;
  message: string;
  date: string;
  tags?: string[];
  isAuto?: boolean;
}

interface Props {
  projectId: string;
}

export default function SnapshotList({ projectId }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [showAuto, setShowAuto] = useState(false);

  const loadSnapshots = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/runs/projects/${projectId}/snapshots`);
      if (res.ok) {
        const data = await res.json();
        setSnapshots(data.snapshots || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    loadSnapshots();
  }, [projectId]);

  const handleRollback = async (hash: string) => {
    if (!confirm('Rollback to this snapshot? Current changes will be lost.')) return;

    setRollingBack(hash);
    try {
      const res = await fetch(`/api/runs/projects/${projectId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash: hash }),
      });
      if (res.ok) {
        alert('Rollback successful. Refresh the page to see changes.');
      } else {
        alert('Rollback failed.');
      }
    } catch {
      alert('Rollback failed.');
    }
    setRollingBack(null);
  };

  if (loading) return <div className={emptyState}>加载快照中...</div>;
  if (snapshots.length === 0) return <div className={emptyState}>暂无快照</div>;

  const milestones = snapshots.filter((s) => (s.tags || []).length > 0);
  const autoSnapshots = snapshots.filter((s) => (s.tags || []).length === 0);

  return (
    <div className={container}>
      <div className={header}>
        <span>快照</span>
        <button onClick={loadSnapshots} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--haze-color-primary)' }}>
          刷新
        </button>
      </div>
      <div className={list}>
        {milestones.map((s) => (
          <div key={s.hash} className={milestoneItem}>
            <div className={itemInfo}>
              <span className={itemHash}>{s.hash.slice(0, 8)}</span>
              <span className={itemMessage}>
                {(s.tags || []).join(', ').replace(/milestone-/g, '')}
              </span>
              <span className={itemDate}>{new Date(s.date).toLocaleString()}</span>
            </div>
            <button
              className={rollbackBtn}
              onClick={() => handleRollback(s.hash)}
              disabled={rollingBack === s.hash}
            >
              {rollingBack === s.hash ? '...' : '恢复'}
            </button>
          </div>
        ))}

        {autoSnapshots.length > 0 && (
          <>
            <button className={autoToggle} onClick={() => setShowAuto(!showAuto)}>
              {showAuto ? '▾' : '▸'} 自动快照 ({autoSnapshots.length})
            </button>
            {showAuto && autoSnapshots.map((s) => (
              <div key={s.hash} className={autoItem}>
                <div className={itemInfo}>
                  <span className={itemHash}>{s.hash.slice(0, 8)}</span>
                  <span className={itemMessage}>{s.message}</span>
                  <span className={itemDate}>{new Date(s.date).toLocaleString()}</span>
                </div>
                <button
                  className={rollbackBtn}
                  onClick={() => handleRollback(s.hash)}
                  disabled={rollingBack === s.hash}
                >
                  {rollingBack === s.hash ? '...' : '恢复'}
                </button>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
