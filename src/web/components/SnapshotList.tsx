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

interface Snapshot {
  hash: string;
  message: string;
  date: string;
}

interface Props {
  projectId: string;
}

export default function SnapshotList({ projectId }: Props) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);

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

  return (
    <div className={container}>
      <div className={header}>
        <span>Snapshots</span>
        <button onClick={loadSnapshots} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--haze-color-primary)' }}>
          Refresh
        </button>
      </div>
      <div className={list}>
        {snapshots.map((s) => (
          <div key={s.hash} className={item}>
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
              {rollingBack === s.hash ? '...' : 'Rollback'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
