import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { css } from '@linaria/core';
import {
  useNovelFile,
  EmptyState,
  loadingWrap,
  pageHeading,
  card,
  cardTitle,
  isSectionEmpty,
  CardContent,
  ViewToolbar,
  useViewMode,
  viewHeaderRow,
} from './viewShared';
import { parseSections } from './parseSections';
import type { MdSection } from './parseSections';

interface Props {
  projectId: string;
}

/**
 * 武侠专属设定仪表盘。
 *
 * 架构说明：wuxia SKILL.md 明确"武侠设定在 world-building.md，无需另建目录"，
 * 故本视图不读 `wuxia/system.md`（无阶段会生成它），而是从 world-building.md 与
 * characters/profiles.md 聚合武侠维度，与 WorldView 形成差异化聚焦。
 */

/** 武侠三大维度：按标题关键词从 world-building 筛选对应 `##` 分组。 */
const DIMENSIONS: Array<{ keys: string[]; title: string; color: string; hint: string }> = [
  {
    keys: ['力量', '武功', '武学', '兵器', '内力'],
    title: '武功体系',
    color: '#f97316',
    hint: '力量分层、招式代价、内力限制',
  },
  {
    keys: ['社会', '门派', '势力', '格局', '组织'],
    title: '门派江湖',
    color: '#8b5cf6',
    hint: '门派架构、势力消长、江湖格局',
  },
  {
    keys: ['规则', '规矩', '江湖礼', '戒律'],
    title: '江湖规矩',
    color: '#14b8a6',
    hint: '道义准则、江湖铁律、两难抉择',
  },
];

/** 角色"武学/能力"相关子节关键词。 */
const MARTIAL_SUBS = ['能力', '手段', '武功', '武学', '功法', '兵器', '师承'];

/** 维度区块标题（带色条与提示）。 */
const dimHeading = css`
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin: 1.4rem 0 0.6rem;
  &:first-of-type {
    margin-top: 0;
  }
`;

/** 维度标题文字。 */
const dimTitle = css`
  font-size: 0.95rem;
  font-weight: 700;
  padding-left: 0.5rem;
  border-left: 3px solid currentColor;
`;

/** 维度提示（小字）。 */
const dimHint = css`
  font-size: 0.72rem;
  color: var(--haze-color-text-secondary);
  opacity: 0.75;
`;

/** 维度内卡片网格。 */
const dimGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.8rem;
`;

/** 维度空态。 */
const dimEmpty = css`
  font-size: 0.8rem;
  color: var(--haze-color-text-secondary);
  opacity: 0.6;
  font-style: italic;
`;

/** 分隔线（世界设定与角色武学之间）。 */
const divider = css`
  border: none;
  border-top: 1px solid var(--haze-color-border);
  margin: 1.8rem 0 0.6rem;
`;

/** 角色武学卡片网格。 */
const martialGrid = css`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.8rem;
`;

/** 角色武学卡片头部（姓名 + 角色标签色条）。 */
const martialHeader = css`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
`;

/** 角色姓名。 */
const martialName = css`
  font-weight: 700;
  font-size: 0.9rem;
`;

/** 子节小标题（如"能力""手段"）。 */
const subTitle = css`
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--haze-color-text-secondary);
  margin-top: 0.4rem;
  margin-bottom: 0.2rem;
  padding-bottom: 0.1rem;
  border-bottom: 1px dashed var(--haze-color-border);
`;

/** 子节空态。 */
const subEmpty = css`
  font-size: 0.78rem;
  color: var(--haze-color-text-secondary);
  opacity: 0.55;
  font-style: italic;
`;

/** 从角色标题提取姓名："一、林冲（主角）" → "林冲"。 */
function extractName(title: string): string {
  return title
    .replace(/^[一二三四五六七八九十\d]+[、.)\s]+/, '')
    .replace(/[（(].*$/, '')
    .trim();
}

/** 角色标签色（主角/反派/配角）。 */
function roleColor(title: string): string {
  if (/主角|男主|女主/.test(title)) return '#0ea5e9';
  if (/反派|敌|魔/.test(title)) return '#ef4444';
  return '#64748b';
}

export default function WuxiaView({ projectId }: Props) {
  const { data: worldData, isLoading: worldLoading } = useNovelFile(
    projectId,
    'world',
    'world-building.md'
  );
  const { data: charData, isLoading: charLoading } = useNovelFile(
    projectId,
    'characters',
    'characters/profiles.md'
  );
  const [viewMode, setViewMode] = useViewMode();

  const worldSections = useMemo(
    () => (worldData ? parseSections(worldData).sections : []),
    [worldData]
  );
  const charSections = useMemo(
    () => (charData ? parseSections(charData).sections : []),
    [charData]
  );

  // 按维度筛选 world-building 分组
  const dimensions = useMemo(
    () =>
      DIMENSIONS.map((dim) => ({
        ...dim,
        sections: worldSections.filter((s) => dim.keys.some((k) => s.title.includes(k))),
      })),
    [worldSections]
  );

  // 提取角色武学子节
  const martialChars = useMemo(
    () =>
      charSections
        .map((s) => {
          const subs = s.subsections.filter((sub) =>
            MARTIAL_SUBS.some((k) => sub.title.includes(k))
          );
          return { name: extractName(s.title), subs, raw: s };
        })
        .filter((c) => c.subs.length > 0),
    [charSections]
  );

  if (worldLoading || charLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!worldData && !charData) {
    return <EmptyState message="尚未创建武侠设定。" command="/world" />;
  }

  const hasWorldDim = dimensions.some((d) => d.sections.length > 0);
  const hasChars = martialChars.length > 0;

  return (
    <div>
      <div className={viewHeaderRow}>
        <h3 className={pageHeading}>武侠</h3>
        <ViewToolbar mode={viewMode} onChange={setViewMode} />
      </div>

      {!hasWorldDim && !hasChars && (
        <EmptyState message="世界观与角色档案中暂无可识别的武侠维度内容。" command="/world" />
      )}

      {/* 武侠三大维度 */}
      {dimensions.map((dim) => {
        if (dim.sections.length === 0) return null;
        return (
          <div key={dim.title}>
            <div className={dimHeading}>
              <span className={dimTitle} style={{ color: dim.color } as CSSProperties}>
                {dim.title}
              </span>
              <span className={dimHint}>{dim.hint}</span>
            </div>
            <div className={dimGrid}>
              {dim.sections.map((s: MdSection, i: number) => {
                const cardStyle: CSSProperties = { borderLeft: `3px solid ${dim.color}` };
                const empty = isSectionEmpty(s);
                return (
                  <div key={i} className={card} style={cardStyle}>
                    <div className={cardTitle}>{s.title}</div>
                    {empty ? (
                      <span className={dimEmpty}>暂无内容</span>
                    ) : (
                      <CardContent rawMd={s.fullRawMd} mode={viewMode} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* 角色武学路数 */}
      {hasChars && (
        <>
          <hr className={divider} />
          <div className={dimHeading}>
            <span className={dimTitle} style={{ color: '#0ea5e9' } as CSSProperties}>
              角色武学路数
            </span>
            <span className={dimHint}>各角色的能力、手段、武学传承</span>
          </div>
          <div className={martialGrid}>
            {martialChars.map((c, i) => {
              const color = roleColor(c.raw.title);
              const cardStyle: CSSProperties = { borderLeft: `3px solid ${color}` };
              return (
                <div key={i} className={card} style={cardStyle}>
                  <div className={martialHeader}>
                    <span className={martialName} style={{ color } as CSSProperties}>
                      {c.name || c.raw.title}
                    </span>
                  </div>
                  {c.subs.map((sub, j) => {
                    const empty = isSectionEmpty(sub as unknown as MdSection);
                    return (
                      <div key={j}>
                        <div className={subTitle}>{sub.title}</div>
                        {empty ? (
                          <span className={subEmpty}>暂无内容</span>
                        ) : (
                          <CardContent rawMd={sub.rawMd} mode={viewMode} />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
