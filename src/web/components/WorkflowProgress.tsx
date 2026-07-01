import { css } from '@linaria/core';
import { STAGES, getStageIndex } from '@/shared/stages';

const container = css`
  display: flex;
  gap: 0.25rem;
  margin-bottom: 1rem;
`;

const step = css`
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--haze-color-border);
`;

const stepActive = css`
  background: var(--haze-color-primary);
`;

const stepCompleted = css`
  background: var(--haze-color-success);
`;

const labels = css`
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  gap: 0.25rem;
`;

interface Props {
  currentStage: string;
  onStageClick: (stage: string) => void;
}

export default function WorkflowProgress({ currentStage, onStageClick }: Props) {
  const currentIdx = getStageIndex(currentStage);
  return (
    <div data-testid="workflow-progress">
      <div className={container}>
        {STAGES.map((s, i) => (
          <div key={s.id} className={`${step} ${i < currentIdx ? stepCompleted : i === currentIdx ? stepActive : ''}`} onClick={() => onStageClick(s.viewId)} style={{ cursor: 'pointer' }} />
        ))}
      </div>
      <div className={labels}>
        {STAGES.map((s) => <span key={s.id}>{s.label}</span>)}
      </div>
    </div>
  );
}
