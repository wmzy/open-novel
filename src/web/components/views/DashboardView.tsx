import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';

const grid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
`;

const statCard = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
`;

const statValue = css`
  font-size: 2rem;
  font-weight: 700;
  color: var(--haze-color-primary);
`;

const statLabel = css`
  font-size: 0.875rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.25rem;
`;

interface Props {
  projectId: string;
}

export default function DashboardView({ projectId }: Props) {
  const { data: project } = useQuery({ queryKey: ['project', projectId] });
  const { data: chapters } = useQuery({ queryKey: ['chapters', projectId] });

  const totalWords = chapters?.reduce((sum: number, ch: any) => sum + (ch.wordCount || 0), 0) || 0;
  const completedChapters = chapters?.filter((ch: any) => ch.status === 'completed').length || 0;

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
          <div className={statValue}>{completedChapters}</div>
          <div className={statLabel}>已完成</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{project?.currentStage || '-'}</div>
          <div className={statLabel}>当前阶段</div>
        </div>
      </div>
    </div>
  );
}
