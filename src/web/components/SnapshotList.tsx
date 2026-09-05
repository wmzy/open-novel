import { useState, useEffect } from 'react';
import { toast } from 'sonner';
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

const refreshBtn = css`
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--haze-color-primary);
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
      // limit=200：早期里程碑也可达（默认 20 会把旧版本挡在 UI 之外）
      const res = await fetch(`/api/runs/projects/${projectId}/snapshots?limit=200`);
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
    if (!confirm(
      '回滚到此快照？\n\n' +
      '该快照之后产生的所有文件（含后续章节、设定）将被删除。\n' +
      '回滚前会自动保存当前状态，可从快照列表找回。',
    )) return;

    // 定稿镜像（main）跟随回退：否则顶部审阅面板出现「反向差异」，
    // 逐文件接受会把刚回滚掉的内容重新写回
    const resetMain = confirm(
      '是否同时回退「定稿镜像」（main 分支）？\n\n' +
      '确定 = 镜像一并回到快照（推荐，审阅面板不再出现反向差异）\n' +
      '取消 = 仅回退工作草稿（审阅面板会显示镜像与草稿的差异）',
    );

    setRollingBack(hash);
    try {
      const res = await fetch(`/api/runs/projects/${projectId}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash: hash, resetMain }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        const mainNote = data.mainReset ? '（含定稿镜像）' : (data.mainResetRequested ? '（镜像回退未生效，审阅面板可能显示差异）' : '');
        // 回滚只改文件不改对话：旧会话历史仍引用已回滚的内容，继续对话会让 agent 困惑
        toast.success(`已回滚到所选快照${mainNote}。建议用「新对话」（/new）继续创作，旧对话上下文引用的是回滚前内容。正在刷新...`);
        // 回滚后后端已按磁盘重建 chapters 表，整页刷新让所有视图一致
        window.location.reload();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error((data as { error?: string }).error || '回滚失败');
        setRollingBack(null);
      }
    } catch {
      toast.error('回滚失败');
      setRollingBack(null);
    }
  };

  if (loading) return <div className={emptyState}>加载快照中...</div>;
  if (snapshots.length === 0) return <div className={emptyState}>暂无快照</div>;

  const milestones = snapshots.filter((s) => (s.tags || []).length > 0);
  const autoSnapshots = snapshots.filter((s) => (s.tags || []).length === 0);

  return (
    <div className={container}>
      <div className={header}>
        <span>快照</span>
        <button onClick={loadSnapshots} className={refreshBtn}>
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
