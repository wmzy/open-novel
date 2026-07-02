import { useMemo } from 'react';
import { css } from '@linaria/core';
import { useNovelFile, EmptyState, loadingWrap, pageHeading, card, renderBlock } from './viewShared';
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

/** 角色字段网格：两列排布"标签：值"。 */
const charFields = css`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.4rem 1rem;
`;

/** 需要强调的关键字段（性格等核心特征 + 驱动冲突的动机类字段）。 */
const EMPHASIZED_KEYS = new Set(['性格', '目标', '冲突', '动机', '弱点', '后果']);

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
      <h3 className={pageHeading}>角色</h3>
      <div className={charGrid}>
        {sections.map((s, i) => {
          const role = detectRole(s.title);
          const name = s.fields.find((f) => f.key === '姓名')?.value;
          // 头部展示姓名，因此字段区不再重复"姓名"
          const rest = {
            fields: s.fields.filter((f) => f.key !== '姓名'),
            items: s.items,
            ordered: s.ordered,
            body: s.body,
          };
          const cardStyle: CSSProperties = { borderLeft: `3px solid ${role.color}` };
          // 关键字段用对应角色色高亮
          const emphasize = (key: string): CSSProperties | undefined =>
            EMPHASIZED_KEYS.has(key) ? { color: role.color, fontWeight: 500 } : undefined;

          return (
            <div key={i} className={card} style={cardStyle}>
              <div className={charHeader}>
                <span className={roleBadge} style={{ background: role.color }}>{role.label}</span>
                {name && <span className={charName}>{name}</span>}
              </div>
              <div className={charFields}>
                {rest.fields.length > 0 || rest.items.length > 0 || rest.body.length > 0 || rest.ordered.length > 0 ? (
                  renderBlock(rest, emphasize)
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
