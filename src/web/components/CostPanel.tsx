import { useState } from 'react';
import { css } from '@linaria/core';
import { useCosts, type RunCostRow } from '@/web/hooks/useCosts';

const wrap = css`
  margin: 0.75rem 0 1.5rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 0.875rem;
  background: var(--haze-color-bg-secondary);
  font-size: 0.8rem;
`;

const totalRow = css`
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.375rem;
  & strong { color: var(--haze-color-text); }
`;

const barTrack = css`
  height: 8px;
  border-radius: 4px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  overflow: hidden;
  margin-bottom: 0.875rem;
`;

const barFill = css`
  height: 100%;
  background: var(--haze-color-primary);
`;

const barFillOver = css`
  height: 100%;
  background: var(--haze-color-danger, #d33);
`;

const exceedBanner = css`
  margin-bottom: 0.875rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--haze-color-danger, #d33);
  color: var(--haze-color-danger, #d33);
  font-weight: 600;
`;

const budgetEditor = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.875rem;
  color: var(--haze-color-text-secondary);
  font-size: 0.78rem;
`;

const budgetInput = css`
  width: 7rem;
  padding: 0.2rem 0.4rem;
  font-size: 0.75rem;
  border-radius: 4px;
  border: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
`;

const sectionTitle = css`
  margin: 0.875rem 0 0.375rem;
  color: var(--haze-color-text);
  font-weight: 600;
`;

const costTable = css`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
  th, td { text-align: left; padding: 0.3rem 0.4rem; border-bottom: 1px solid var(--haze-color-border); vertical-align: middle; }
  th { color: var(--haze-color-text-secondary); font-weight: 500; white-space: nowrap; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.mono { font-family: var(--haze-font-mono, monospace); font-size: 0.72rem; }
`;

const emptyMsg = css`
  color: var(--haze-color-text-secondary);
`;

const badge = css`
  display: inline-block;
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  font-size: 0.7rem;
  white-space: nowrap;
`;

interface Props {
  projectId: string;
}

/** tokens 千分位。 */
function fmtTokens(n: number): string {
  return n.toLocaleString();
}

/** 金额固定 4 位小数。 */
function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

const MODE_LABELS: Record<string, string> = {
  generate: '生成',
  revise: '修订',
  rewrite: '重写',
};

const STATUS_LABELS: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  running: '运行中',
  queued: '排队中',
};

/**
 * 成本面板（只读聚合 + 预算提醒）：
 * 按 模型/run/章节/日 聚合 runtime_usage 的 tokens 与 costUsd，
 * 超出 cost_budget_usd 预算时显示醒目横幅（服务端无定时轮询，打开面板即提醒）。
 */
export default function CostPanel({ projectId }: Props) {
  const { summary, budget, saveBudget } = useCosts(projectId, true);
  const [budgetDraft, setBudgetDraft] = useState('');

  const data = summary.data;
  const budgetUsd = budget.data?.budgetUsd ?? data?.budget.budgetUsd ?? null;
  const exceeded = data?.budget.exceeded ?? budget.data?.exceeded ?? false;
  const spentUsd = data?.total.costUsd ?? budget.data?.spentUsd ?? 0;
  const pct = data?.budget.percent ?? budget.data?.percent ?? null;

  return (
    <div className={wrap}>
      {summary.isLoading && <div className={emptyMsg}>加载成本数据中...</div>}
      {summary.isError && <div className={emptyMsg}>加载失败，请稍后重试。</div>}

      {data && (
        <>
          {exceeded && budgetUsd !== null && (
            <div className={exceedBanner} role="alert">
              ⚠ 预算已超支：已花费 {fmtUsd(spentUsd)} / 预算 {fmtUsd(budgetUsd)}（{pct ?? '-'}%）
            </div>
          )}

          <div className={totalRow}>
            <strong>总计 {fmtTokens(data.total.tokens)} tokens · {fmtUsd(data.total.costUsd)}</strong>
            <span>{data.total.runs} 个 run{data.total.unknownCostRuns > 0 ? `（${data.total.unknownCostRuns} 个 run 金额未知，按 $0 计）` : ''}</span>
          </div>
          {budgetUsd !== null && (
            <div className={barTrack}>
              <div
                className={exceeded ? barFillOver : barFill}
                style={{ width: `${Math.min(100, pct ?? 0)}%` }}
              />
            </div>
          )}

          <div className={budgetEditor}>
            <label htmlFor="cost-budget-input">预算（USD）</label>
            <input
              id="cost-budget-input"
              className={budgetInput}
              type="number"
              min="0"
              step="0.5"
              placeholder={budgetUsd !== null ? String(budgetUsd) : '未设置'}
              value={budgetDraft}
              onChange={(e) => setBudgetDraft(e.target.value)}
            />
            <button
              type="button"
              disabled={saveBudget.isPending || budgetDraft.trim() === ''}
              onClick={() => {
                const v = Number.parseFloat(budgetDraft);
                if (Number.isFinite(v) && v >= 0) saveBudget.mutate(v);
                setBudgetDraft('');
              }}
            >
              保存
            </button>
            {budgetUsd !== null && (
              <button
                type="button"
                disabled={saveBudget.isPending}
                onClick={() => saveBudget.mutate(null)}
              >
                清除
              </button>
            )}
            {saveBudget.isError && <span>保存失败</span>}
          </div>

          {data.total.tokens === 0 && data.total.runs === 0 ? (
            <div className={emptyMsg}>暂无成本数据</div>
          ) : (
            <>
              <div className={sectionTitle}>按模型</div>
              <table className={costTable}>
                <thead>
                  <tr><th>模型</th><th className="num">runs</th><th className="num">tokens</th><th className="num">成本（USD）</th></tr>
                </thead>
                <tbody>
                  {data.byModel.map((m) => (
                    <tr key={m.model ?? '__unknown'}>
                      <td>{m.model ?? <span className={badge}>未记录</span>}</td>
                      <td className="num">{m.runs}</td>
                      <td className="num">{fmtTokens(m.tokens)}</td>
                      <td className="num">{fmtUsd(m.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {data.byChapter.length > 0 && (
                <>
                  <div className={sectionTitle}>按章节（仅能唯一归属的 run）</div>
                  <table className={costTable}>
                    <thead>
                      <tr><th>章节</th><th className="num">tokens</th><th className="num">成本（USD）</th></tr>
                    </thead>
                    <tbody>
                      {data.byChapter.map((c) => (
                        <tr key={c.chapter}>
                          <td>第 {c.chapter} 章</td>
                          <td className="num">{fmtTokens(c.tokens)}</td>
                          <td className="num">{fmtUsd(c.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <div className={sectionTitle}>按日（UTC）</div>
              <table className={costTable}>
                <thead>
                  <tr><th>日期</th><th className="num">tokens</th><th className="num">成本（USD）</th></tr>
                </thead>
                <tbody>
                  {data.byDay.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td className="num">{fmtTokens(d.tokens)}</td>
                      <td className="num">{fmtUsd(d.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className={sectionTitle}>按 run</div>
              <table className={costTable}>
                <thead>
                  <tr><th>run</th><th>模式</th><th>状态</th><th className="num">tokens</th><th className="num">成本（USD）</th><th>开始时间</th></tr>
                </thead>
                <tbody>
                  {data.byRun.map((r: RunCostRow) => (
                    <tr key={r.runId}>
                      <td className="mono" title={r.runId}>{r.runId.slice(0, 8)}…</td>
                      <td>{MODE_LABELS[r.mode] ?? r.mode}</td>
                      <td>{STATUS_LABELS[r.status] ?? r.status}</td>
                      <td className="num">{fmtTokens(r.tokens)}</td>
                      <td className="num">{fmtUsd(r.costUsd)}</td>
                      <td>{r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
