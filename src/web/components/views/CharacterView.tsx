import { useMemo } from 'react';
import { css } from '@linaria/core';
import { useNovelFile, EmptyState, loadingWrap, pageHeading, card, CardContent, ViewToolbar, useViewMode, viewHeaderRow } from './viewShared';
import { parseSections } from './parseSections';
import type { CSSProperties } from 'react';

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

export default function CharacterView({ projectId }: Props) {
  const { data, isLoading } = useNovelFile(projectId, 'characters', 'characters/profiles.md');
  const [viewMode, setViewMode] = useViewMode();

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
        <ViewToolbar mode={viewMode} onChange={setViewMode} />
      </div>
      <div className={charGrid}>
        {sections.map((s, i) => {
          const role = detectRole(s.title);
          // 从标题提取角色名："一、林冲（主角）" → "林冲"
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
              </div>
              <div className={charFields}>
                {hasDirect || hasSubs ? (
                  <>
                    {hasDirect && <CardContent rawMd={s.rawMd} mode={viewMode} />}
                    {s.subsections.map((sub, j) => (
                      <div key={`sub${j}`}>
                        <div className={subTitle}>{sub.title}</div>
                        <CardContent rawMd={sub.rawMd} mode={viewMode} />
                      </div>
                    ))}
                  </>
                ) : (
                  <span className={charName} style={{ opacity: 0.55, fontWeight: 400 }}>暂无字段</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
