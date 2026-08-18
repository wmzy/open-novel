import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { CollapsibleDiagram } from '../MermaidDiagram';
import { buildForeshadowGantt, buildForeshadowDensity } from '../../../shared/diagram-builders';
import {
  computeDensityBudget,
  FORESHADOW_TYPE_LABELS,
  FORESHADOW_WEIGHT_LABELS,
  DENSITY_WINDOW,
  DENSITY_MAX_PER_WINDOW,
  type Foreshadow,
  type ForeshadowStatus,
  type ForeshadowStats,
  type ForeshadowType,
  type ForeshadowWeight,
} from '../../../shared/foreshadow';

const summaryBar = css`
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  font-size: 0.875rem;
`;

const summaryItem = css`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
`;

const summaryLabel = css`
  color: var(--haze-color-fg-secondary, inherit);
`;

const summaryValue = css`
  font-weight: 600;
`;

const dangerValue = css`
  font-weight: 600;
  color: #d64545;
`;

const warnBox = css`
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  border-left: 3px solid #d99a2b;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-bottom: 1rem;
  font-size: 0.8125rem;
  line-height: 1.5;
`;

const kanban = css`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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

const columnCount = css`
  font-weight: 400;
  color: var(--haze-color-fg-secondary, inherit);
  margin-left: 0.25rem;
`;

const item = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  padding: 0.75rem;
  margin-bottom: 0.5rem;
  font-size: 0.875rem;
`;

const itemContent = css`
  margin-bottom: 0.5rem;
  line-height: 1.5;
`;

const badgeRow = css`
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
  font-size: 0.75rem;
`;

const badge = css`
  display: inline-block;
  padding: 0.0625rem 0.375rem;
  border-radius: 4px;
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  white-space: nowrap;
`;

const badgeMajor = css`
  border-color: #d99a2b;
  color: #a8730f;
`;

const badgeOverdue = css`
  border-color: #d64545;
  color: #d64545;
  font-weight: 600;
`;

const metaLine = css`
  margin-top: 0.375rem;
  color: var(--haze-color-fg-secondary, inherit);
  font-size: 0.75rem;
  line-height: 1.5;
`;

interface Props {
  projectId: string;
}

/** 伏笔 API 响应（GET /api/projects/:id/foreshadows）。 */
interface ForeshadowResponse {
  foreshadows: Foreshadow[];
  stats: ForeshadowStats;
  migrated: boolean;
  warnings: string[];
  currentChapter: number;
  chapterCount: number;
}

/** 类型徽章文案；未知类型兜底为契诃夫之枪。 */
function typeLabel(type: ForeshadowType): string {
  return FORESHADOW_TYPE_LABELS[type] ?? FORESHADOW_TYPE_LABELS.chekhov;
}

function weightLabel(weight: ForeshadowWeight): string {
  return FORESHADOW_WEIGHT_LABELS[weight] ?? FORESHADOW_WEIGHT_LABELS.light;
}

/** 单条伏笔卡片：内容 + [类型][权重] 徽章 + 期限/逾期 + 依赖链 + 章号信息。 */
function ForeshadowCard({ f, currentChapter }: { f: Foreshadow; currentChapter: number }) {
  const unsettled = f.status === 'pending' || f.status === 'planted';
  const overdue = unsettled && f.resolveDeadline !== null && f.resolveDeadline < currentChapter;
  const dependsNote = f.dependsOn.length > 0
    ? `前置依赖：${f.dependsOn.map((d) => `#${d}`).join(' → ')}`
    : '';
  const chapterNote = [
    f.plantedIn !== null ? (f.status === 'pending' ? `计划埋于第${f.plantedIn}章` : `埋于第${f.plantedIn}章`) : '',
    f.status === 'resolved' && f.resolvedIn !== null ? `收于第${f.resolvedIn}章` : '',
  ].filter(Boolean).join('｜');
  const meta = [chapterNote, dependsNote].filter(Boolean).join('｜');
  return (
    <div className={item}>
      <div className={itemContent}>{f.content}</div>
      <div className={badgeRow}>
        <span className={badge}>{typeLabel(f.type)}</span>
        <span className={f.weight === 'major' ? `${badge} ${badgeMajor}` : badge}>{weightLabel(f.weight)}</span>
        {f.resolveDeadline !== null && (
          <span className={overdue ? `${badge} ${badgeOverdue}` : badge}>
            期限第{f.resolveDeadline}章{overdue ? '（已逾期）' : ''}
          </span>
        )}
      </div>
      {meta && <div className={metaLine}>{meta}</div>}
    </div>
  );
}

export default function ForeshadowView({ projectId }: Props) {
  // 沿用 ['novel-file', …] 键：ProjectPage 在 foreshadow.json 变更时按此键失效缓存
  const { data, isLoading } = useQuery({
    queryKey: ['novel-file', projectId, 'foreshadow'],
    queryFn: async (): Promise<ForeshadowResponse | null> => {
      const res = await fetch(`/api/projects/${projectId}/foreshadows`);
      if (!res.ok) return null;
      return res.json();
    },
  });

  if (isLoading) return <div>加载中...</div>;
  if (!data || !Array.isArray(data.foreshadows) || data.foreshadows.length === 0) {
    return <div>尚未创建伏笔。前往「大纲」阶段，生成大纲时会自动登记伏笔到此看板。</div>;
  }

  const { foreshadows, stats, migrated, warnings, currentChapter } = data;
  const byStatus = (status: ForeshadowStatus) => foreshadows.filter((f) => f.status === status);

  const pending = byStatus('pending');
  const planted = byStatus('planted');
  const resolved = byStatus('resolved');
  const dropped = byStatus('dropped');

  // 密度预算状态条（默认规则：每 3 章新埋不超过 2 条）
  const budget = computeDensityBudget(foreshadows, currentChapter);

  const ganttItems = foreshadows.map((f) => ({
    id: f.id,
    content: f.content,
    status: f.status,
    plantedIn: f.plantedIn ?? 0,
    resolvedIn: f.resolvedIn ?? undefined,
    resolveDeadline: f.resolveDeadline ?? undefined,
  }));
  const gantt = buildForeshadowGantt(ganttItems);
  const density = buildForeshadowDensity(stats?.density ?? []);

  const columns: Array<{ title: string; list: Foreshadow[] }> = [
    { title: '待埋', list: pending },
    { title: '已埋', list: planted },
    { title: '已收', list: resolved },
    { title: '放弃', list: dropped },
  ];

  return (
    <div>
      <h3>伏笔</h3>

      {/* 债务摘要条：总数 / 债务分 / 逾期 / 密度预算 */}
      <div className={summaryBar}>
        <span className={summaryItem}>
          <span className={summaryLabel}>总数</span>
          <span className={summaryValue}>{stats?.total ?? foreshadows.length}</span>
        </span>
        <span className={summaryItem}>
          <span className={summaryLabel}>债务分</span>
          <span className={summaryValue}>{stats?.debtScore ?? 0}</span>
        </span>
        <span className={summaryItem}>
          <span className={summaryLabel}>逾期未收</span>
          <span className={(stats?.overdue?.length ?? 0) > 0 ? dangerValue : summaryValue}>
            {stats?.overdue?.length ?? 0}
          </span>
        </span>
        <span className={summaryItem}>
          <span className={summaryLabel}>即将到期</span>
          <span className={summaryValue}>{stats?.dueSoon?.length ?? 0}</span>
        </span>
        <span className={summaryItem}>
          <span className={summaryLabel}>密度预算（每{DENSITY_WINDOW}章≤{DENSITY_MAX_PER_WINDOW}条）</span>
          <span className={budget.overBudget ? dangerValue : summaryValue}>
            近{budget.windowSize}章新埋 {budget.plantedInWindow}/{budget.limit} 条
            {budget.overBudget ? '（已超支）' : ''}
          </span>
        </span>
      </div>

      {/* 迁移提示与解析警告（旧格式自动迁移 / 非法条目丢弃） */}
      {(migrated || (warnings?.length ?? 0) > 0) && (
        <div className={warnBox}>
          {migrated && <div>检测到旧格式伏笔文件，已自动迁移为债务 schema（章号/类型/权重/期限）。</div>}
          {warnings?.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}

      <CollapsibleDiagram chart={gantt} title="埋设→回收周期（◆=期限）" />
      <CollapsibleDiagram chart={density} title="伏笔密度（新埋/回收）" defaultShow={false} />

      <div className={kanban}>
        {columns.map((col) => (
          <div key={col.title} className={column}>
            <div className={columnTitle}>
              {col.title}
              <span className={columnCount}>（{col.list.length}）</span>
            </div>
            {col.list.map((f) => (
              <ForeshadowCard key={f.id} f={f} currentChapter={currentChapter} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
