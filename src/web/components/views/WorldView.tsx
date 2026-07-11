import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { css } from '@linaria/core';
import { useNovelFile, EmptyState, loadingWrap, pageHeading, card, cardTitle, cardTitleText, cardReviseBtn, isSectionEmpty, CardContent, ViewToolbar, useViewMode, viewHeaderRow, reviseBtn, renameBtn } from './viewShared';
import { parseSections } from './parseSections';
import type { MdSection } from './parseSections';
import { useNovelDocument } from '@/web/hooks/useNovelDocument';
import { useFileRevision } from '@/web/hooks/useFileRevision';
import { sanitizeFileName } from '@/shared/split-document';
import { DEEPEN_TO_CHAT_EVENT } from '@/shared/deepen';

interface Props {
  projectId: string;
}

/** 世界观卡片网格。 */
const worldGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
`;

/** 空内容占位。 */
const emptyValue = css`
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  opacity: 0.6;
  font-style: italic;
`;

/** 已知世界观类别及其主题色，用于卡片左侧色条。 */
const CATEGORY_COLORS: Array<{ match: string; color: string }> = [
  { match: '地理', color: '#0ea5e9' },
  { match: '社会', color: '#8b5cf6' },
  { match: '力量', color: '#f97316' },
  { match: '文化', color: '#ec4899' },
  { match: '规则', color: '#14b8a6' },
];

/** 兜底调色板（按出现顺序循环），用于未知类别。 */
const FALLBACK_COLORS = ['#64748b', '#0ea5e9', '#8b5cf6', '#f97316', '#ec4899', '#14b8a6'];

/** 根据类别标题选取主题色。 */
function colorFor(title: string, fallbackIndex: number): string {
  for (const c of CATEGORY_COLORS) {
    if (title.includes(c.match)) return c.color;
  }
  return FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length];
}

export default function WorldView({ projectId }: Props) {
  const { data, isLoading } = useNovelDocument(projectId, 'world');
  const [viewMode, setViewMode] = useViewMode();
  const revision = useFileRevision({ projectId, targetFile: 'world/index.md', stage: 'world' });

  const sections = useMemo(() => (data ? parseSections(data).sections : []), [data]);

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!data) return <EmptyState message="尚未创建世界观。" command="/world" />;
  if (sections.length === 0) {
    return (
      <div>
        <h3 className={pageHeading}>世界观</h3>
        <EmptyState message="世界观暂无结构化内容。" command="/world" />
      </div>
    );
  }

  const renderCategory = (s: MdSection, i: number) => {
    const color = colorFor(s.title, i);
    const cardStyle: CSSProperties = { borderLeft: `3px solid ${color}` };
    const empty = isSectionEmpty(s);
    return (
      <div key={i} className={card} style={cardStyle}>
        <div className={cardTitle}>
          <span className={cardTitleText}>{s.title}</span>
          <button className={cardReviseBtn} onClick={() => revision.openRevise(`world/${sanitizeFileName(s.title)}.md`)} title="修订这一节">✎</button>
          <button className={cardReviseBtn} onClick={() => revision.openRename()} title="重命名">⇄</button>
        </div>
        {empty ? (
          <div className={emptyValue}>暂无内容，在聊天面板补充 /world</div>
        ) : (
          <CardContent rawMd={s.fullRawMd} mode={viewMode} projectId={projectId} />
        )}
      </div>
    );
  };

  return (
    <div>
      <div className={viewHeaderRow}>
        <h3 className={pageHeading}>世界观</h3>
        <button className={reviseBtn} onClick={() => revision.openRevise()}>✎ 修订</button>
        <button className={renameBtn} onClick={() => revision.openRename()}>⇄ 重命名</button>
        <button
          className={reviseBtn}
          onClick={() => window.dispatchEvent(new CustomEvent(DEEPEN_TO_CHAT_EVENT, { detail: { stage: 'world' } }))}
          title="自主循环深化世界观阶段"
        >🔁 深化</button>
        <ViewToolbar mode={viewMode} onChange={setViewMode} />
      </div>
      <div className={worldGrid}>{sections.map(renderCategory)}</div>
      {revision.renameDialog}
    </div>
  );
}
