import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { css } from '@linaria/core';
import { useNovelFile, EmptyState, loadingWrap, pageHeading, card, renderBlock } from './viewShared';
import { parseSections } from './parseSections';
import type { MdSection, MdSubsection } from './parseSections';

interface Props {
  projectId: string;
}

/** 章节分组容器（垂直堆叠）。 */
const chapterGroupList = css`
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
`;

/** 章节分组标题。 */
const chapterGroupTitle = css`
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--haze-color-text);
  padding-bottom: 0.4rem;
  border-bottom: 2px solid var(--haze-color-primary);
  display: inline-block;
`;

/** 场景卡片网格。 */
const sceneGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
  margin-top: 0.75rem;
`;

/** 场景卡片头部。 */
const sceneHeader = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.6rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

/** 主动/被动 类型徽标。 */
const sceneBadge = css`
  display: inline-block;
  padding: 0.12rem 0.55rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  color: white;
`;

/** 场景标题（去掉前缀后的纯文本）。 */
const sceneTitle = css`
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--haze-color-text);
`;

const ACTIVE_COLOR = 'var(--haze-color-primary)';
const PASSIVE_COLOR = 'var(--haze-color-warning, #f59e0b)';

/** 判断是否为主动场景。 */
function isActive(title: string): boolean {
  return title.includes('主动');
}

/** 去掉"场景N："前缀，仅保留后半部分（如有）。 */
function stripScenePrefix(title: string): string {
  const m = title.match(/^[^：:]*[：:]\s*(.*)$/);
  return (m ? m[1] : title).trim();
}

function renderSceneCard(sub: MdSubsection, keyPrefix: string, index: number) {
  const active = isActive(sub.title);
  const color = active ? ACTIVE_COLOR : PASSIVE_COLOR;
  const cardStyle: CSSProperties = { borderLeft: `3px solid ${color}` };
  return (
    <div key={`${keyPrefix}-${index}`} className={card} style={cardStyle}>
      <div className={sceneHeader}>
        <span className={sceneBadge} style={{ background: color }}>
          {active ? '主动场景' : '被动场景'}
        </span>
        <span className={sceneTitle}>{stripScenePrefix(sub.title)}</span>
      </div>
      {renderBlock(sub)}
    </div>
  );
}

export default function SceneView({ projectId }: Props) {
  const { data, isLoading } = useNovelFile(projectId, 'scenes', 'scenes.md');

  const sections = useMemo(() => (data ? parseSections(data).sections : []), [data]);

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!data) return <EmptyState message="尚未创建场景。" command="/scenes" />;
  if (sections.length === 0) {
    return (
      <div>
        <h3 className={pageHeading}>场景</h3>
        <EmptyState message="场景设计暂无结构化内容。" command="/scenes" />
      </div>
    );
  }

  const renderChapter = (s: MdSection, i: number) => (
    <div key={i}>
      <div className={chapterGroupTitle}>{s.title}</div>
      {s.subsections.length > 0 ? (
        <div className={sceneGrid}>
          {s.subsections.map((sub, j) => renderSceneCard(sub, `sub-${i}`, j))}
        </div>
      ) : (
        // 没有子场景时，直接渲染分组字段，避免内容丢失
        <div className={sceneGrid}>
          <div className={card}>{renderBlock(s)}</div>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <h3 className={pageHeading}>场景</h3>
      <div className={chapterGroupList}>{sections.map(renderChapter)}</div>
    </div>
  );
}
