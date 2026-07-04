import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { useState } from 'react';
import RevisionDialog from '../RevisionDialog';

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

const statusBadge = css`
  display: inline-block;
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
  font-size: 0.7rem;
  margin-left: 0.5rem;
  background: var(--haze-color-bg-secondary);
  color: var(--haze-color-text-secondary);
`;

const emptyHint = css`
  text-align: center;
  padding: 3rem 1rem;
  color: var(--haze-color-text-secondary);
  & h3 { margin-bottom: 0.5rem; color: var(--haze-color-text); }
`;

const reviseBtn = css`
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--haze-color-text);
  &:hover {
    border-color: var(--haze-color-primary);
    color: var(--haze-color-primary);
  }
`;

const statusLabels: Record<string, string> = {
  draft: '草稿',
  review: '审阅中',
  revised: '已修订',
  finalized: '已定稿',
};

export default function WritingView({
  projectId,
  onViewChange,
}: {
  projectId: string;
  onViewChange: (view: string) => void;
}) {
  const [reviseChapter, setReviseChapter] = useState<number | null>(null);
  const { data: chapters } = useQuery<ChapterRow[]>({
    queryKey: ['chapters', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters`);
      const data = await res.json();
      return data.chapters;
    },
  });

  const list = chapters || [];
  const totalWords = list.reduce((sum, c) => sum + (c.wordCount || 0), 0);

  if (list.length === 0) {
    return (
      <div className={emptyHint}>
        <h3>还没有章节</h3>
        <p>在右侧对话面板选择「写作」阶段，输入「开始写第 1 章」即可让 AI 根据大纲创作正文。</p>
      </div>
    );
  }

  return (
    <div>
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
              <span className={statusBadge}>{statusLabels[c.status] || c.status}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span className={chapterMeta}>{(c.wordCount || 0).toLocaleString()} 字</span>
              <button
                className={reviseBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  setReviseChapter(c.number);
                }}
              >
                ✎ 修订
              </button>
            </span>
          </div>
        ))}
      </div>
      {reviseChapter !== null && (
        <RevisionDialog
          projectId={projectId}
          targetFile={`chapters/第${reviseChapter}章.md`}
          onClose={() => setReviseChapter(null)}
          onSubmit={async (mode, data) => {
            if (mode === 'revise') {
              await fetch('/api/runs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  projectId,
                  agentId: 'claude-code',
                  stage: 'writing',
                  message: data.revisionNote,
                  mode: 'revise',
                  targetFile: `chapters/第${reviseChapter}章.md`,
                  revisionNote: data.revisionNote,
                }),
              });
            } else {
              await fetch(`/api/projects/${projectId}/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  oldName: data.oldName,
                  newName: data.newName,
                  scope: data.scope,
                }),
              });
            }
            setReviseChapter(null);
          }}
        />
      )}
    </div>
  );
}
