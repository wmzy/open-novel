import { useMemo } from 'react';
import { css } from '@linaria/core';
import { useNovelFile, EmptyState, loadingWrap, pageHeading, card, cardTitle, CardContent, ViewToolbar, useViewMode, viewHeaderRow, reviseBtn } from './viewShared';
import { parseSections } from './parseSections';
import type { MdSection } from './parseSections';
import { useFileRevision } from '@/web/hooks/useFileRevision';

interface Props {
  projectId: string;
}

/** 要素卡片网格。 */
const conceptGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
`;

/** 强调卡片：核心冲突 / 两难困境。 */
const conceptHighlight = css`
  border-color: var(--haze-color-warning, #f59e0b);
  background: color-mix(in srgb, var(--haze-color-warning, #f59e0b) 10%, var(--haze-color-bg));
`;

/** 强调卡片标题。 */
const conceptHighlightTitle = css`
  border-bottom-color: color-mix(in srgb, var(--haze-color-warning, #f59e0b) 35%, var(--haze-color-border));
  color: var(--haze-color-warning, #f59e0b);
`;

/** 梗概卡片的大号文本。 */
const loglineText = css`
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  line-height: 1.6;
  color: var(--haze-color-text);
`;

/** 五句话简介编号列表。 */
const synopsisList = css`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  counter-reset: synopsis;
`;

/** 编号项。 */
const synopsisItem = css`
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--haze-color-text);
  counter-increment: synopsis;
`;

/** 编号圆点。 */
const synopsisNum = css`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 50%;
  background: var(--haze-color-primary);
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
`;

/** 是否为强调要素（核心冲突 / 两难困境）。 */
function isHighlight(title: string): boolean {
  return title.includes('核心冲突') || title.includes('两难困境');
}

export default function ConceptView({ projectId }: Props) {
  const { data, isLoading } = useNovelFile(projectId, 'concept', 'concept.md');
  const [viewMode, setViewMode] = useViewMode();
  const revision = useFileRevision({ projectId, targetFile: 'concept.md', stage: 'concept' });

  const sections = useMemo(() => (data ? parseSections(data).sections : []), [data]);

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!data) return <EmptyState message="尚未创建故事概念。" command="/concept" />;
  if (sections.length === 0) {
    return (
      <div>
        <h3 className={pageHeading}>故事概念</h3>
        <EmptyState message="故事概念暂无结构化内容。" command="/concept" />
      </div>
    );
  }

  const renderElement = (s: MdSection, i: number) => {
    const highlight = isHighlight(s.title);
    const isLogline = s.title.includes('一句话梗概');
    const hasSynopsis = s.ordered.length > 0;

    return (
      <div key={i} className={card + (highlight ? ' ' + conceptHighlight : '')}>
        <div className={cardTitle + (highlight ? ' ' + conceptHighlightTitle : '')}>{s.title}</div>

        {hasSynopsis ? (
          <ol className={synopsisList}>
            {s.ordered.map((t, j) => (
              <li key={j} className={synopsisItem}>
                <span className={synopsisNum}>{j + 1}</span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        ) : isLogline ? (
          s.body.length > 0 ? (
            <p className={loglineText}>{s.body.join(' ')}</p>
          ) : (
            <p className={loglineText} style={{ opacity: 0.55, fontWeight: 400 }}>暂未填写</p>
          )
        ) : (
          <CardContent rawMd={s.fullRawMd} mode={viewMode} />
        )}
      </div>
    );
  };

  return (
    <div>
      <div className={viewHeaderRow}>
        <h3 className={pageHeading}>故事概念</h3>
        <button className={reviseBtn} onClick={() => revision.openDialog()}>✎ 修订</button>
        <ViewToolbar mode={viewMode} onChange={setViewMode} />
      </div>
      <div className={conceptGrid}>{sections.map(renderElement)}</div>
      {revision.dialog}
    </div>
  );
}
