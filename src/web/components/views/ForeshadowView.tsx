import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { CollapsibleDiagram } from '../MermaidDiagram';
import { buildForeshadowGantt } from '../../../shared/diagram-builders';

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

  // 容错两种 schema：标准 { foreshadows } 与逆向/enrich 产出的 { items }
  type Item = { id?: number | string; content?: string; description?: string; status: string; plantedIn?: number | string | null; resolvedIn?: number | string | null };
  const rawList: Item[] = Array.isArray(data.foreshadows) ? data.foreshadows
    : Array.isArray(data.items) ? data.items : [];
  const num = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const p = parseInt(v, 10); return Number.isNaN(p) ? 0 : p; }
    return 0;
  };
  const normalize = (arr: Item[]) => arr.map((f, i) => ({
    id: typeof f.id === 'number' ? f.id : typeof f.id === 'string' ? (parseInt(f.id, 10) || i + 1) : i + 1,
    content: f.content ?? f.description ?? '',
    status: f.status,
    plantedIn: f.plantedIn != null ? num(f.plantedIn) : 0,
    resolvedIn: f.resolvedIn != null ? num(f.resolvedIn) : undefined,
  }));

  const pending = normalize(rawList.filter((f) => f.status === 'pending'));
  const planted = normalize(rawList.filter((f) => f.status === 'planted'));
  const resolved = normalize(rawList.filter((f) => f.status === 'resolved'));

  const gantt = buildForeshadowGantt(normalize(rawList));

  return (
    <div>
      <h3>伏笔</h3>
      <CollapsibleDiagram chart={gantt} title="埋设→回收周期" />
      <div className={kanban}>
        <div className={column}>
          <div className={columnTitle}>待埋</div>
          {pending.map((f, i: number) => (
            <div key={i} className={item}>{f.content}</div>
          ))}
        </div>
        <div className={column}>
          <div className={columnTitle}>已埋</div>
          {planted.map((f, i: number) => (
            <div key={i} className={item}>{f.content}</div>
          ))}
        </div>
        <div className={column}>
          <div className={columnTitle}>已收</div>
          {resolved.map((f, i: number) => (
            <div key={i} className={item}>{f.content}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
