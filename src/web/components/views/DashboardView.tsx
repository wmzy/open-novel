import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { STAGES } from '@/shared/stages';

const grid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
`;

const statCard = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 1.25rem;
  text-align: center;
`;

const statValue = css`
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--haze-color-primary);
`;

const statLabel = css`
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.25rem;
`;

const section = css`
  margin-bottom: 2rem;
`;

const sectionTitle = css`
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 1rem;
  color: var(--haze-color-text);
`;

const progressBar = css`
  height: 8px;
  background: var(--haze-color-border);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
`;

const progressFill = css`
  height: 100%;
  background: var(--haze-color-primary);
  border-radius: 4px;
  transition: width 0.3s;
`;

const progressLabel = css`
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
`;

const recentList = css`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const recentItem = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-size: 0.8rem;
`;

const recentDot = css`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
`;

const snapshotList = css`
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
`;

const snapshotItem = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 0.5rem;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  font-family: var(--haze-font-mono);
`;

interface Props {
  projectId: string;
}

export default function DashboardView({ projectId }: Props) {
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}`);
      const data = await res.json();
      return data.project;
    },
  });

  const { data: chapters } = useQuery({
    queryKey: ['chapters', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters`);
      const data = await res.json();
      return data.chapters;
    },
  });

  const { data: snapshots } = useQuery({
    queryKey: ['snapshots', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/projects/${projectId}/snapshots`);
      const data = await res.json();
      return data.snapshots || [];
    },
  });

  const totalWords = chapters?.reduce((sum: number, ch: { wordCount?: number }) => sum + (ch.wordCount || 0), 0) || 0;
  const targetWords = project?.targetWords || 100000;
  const progress = Math.min(100, Math.round((totalWords / targetWords) * 100));
  const currentStageIdx = STAGES.findIndex((s) => s.id === project?.currentStage);
  const stageLabel = currentStageIdx >= 0 ? STAGES[currentStageIdx].label : project?.currentStage || '-';

  return (
    <div>
      <h3>总览</h3>

      <div className={grid}>
        <div className={statCard}>
          <div className={statValue}>{totalWords.toLocaleString()}</div>
          <div className={statLabel}>总字数</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{chapters?.length || 0}</div>
          <div className={statLabel}>总章数</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{stageLabel}</div>
          <div className={statLabel}>当前阶段</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{progress}%</div>
          <div className={statLabel}>完成度</div>
        </div>
      </div>

      <div className={section}>
        <div className={sectionTitle}>写作进度</div>
        <div className={progressBar}>
          <div className={progressFill} style={{ width: `${progress}%` }} />
        </div>
        <div className={progressLabel}>
          <span>{totalWords.toLocaleString()} 字</span>
          <span>目标: {targetWords.toLocaleString()} 字</span>
        </div>
      </div>

      {chapters && chapters.length > 0 && (
        <div className={section}>
          <div className={sectionTitle}>章节概览</div>
          <div className={recentList}>
            {chapters.slice(0, 5).map((ch: { number: number; title?: string; wordCount?: number }) => (
              <div key={ch.number} className={recentItem}>
                <span className={recentDot} style={{ background: (ch.wordCount ?? 0) > 0 ? 'var(--haze-color-success)' : 'var(--haze-color-border)' }} />
                <span>第 {ch.number} 章 {ch.title || ''}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--haze-color-text-secondary)', fontSize: '0.75rem' }}>
                  {ch.wordCount || 0} 字
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {snapshots && snapshots.length > 0 && (
        <div className={section}>
          <div className={sectionTitle}>最近快照</div>
          <div className={snapshotList}>
            {(snapshots as Array<{ hash: string; message: string; date: string; tags?: string[]; isAuto?: boolean }>)
              .slice()
              .sort((a, b) => {
                const aM = (a.tags || []).length > 0 ? 1 : 0;
                const bM = (b.tags || []).length > 0 ? 1 : 0;
                return bM - aM;
              })
              .slice(0, 5)
              .map((s) => (
                <div key={s.hash} className={snapshotItem} style={
                  (s.tags || []).length > 0
                    ? { background: 'var(--haze-color-bg-secondary)', borderLeft: '3px solid var(--haze-color-primary)' }
                    : undefined
                }>
                  <span style={{ color: 'var(--haze-color-primary)' }}>{s.hash.slice(0, 8)}</span>
                  <span>
                    {(s.tags || []).length > 0
                      ? `🏷 ${s.tags!.join(', ').replace(/milestone-/g, '')}`
                      : s.message}
                  </span>
                  <span style={{ marginLeft: 'auto' }}>{new Date(s.date).toLocaleDateString()}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
