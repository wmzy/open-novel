import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { CollapsibleDiagram } from '../MermaidDiagram';
import { pageHeading, loadingWrap } from './viewShared';

const container = css`
  padding: 1rem;
`;

const emptyHint = css`
  padding: 2rem;
  color: var(--haze-color-text-secondary);
  font-size: 0.85rem;
  text-align: center;
`;

interface Props {
  projectId: string;
}

export default function CharacterGraphView({ projectId }: Props) {
  const { data, isLoading } = useQuery<{ graph: string | null }>({
    queryKey: ['character-graph', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/character-graph`);
      if (!res.ok) return { graph: null };
      return res.json();
    },
  });

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!data?.graph) {
    return (
      <div className={container}>
        <h2 className={pageHeading}>角色关系图</h2>
        <div className={emptyHint}>
          暂无角色关系数据。逆向拆书或正常写作后，角色关系将自动出现在此。
        </div>
      </div>
    );
  }

  return (
    <div className={container}>
      <CollapsibleDiagram chart={data.graph} title="角色关系图" />
    </div>
  );
}
