import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { css } from '@linaria/core';
import { useQuery } from '@tanstack/react-query';
import Sidebar from '@/web/components/Sidebar';
import WorkflowProgress from '@/web/components/WorkflowProgress';

const layout = css`
  display: flex;
  height: 100vh;
`;

const main = css`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const topBar = css`
  padding: 1rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

const content = css`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
`;

const chatPanel = css`
  width: 400px;
  border-left: 1px solid var(--haze-color-border);
  display: flex;
  flex-direction: column;
`;

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [activeView, setActiveView] = useState('dashboard');

  const { data: project } = useQuery({
    queryKey: ['project', id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${id}`);
      const data = await res.json();
      return data.project;
    },
  });

  const { data: chapters } = useQuery({
    queryKey: ['chapters', id],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${id}/chapters`);
      const data = await res.json();
      return data.chapters;
    },
  });

  if (!project) return <div>Loading...</div>;

  return (
    <div className={layout}>
      <Sidebar activeView={activeView} onViewChange={setActiveView} chapters={chapters || []} />
      <div className={main}>
        <div className={topBar}>
          <h2>{project.title}</h2>
          <WorkflowProgress currentStage={project.currentStage} onStageClick={setActiveView} />
        </div>
        <div className={content}>
          {/* Views will be rendered here based on activeView */}
          <div>View: {activeView}</div>
        </div>
      </div>
      <div className={chatPanel}>
        {/* Chat panel will be implemented in Task 15 */}
        <div style={{ padding: '1rem' }}>Chat Panel</div>
      </div>
    </div>
  );
}
