import { useMemo, useState } from 'react';
import { css, cx } from '@linaria/core';
import { useNovelFile, EmptyState, loadingWrap, pageHeading, card, cardReviseBtn, CardContent, ViewToolbar, useViewMode, viewHeaderRow, reviseBtn, renameBtn } from './viewShared';
import { parseSections } from './parseSections';
import { useQuery } from '@tanstack/react-query';
import { CollapsibleDiagram } from '../MermaidDiagram';
import { buildRelationshipGraph } from '../../../shared/diagram-builders';
import NamingPanel from '../NamingPanel';
import InspirationPicker from '../InspirationPicker';
import type { CSSProperties } from 'react';
import { useFileRevision } from '@/web/hooks/useFileRevision';

interface Props {
  projectId: string;
}

/** 角色卡片网格。 */
const charGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
`;

/** 卡片头部：角色类型徽标 + 姓名。 */
const charHeader = css`
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.75rem;
  padding-bottom: 0.6rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

/** 角色类型徽标。 */
const roleBadge = css`
  display: inline-block;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  color: white;
  letter-spacing: 0.02em;
`;

/** 角色姓名。 */
const charName = css`
  font-size: 1rem;
  font-weight: 600;
  color: var(--haze-color-text);
`;

/** 角色字段网格：单列排布（角色档案多为段落式子节，两列会截断）。 */
const charFields = css`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.4rem;
`;

const charNameEmpty = css`
  opacity: 0.55;
  font-weight: 400;
`;

/** 子节标题（外貌/性格/背景等）。 */
const subTitle = css`
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  margin-top: 0.5rem;
  margin-bottom: 0.2rem;
  padding-bottom: 0.15rem;
  border-bottom: 1px dashed var(--haze-color-border);
`;

/** 需要强调的关键字段已移除：markdown 渲染模式下不再做逐字段着色。 */

type RoleKind = 'hero' | 'villain' | 'support';

interface RoleStyle {
  kind: RoleKind;
  color: string;
  label: string;
}

/** 根据分组标题推断角色类型。 */
function detectRole(title: string): RoleStyle {
  if (title.includes('反派')) {
    return { kind: 'villain', color: 'var(--haze-color-error, #ef4444)', label: '反派' };
  }
  if (title.includes('主角')) {
    return { kind: 'hero', color: 'var(--haze-color-primary)', label: '主角' };
  }
  return { kind: 'support', color: 'var(--haze-color-warning, #f59e0b)', label: title.includes('配角') ? '配角' : title };
}

/** 命名工具切换按钮。 */
const namingToggleBtn = css`
  font-size: 0.75rem;
  color: var(--haze-color-primary);
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
  cursor: pointer;
  &:hover { background: var(--haze-color-bg-hover, rgba(255,255,255,0.05)); }
`;

/** 灵感按钮切换：与 namingToggleBtn 同尺寸。 */
const inspireToggleBtn = css`
  font-size: 0.75rem;
  background: none;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
  cursor: pointer;
  &:hover { background: var(--haze-color-bg-hover, rgba(255,255,255,0.05)); }
`;

export default function CharacterView({ projectId }: Props) {
  const [showNaming, setShowNaming] = useState(false);
  const [showInspiration, setShowInspiration] = useState(false);
  const { data, isLoading } = useNovelFile(projectId, 'characters', 'characters/profiles.md');

  // 额外读取 state.json 获取角色关系数据
  const { data: stateData } = useQuery({
    queryKey: ['novel-file', projectId, 'state-json'],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent('state.json')}`);
      if (!res.ok) return null;
      const wrapper = await res.json();
      try { return JSON.parse(wrapper.content); } catch { return null; }
    },
  });
  const relGraph = stateData?.characters ? buildRelationshipGraph(stateData.characters) : null;
  const [viewMode, setViewMode] = useViewMode();
  const revision = useFileRevision({ projectId, targetFile: 'characters/profiles.md', stage: 'characters' });

  const sections = useMemo(() => (data ? parseSections(data).sections : []), [data]);

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!data) return <EmptyState message="尚未创建角色。" command="/characters" />;
  if (sections.length === 0) {
    return (
      <div>
        <h3 className={pageHeading}>角色</h3>
        <EmptyState message="角色档案暂无结构化内容。" command="/characters" />
      </div>
    );
  }

  return (
    <div>
      <div className={viewHeaderRow}>
        <h3 className={pageHeading}>角色</h3>
        <button className={reviseBtn} onClick={() => revision.openRevise()}>✎ 修订</button>
        <button className={renameBtn} onClick={() => revision.openRename()}>⇄ 重命名</button>
        <button
          className={namingToggleBtn}
          onClick={() => setShowNaming((v) => !v)}
        >
          {showNaming ? '▾ 收起起名工具' : '▸ 起名工具'}
        </button>
        <button
          className={inspireToggleBtn}
          onClick={() => setShowInspiration((v) => !v)}
        >
          {showInspiration ? '▾ 收起灵感' : '💡 灵感'}
        </button>
        <ViewToolbar mode={viewMode} onChange={setViewMode} />
      </div>
      {showNaming && <NamingPanel projectId={projectId} />}
      {showInspiration && <InspirationPicker />}
      <CollapsibleDiagram chart={relGraph} title="人物关系" />
      <div className={charGrid}>
        {sections.map((s, i) => {
          const role = detectRole(s.title);
          // 从标题提取角色名："一、姓名（主角）" → "姓名"
          const titleName = s.title.replace(/^[一二三四五六七八九十\d]+[、.)\s]+/, '').replace(/[（(].*$/, '').trim();
          const name = s.fields.find((f) => f.key === '姓名')?.value || titleName;
          const cardStyle: CSSProperties = { borderLeft: `3px solid ${role.color}` };

          const hasDirect = !!s.rawMd.trim();
          const hasSubs = s.subsections.length > 0;

          return (
            <div key={i} className={card} style={cardStyle}>
              <div className={charHeader}>
                <span className={roleBadge} style={{ background: role.color }}>{role.label}</span>
                {name && <span className={charName}>{name}</span>}
                <button className={cardReviseBtn} onClick={() => revision.openRevise(undefined, s.title)} title="修订这一组">✎</button>
                <button className={cardReviseBtn} onClick={() => revision.openRename()} title="重命名">⇄</button>
              </div>
              <div className={charFields}>
                {hasDirect || hasSubs ? (
                  <>
                    {hasDirect && <CardContent rawMd={s.rawMd} mode={viewMode} projectId={projectId} />}
                    {s.subsections.map((sub, j) => (
                      <div key={`sub${j}`}>
                        <div className={subTitle}>{sub.title}</div>
                        <CardContent rawMd={sub.rawMd} mode={viewMode} projectId={projectId} />
                      </div>
                    ))}
                  </>
                ) : (
                  <span className={cx(charName, charNameEmpty)}>暂无字段</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {revision.renameDialog}
    </div>
  );
}
