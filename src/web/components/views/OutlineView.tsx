import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ViewMode } from './viewShared';
import { css } from '@linaria/core';
import { useNovelFile, EmptyState, loadingWrap, pageHeading, CardContent, ViewToolbar, useViewMode, viewHeaderRow, reviseBtn } from './viewShared';
import { parseSections } from './parseSections';
import type { MdSection } from './parseSections';
import { useQuery } from '@tanstack/react-query';
import { CollapsibleDiagram } from '../MermaidDiagram';
import { buildArcDiagram, buildPovTimeline } from '../../../shared/diagram-builders';
import { parseOutlineMeta } from '../../../shared/outline-meta';
import { DEEPEN_TO_CHAT_EVENT } from '@/shared/deepen';

interface Props {
  projectId: string;
}

/** 章节卡片列表（垂直堆叠）。 */
const chapterList = css`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
`;

/** 单个章节卡片。 */
const chapterCard = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 10px;
  overflow: hidden;
`;

/** 可点击的章节头部。 */
const chapterHeader = css`
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.75rem 1rem;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.95rem;
  color: var(--haze-color-text);
  &:hover { background: var(--haze-color-bg-secondary); }
`;

/** 折叠箭头。 */
const chevron = css`
  display: inline-block;
  width: 1em;
  text-align: center;
  color: var(--haze-color-text-secondary);
  transition: transform 0.15s;
`;

/** 章节号徽标。 */
const chapterBadge = css`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.5rem;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  font-size: 0.72rem;
  font-weight: 600;
  color: white;
  background: var(--haze-color-primary);
`;

/** 章节标题文本。 */
const chapterTitle = css`
  font-weight: 500;
`;

/** 章节正文。 */
const chapterBody = css`
  padding: 0.5rem 1rem 1rem;
  border-top: 1px solid var(--haze-color-border);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

/** 从"第N章[场景]"中提取章节号。 */
function chapterNumber(title: string): string | null {
  const m = title.match(/第\s*(\d+)\s*章/);
  return m ? m[1] : null;
}

/** 章节字段强调色：冲突=警告，结果=成功，目标=主色。 */
function fieldEmphasis(key: string): CSSProperties | undefined {
  if (key === '冲突') return { color: 'var(--haze-color-error, #ef4444)', fontWeight: 500 };
  if (key === '结果') return { color: 'var(--haze-color-success, #22c55e)', fontWeight: 500 };
  if (key === '目标') return { color: 'var(--haze-color-primary)', fontWeight: 500 };
  return undefined;
}

export default function OutlineView({ projectId }: Props) {
  const { data, isLoading } = useNovelFile(projectId, 'outline', 'outline-detailed.md');
  const [viewMode, setViewMode] = useViewMode();

  const sections = useMemo(() => (data ? parseSections(data).sections : []), [data]);

  // 跟踪“已折叠”的章节：默认空集 = 全部展开。这样在数据加载完成后新出现的章节也默认展开，
  // 不依赖 useState 初始化时机。
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  // 额外读取 outline-meta.json 获取三幕分界与视点数据
  const { data: metaData } = useQuery({
    queryKey: ['novel-file', projectId, 'outline-meta'],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('outline-meta.json')}`);
      if (!res.ok) return null;
      const wrapper = await res.json();
      try { return JSON.parse(wrapper.content); } catch { return null; }
    },
  });
  const meta = parseOutlineMeta(metaData);
  const arcDiagram = meta ? buildArcDiagram(meta) : null;
  const povChunks = meta ? buildPovTimeline(meta) : null;

  const toggle = (i: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!data) return <EmptyState message="尚未创建大纲。" command="/outline" />;
  if (sections.length === 0) {
    return (
      <div>
        <h3 className={pageHeading}>大纲</h3>
        <EmptyState message="大纲暂无结构化内容。" command="/outline" />
      </div>
    );
  }

  const renderChapter = (s: MdSection, i: number) => {
    const num = chapterNumber(s.title);
    const titleField = s.fields.find((f) => f.key === '标题')?.value;
    const isOpen = !collapsed.has(i);
    return (
      <div key={i} className={chapterCard}>
        <button type="button" className={chapterHeader} onClick={() => toggle(i)} aria-expanded={isOpen}>
          <span className={chevron}>{isOpen ? '▾' : '▸'}</span>
          {num !== null && <span className={chapterBadge}>第 {num} 章</span>}
          <span className={chapterTitle}>{titleField || s.title}</span>
        </button>
        {isOpen && (
          <div className={chapterBody}>
            <CardContent rawMd={s.fullRawMd} mode={viewMode} projectId={projectId} />
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      <div className={viewHeaderRow}>
        <h3 className={pageHeading}>大纲</h3>
        <button
          className={reviseBtn}
          onClick={() => window.dispatchEvent(new CustomEvent(DEEPEN_TO_CHAT_EVENT, { detail: { stage: 'outline' } }))}
          title="自主循环深化大纲阶段"
        >🔁 深化</button>
        <ViewToolbar mode={viewMode} onChange={setViewMode} />
      </div>
      <CollapsibleDiagram chart={arcDiagram} title="三幕节奏" />
      {povChunks?.map((chunk, i) => (
        <CollapsibleDiagram key={i} chart={chunk.chart} title={chunk.title} defaultShow={i === 0} />
      ))}
      <div className={chapterList}>{sections.map(renderChapter)}</div>
    </div>
  );
}
