import { useQuery, useQueryClient } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { reviseBtn } from './viewShared';
import { useFileRevision } from '@/web/hooks/useFileRevision';

const STATUS_OPTIONS: Array<[string, string]> = [
  ['draft', '草稿'],
  ['review', '审阅中'],
  ['revised', '已修订'],
  ['finalized', '已定稿'],
];

interface ChapterRow {
  id: string;
  number: number;
  title: string;
  wordCount: number;
  status: string;
}

const statsRow = css`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
`;

const statCard = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  padding: 1.25rem;
  text-align: center;
`;

const statValue = css`
  font-size: 1.6rem;
  font-weight: 700;
  color: var(--haze-color-primary);
`;

const statLabel = css`
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  margin-top: 0.25rem;
`;

const chapterList = css`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const chapterCard = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1rem;
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  &:hover {
    border-color: var(--haze-color-primary);
    background: var(--haze-color-bg-secondary);
  }
`;

const chapterTitle = css`
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--haze-color-text);
`;

const chapterMeta = css`
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
`;

const statusSelect = css`
  margin-left: 0.5rem;
  padding: 0.125rem 0.25rem;
  font-size: 0.7rem;
  border-radius: 4px;
  border: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  cursor: pointer;
  &:hover { background: var(--haze-color-bg-secondary); }
`;

const emptyHint = css`
  text-align: center;
  padding: 3rem 1rem;
  color: var(--haze-color-text-secondary);
  & h3 { margin-bottom: 0.5rem; color: var(--haze-color-text); }
`;

/** 样章门 / 样章阶段顶部提示条。 */
const stageBanner = css`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.875rem 1rem;
  margin-bottom: 1.5rem;
  border: 1px solid var(--haze-color-primary);
  border-radius: 8px;
  background: var(--haze-color-bg);
  & strong { color: var(--haze-color-text); }
  & p { margin: 0.25rem 0 0; font-size: 0.8rem; color: var(--haze-color-text-secondary); }
`;

/** 提示条主操作按钮（去写样章）。 */
const stageBannerBtn = css`
  flex-shrink: 0;
  padding: 0.375rem 0.875rem;
  border: none;
  border-radius: 6px;
  background: var(--haze-color-primary);
  color: #fff;
  font-size: 0.8rem;
  white-space: nowrap;
  cursor: pointer;
  &:hover { opacity: 0.9; }
`;

/** 章节右侧操作栏。 */
const chapterActions = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
`;

export default function WritingView({
  projectId,
  onViewChange,
  variant = 'writing',
}: {
  projectId: string;
  onViewChange: (view: string) => void;
  /** writing：正式写作视图；sample：样章阶段复用本视图展示样章章节。 */
  variant?: 'writing' | 'sample';
}) {
  const revision = useFileRevision({ projectId, targetFile: '', stage: 'writing' });
  const queryClient = useQueryClient();

  /** 手动流转章节状态（草稿/审阅中/已修订/已定稿）。 */
  const updateStatus = async (num: number, status: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/chapters/${num}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      queryClient.invalidateQueries({ queryKey: ['chapters', projectId] });
    } catch {
      // 状态更新失败静默回滚下拉值（查询缓存未变，重渲染即恢复）
    }
  };
  const { data: chapters } = useQuery<ChapterRow[]>({
    queryKey: ['chapters', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters`);
      const data = await res.json();
      return data.chapters;
    },
  });
  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}`);
      const data = await res.json();
      return data.project;
    },
  });

  const list = chapters || [];
  const totalWords = list.reduce((sum, c) => sum + (c.wordCount || 0), 0);
  /** 有正文的章节数。与服务端 countWrittenChaptersFromDisk 口径一致（CJK ≥ 100）。 */
  const writtenCount = list.filter((c) => (c.wordCount || 0) >= 100).length;
  /** 样章门：writing 阶段但正文不足 3 章时，提示先去写样章。 */
  const gateBlocked = variant === 'writing' && project?.currentStage === 'writing' && writtenCount < 3;

  const banner = variant === 'sample' ? (
    <div className={stageBanner}>
      <div>
        <strong>样章阶段（{writtenCount}/3 章）</strong>
        <p>写第 1 章 + 自选 2 个关键章节共 3 章样章，检验声口与节奏；每章复盘回灌大纲后进入正式写作。</p>
      </div>
    </div>
  ) : gateBlocked ? (
    <div className={stageBanner}>
      <div>
        <strong>样章门：正文 {writtenCount}/3 章</strong>
        <p>正式写作前需先完成 3 章样章检验声口与节奏，并把复盘反馈回灌大纲；否则写作请求会被拦截。</p>
      </div>
      <button className={stageBannerBtn} onClick={() => onViewChange('sample')}>去写样章</button>
    </div>
  ) : null;

  if (list.length === 0) {
    return (
      <div>
        {banner}
        <div className={emptyHint}>
          <h3>{variant === 'sample' ? '还没有样章' : '还没有章节'}</h3>
          <p>
            {variant === 'sample'
              ? '在右侧对话面板选择「样章」阶段，输入「开始写样章」即可让 AI 根据大纲写第 1 章样章并自选关键章节。'
              : gateBlocked
                ? '正文尚不足 3 章——请先完成样章阶段，再回到这里开始正式写作。'
                : '在右侧对话面板选择「写作」阶段，输入「开始写第 1 章」即可让 AI 根据大纲创作正文。'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {banner}
      <div className={statsRow}>
        <div className={statCard}>
          <div className={statValue}>{list.length}</div>
          <div className={statLabel}>已写章节</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{totalWords.toLocaleString()}</div>
          <div className={statLabel}>总字数</div>
        </div>
        <div className={statCard}>
          <div className={statValue}>{list.length > 0 ? Math.round(totalWords / list.length).toLocaleString() : 0}</div>
          <div className={statLabel}>平均章节字数</div>
        </div>
      </div>
      <div className={chapterList}>
        {list.map((c) => (
          <div key={c.id} className={chapterCard} onClick={() => onViewChange(`chapter-${c.number}`)}>
            <span className={chapterTitle}>
              第 {c.number} 章 {c.title}
              <select
                className={statusSelect}
                value={c.status || 'draft'}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => void updateStatus(c.number, e.target.value)}
                title="章节状态"
              >
                {STATUS_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </span>
            <span className={chapterActions}>
              <span className={chapterMeta}>{(c.wordCount || 0).toLocaleString()} 字</span>
              <button
                className={reviseBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  revision.openRevise(`chapters/第${c.number}章.md`);
                }}
              >
                ✎ 修订
              </button>
            </span>
          </div>
        ))}
      </div>
      {revision.renameDialog}
    </div>
  );
}
