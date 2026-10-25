import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import type { CanonLedger } from '@/shared/canon';
import { pageHeading, loadingWrap } from './viewShared';

const container = css`
  padding: 1rem;
`;

const hint = css`
  margin-bottom: 1rem;
  color: var(--haze-color-text-secondary);
  font-size: 0.8rem;
  line-height: 1.5;
`;

const grid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1rem;
  margin-bottom: 1rem;
`;

const card = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 0.75rem;
  background: var(--haze-color-bg-secondary);
`;

const cardTitle = css`
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
`;

const table = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
  th, td { text-align: left; padding: 0.35rem 0.4rem; border-bottom: 1px solid var(--haze-color-border); }
  th { color: var(--haze-color-text-secondary); font-weight: 500; }
`;

const badge = css`
  display: inline-block;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  font-size: 0.7rem;
`;

const empty = css`
  color: var(--haze-color-text-secondary);
  font-size: 0.78rem;
`;

interface Props { projectId: string }

export default function CanonView({ projectId }: Props) {
  const { data, isLoading } = useQuery<{ canon: CanonLedger }>({
    queryKey: ['canon', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/canon`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  const canon = data?.canon;
  if (!canon || (canon.entities.length === 0 && canon.facts.length === 0 && Object.keys(canon.knowledge ?? {}).length === 0)) {
    return (
      <div className={container}>
        <h2 className={pageHeading}>设定台账 Canon</h2>
        <div className={hint}>
          暂无结构化台账。写作阶段会自动注入已有 canon；也可通过
          <code> POST /api/projects/{projectId}/canon/changes </code>
          追加实体、事实与角色知情边界。章节合同在
          <code> PUT /api/projects/{projectId}/contracts/:num </code>
          写入，定稿时会做 POV/出场/揭示/字数校验。
        </div>
      </div>
    );
  }

  const activeFacts = canon.facts.filter((fact) => fact.status === 'active');
  const knowledge = Object.entries(canon.knowledge ?? {});

  return (
    <div className={container}>
      <h2 className={pageHeading}>设定台账 Canon</h2>
      <div className={hint}>
        结构化事实层：与 Markdown 设定互补，写作时按本章角色自动注入。事实更新会把旧值标记为
        <code> superseded </code>，不覆盖历史。
      </div>

      <div className={grid}>
        <div className={card}>
          <div className={cardTitle}>统计</div>
          <table className={table}>
            <tbody>
              <tr><td>实体</td><td>{canon.entities.length}</td></tr>
              <tr><td>有效事实</td><td>{activeFacts.length}</td></tr>
              <tr><td>角色知情边界</td><td>{knowledge.length}</td></tr>
              <tr><td>最后更新</td><td>{canon.updatedAt ? new Date(canon.updatedAt).toLocaleString() : '—'}</td></tr>
            </tbody>
          </table>
        </div>

        <div className={card}>
          <div className={cardTitle}>角色知情边界</div>
          {knowledge.length === 0 ? <div className={empty}>暂无</div> : (
            <table className={table}>
              <thead><tr><th>角色</th><th>已知</th><th>尚不知</th></tr></thead>
              <tbody>
                {knowledge.map(([name, entry]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td>{entry.knows.join('；') || '—'}</td>
                    <td>{entry.doesNotKnow.join('；') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className={card} style={{ marginBottom: '1rem' }}>
        <div className={cardTitle}>实体</div>
        {canon.entities.length === 0 ? <div className={empty}>暂无</div> : (
          <table className={table}>
            <thead><tr><th>名称</th><th>类型</th><th>别名</th><th>状态</th><th>起始章</th></tr></thead>
            <tbody>
              {canon.entities.map((entity) => (
                <tr key={entity.id}>
                  <td>{entity.name}</td>
                  <td><span className={badge}>{entity.type}</span></td>
                  <td>{entity.aliases.join('、') || '—'}</td>
                  <td>{entity.status}</td>
                  <td>{entity.sourceChapter ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={card}>
        <div className={cardTitle}>当前有效事实</div>
        {activeFacts.length === 0 ? <div className={empty}>暂无</div> : (
          <table className={table}>
            <thead><tr><th>主体</th><th>谓词</th><th>值</th><th>起始章</th><th>来源</th></tr></thead>
            <tbody>
              {activeFacts.map((fact) => (
                <tr key={fact.id}>
                  <td>{fact.subject}</td>
                  <td>{fact.predicate}</td>
                  <td>{fact.object}</td>
                  <td>{fact.validFrom}</td>
                  <td>{fact.confidence === 'proposed' ? '候选' : '确认'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
