import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';

const kanban = css`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1rem;
`;

const column = css`
  background: var(--haze-color-bg-secondary);
  border-radius: 8px;
  padding: 1rem;
`;

const columnTitle = css`
  font-weight: 600;
  margin-bottom: 1rem;
  font-size: 0.875rem;
`;

const item = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.75rem;
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
`;

interface Props {
  projectId: string;
}

export default function ForeshadowView({ projectId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['novel-file', projectId, 'foreshadow'],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('foreshadow.json')}`);
      if (!res.ok) return null;
      const wrapper = await res.json();
      try { return JSON.parse(wrapper.content); } catch { return null; }
    },
  });

  if (isLoading) return <div>加载中...</div>;
  if (!data) return <div>尚未创建伏笔。在聊天面板中输入 /foreshadow 开始。</div>;

  const pending = data.foreshadows?.filter((f: { content: string; status: string }) => f.status === 'pending') || [];
  const planted = data.foreshadows?.filter((f: { content: string; status: string }) => f.status === 'planted') || [];
  const resolved = data.foreshadows?.filter((f: { content: string; status: string }) => f.status === 'resolved') || [];

  return (
    <div>
      <h3>伏笔</h3>
      <div className={kanban}>
        <div className={column}>
          <div className={columnTitle}>待埋</div>
          {pending.map((f: { content: string; status: string }, i: number) => (
            <div key={i} className={item}>{f.content}</div>
          ))}
        </div>
        <div className={column}>
          <div className={columnTitle}>已埋</div>
          {planted.map((f: { content: string; status: string }, i: number) => (
            <div key={i} className={item}>{f.content}</div>
          ))}
        </div>
        <div className={column}>
          <div className={columnTitle}>已收</div>
          {resolved.map((f: { content: string; status: string }, i: number) => (
            <div key={i} className={item}>{f.content}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
