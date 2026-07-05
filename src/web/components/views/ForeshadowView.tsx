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
  if (!data) return <div>尚未创建伏笔。前往「大纲」阶段，生成大纲时会自动登记伏笔到此看板。</div>;

  // 严格只认标准 schema：{ foreshadows: [{ id, content, status, plantedIn, resolvedIn }] }
  // status 必须是 pending/planted/resolved，其余值视为数据错误，该条不渲染。
  type Item = { id: number; content: string; status: string; plantedIn: number | null; resolvedIn: number | null };
  const rawList: Item[] = Array.isArray(data?.foreshadows)
    ? data.foreshadows.filter((f: unknown): f is Item =>
        !!f && typeof f === 'object'
        && typeof (f as Item).content === 'string'
        && typeof (f as Item).status === 'string'
        && ['pending','planted','resolved'].includes((f as Item).status))
    : [];
  const num = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const p = parseInt(v, 10); return Number.isNaN(p) ? 0 : p; }
    return 0;
  };
  const normalize = (arr: Item[]) => arr.map((f) => ({
    id: typeof f.id === 'number' ? f.id : Number(f.id) || 0,
    content: f.content,
    status: f.status as 'pending' | 'planted' | 'resolved',
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
