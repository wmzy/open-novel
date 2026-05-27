import { css } from '@linaria/core';

const stages = [
  { id: 'concept', label: '概念' },
  { id: 'world', label: '世界观' },
  { id: 'characters', label: '角色' },
  { id: 'outline', label: '大纲' },
  { id: 'scenes', label: '场景' },
  { id: 'writing', label: '写作' },
];

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
`;

interface Props {
  currentStage: string;
  onStageClick: (stage: string) => void;
}

export default function WorkflowProgress({ currentStage, onStageClick }: Props) {
  const currentIdx = stages.findIndex((s) => s.id === currentStage);
  return (
    <div>
      <div className={container}>
        {stages.map((s, i) => (
          <div key={s.id} className={`${step} ${i < currentIdx ? stepCompleted : i === currentIdx ? stepActive : ''}`} onClick={() => onStageClick(s.id)} style={{ cursor: 'pointer' }} />
        ))}
      </div>
      <div className={labels}>
        {stages.map((s) => <span key={s.id}>{s.label}</span>)}
      </div>
    </div>
  );
}
