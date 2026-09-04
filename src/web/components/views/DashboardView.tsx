import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { STAGES } from '@/shared/stages';

const grid = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
`;

const statCard = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 1.25rem;
  text-align: center;
`;

const statValue = css`
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--haze-color-primary);
`;

const statLabel = css`
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.25rem;
`;

const section = css`
  margin-bottom: 2rem;
`;

const sectionTitle = css`
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 1rem;
  color: var(--haze-color-text);
`;

const progressBar = css`
  height: 8px;
  background: var(--haze-color-border);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
`;

const progressFill = css`
  height: 100%;
  background: var(--haze-color-primary);
  border-radius: 4px;
  transition: width 0.3s;
`;

const progressLabel = css`
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
`;

const recentList = css`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const recentItem = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  font-size: 0.8rem;
`;

const recentDot = css`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
`;

const snapshotList = css`
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
`;

const snapshotItem = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 0.5rem;
  font-size: 0.75rem;
  color: var(--haze-color-text-secondary);
  font-family: var(--haze-font-mono);
`;

/** 章节概览字数。 */
const recentWordCount = css`
  margin-left: auto;
  color: var(--haze-color-text-secondary);
  font-size: 0.75rem;
`;

/** 快照哈希。 */
const snapshotHash = css`
  color: var(--haze-color-primary);
`;

/** 快照日期。 */
const snapshotDate = css`
  margin-left: auto;
`;

/** 首要卡片：有效正文（北极星指标，带进度条）。 */
const heroCard = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-left: 3px solid var(--haze-color-primary);
  border-radius: 8px;
  padding: 1.25rem 1.5rem;
  margin-bottom: 2rem;
`;

/** 首要卡片头：标签 + 百分比。 */
const heroHead = css`
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
`;

/** 首要卡片百分比。 */
const heroPercent = css`
  font-size: 1rem;
  font-weight: 700;
  color: var(--haze-color-primary);
`;

/** 首要卡片数值。 */
const heroValue = css`
  font-size: 2rem;
  font-weight: 700;
  color: var(--haze-color-primary);
  margin: 0.25rem 0 0.75rem;
`;

/** 首要卡片数值单位。 */
const heroUnit = css`
  font-size: 0.875rem;
  font-weight: 400;
  color: var(--haze-color-text-secondary);
`;

/** 卡片内补充说明行。 */
const statSub = css`
  font-size: 0.7rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.5rem;
`;

/** 样章门警示文案。 */
const gateWarn = css`
  font-size: 0.7rem;
  color: var(--haze-color-warning, #f59e0b);
  margin-top: 0.5rem;
`;

/** 卫生警示卡：规划数据污染运行态时高亮。 */
const warnCard = css`
  background: color-mix(in srgb, var(--haze-color-warning, #f59e0b) 10%, var(--haze-color-bg));
  border: 1px solid var(--haze-color-warning, #f59e0b);
  border-radius: 8px;
  padding: 1.25rem;
  text-align: center;
`;

interface Props {
  projectId: string;
}

export default function DashboardView({ projectId }: Props) {
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}`);
      const data = await res.json();
      return data.project;
    },
  });

  const { data: chapters } = useQuery({
    queryKey: ['chapters', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters`);
      const data = await res.json();
      return data.chapters;
    },
  });

  const { data: snapshots } = useQuery({
    queryKey: ['snapshots', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/projects/${projectId}/snapshots`);
      const data = await res.json();
      return data.snapshots || [];
    },
  });

  // 伏笔债务摘要：端点由伏笔工作包提供，缺失/失败时整卡隐藏（defensive）
  const { data: foreshadowStats } = useQuery({
    queryKey: ['foreshadow-stats', projectId],
    staleTime: 30_000,
    queryFn: async (): Promise<{
      debtScore?: number;
      overdue?: unknown[];
      byStatus?: { pending?: number };
    } | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/foreshadows`);
        if (!res.ok) return null;
        const data = await res.json();
        const stats = data?.stats;
        if (!stats || typeof stats !== 'object') return null;
        return stats;
      } catch {
        return null;
      }
    },
  });

  // 状态卫生：规划数据污染运行态检测，端点缺失/失败时整卡隐藏
  const { data: hygiene } = useQuery({
    queryKey: ['state-hygiene', projectId],
    staleTime: 30_000,
    queryFn: async (): Promise<{
      pollution?: Array<{ name: string; fields: string[] }>;
      intentCount?: number;
    } | null> => {
      try {
        const res = await fetch(`/api/projects/${projectId}/state-hygiene`);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    },
  });

  const totalWords = chapters?.reduce((sum: number, ch: { wordCount?: number }) => sum + (ch.wordCount || 0), 0) || 0;
  const targetWords = project?.targetWords || 100000;
  const progress = Math.min(100, Math.round((totalWords / targetWords) * 100));
  const currentStageIdx = STAGES.findIndex((s) => s.id === project?.currentStage);
  const stageLabel = currentStageIdx >= 0 ? STAGES[currentStageIdx].label : project?.currentStage || '-';
  // 样章门：写作阶段需至少 3 个有效章节。口径与服务端一致（wordCount ≥ 100）
  const effectiveChapters = (chapters || []).filter((ch: { wordCount?: number }) => (ch.wordCount || 0) >= 100).length;
  const sampleGateIncomplete = project?.currentStage === 'writing' && effectiveChapters < 3;
  const overdueCount = Array.isArray(foreshadowStats?.overdue) ? foreshadowStats!.overdue!.length : 0;
  const pendingCount = foreshadowStats?.byStatus?.pending ?? 0;

  return (
    <div>
      <h3>总览</h3>

      <div className={heroCard}>
        <div className={heroHead}>
          <span>有效正文</span>
          <span className={heroPercent}>{progress}%</span>
        </div>
        <div className={heroValue}>
          {totalWords.toLocaleString()} <span className={heroUnit}>字</span>
        </div>
        <div className={progressBar}>
          <div className={progressFill} style={{ width: `${progress}%` }} />
        </div>
        <div className={progressLabel}>
          <span>已写 {totalWords.toLocaleString()} 字</span>
          <span>目标 {targetWords.toLocaleString()} 字</span>
        </div>
      </div>

      <div className={grid}>
        <div className={statCard}>
          <div className={statValue}>{totalWords.toLocaleString()}</div>
          <div className={statLabel}>总字数</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{chapters?.length || 0}</div>
          <div className={statLabel}>总章数</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{stageLabel}</div>
          <div className={statLabel}>当前阶段</div>
          {sampleGateIncomplete && (
            <div className={gateWarn}>⚠ 样章未完成（有效章节 {effectiveChapters}/3）</div>
          )}
        </div>
        <div className={statCard}>
          <div className={statValue}>{progress}%</div>
          <div className={statLabel}>完成度</div>
        </div>
        {foreshadowStats && (
          <div className={statCard}>
            <div className={statValue}>{foreshadowStats.debtScore ?? 0}</div>
            <div className={statLabel}>伏笔债务</div>
            <div className={statSub}>
              待回收 {pendingCount} · 逾期 {overdueCount}
            </div>
          </div>
        )}
        {hygiene && (hygiene.pollution?.length ?? 0) > 0 && (
          <div className={warnCard}>
            <div className={statValue}>{hygiene!.pollution!.length}</div>
            <div className={statLabel}>角色待分离</div>
            <div className={statSub}>规划数据污染运行态，{hygiene!.pollution!.length} 个角色待分离</div>
          </div>
        )}
      </div>

      <div className={section}>
        <div className={sectionTitle}>写作进度</div>
        <div className={progressBar}>
          <div className={progressFill} style={{ width: `${progress}%` }} />
        </div>
        <div className={progressLabel}>
          <span>{totalWords.toLocaleString()} 字</span>
          <span>目标: {targetWords.toLocaleString()} 字</span>
        </div>
      </div>

      {chapters && chapters.length > 0 && (
        <div className={section}>
          <div className={sectionTitle}>章节概览</div>
          <div className={recentList}>
            {chapters.slice(0, 5).map((ch: { number: number; title?: string; wordCount?: number }) => (
              <div key={ch.number} className={recentItem}>
                <span className={recentDot} style={{ background: (ch.wordCount ?? 0) > 0 ? 'var(--haze-color-success)' : 'var(--haze-color-border)' }} />
                <span>第 {ch.number} 章 {ch.title || ''}</span>
                <span className={recentWordCount}>
                  {ch.wordCount || 0} 字
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {snapshots && snapshots.length > 0 && (
        <div className={section}>
          <div className={sectionTitle}>最近快照</div>
          <div className={snapshotList}>
            {(snapshots as Array<{ hash: string; message: string; date: string; tags?: string[]; isAuto?: boolean }>)
              .slice()
              .sort((a, b) => {
                const aM = (a.tags || []).length > 0 ? 1 : 0;
                const bM = (b.tags || []).length > 0 ? 1 : 0;
                return bM - aM;
              })
              .slice(0, 5)
              .map((s) => (
                <div key={s.hash} className={snapshotItem} style={
                  (s.tags || []).length > 0
                    ? { background: 'var(--haze-color-bg-secondary)', borderLeft: '3px solid var(--haze-color-primary)' }
                    : undefined
                }>
                  <span className={snapshotHash}>{s.hash.slice(0, 8)}</span>
                  <span>
                    {(s.tags || []).length > 0
                      ? `🏷 ${s.tags!.join(', ').replace(/milestone-/g, '')}`
                      : s.message}
                  </span>
                  <span className={snapshotDate}>{new Date(s.date).toLocaleDateString()}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
