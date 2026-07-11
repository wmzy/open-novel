import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { css, cx } from '@linaria/core';
import { useQueries } from '@tanstack/react-query';
import {
  useNovelFile,
  useNovelFileList,
  EmptyState,
  loadingWrap,
  pageHeading,
  card,
  cardTitle,
  cardTitleText,
  cardReviseBtn,
  reviseBtn,
  renameBtn,
  isSectionEmpty,
  CardContent,
  ViewToolbar,
  useViewMode,
  viewHeaderRow,
} from './viewShared';
import { parseSections } from './parseSections';
import type { MdSection } from './parseSections';
import InlineInspiration from '../InlineInspiration';
import { useFileRevision } from '@/web/hooks/useFileRevision';
import { DEEPEN_TO_CHAT_EVENT } from '@/shared/deepen';

interface Props {
  projectId: string;
}

/**
 * 武侠专属设定仪表盘。
 *
 * 架构说明（双数据源）：
 * 1. `.novel/wuxia/` 独立文件（旧工具迁移项目，如 martial-arts.md / weapons.md /
 *    sects.md / sects/*.md）——按文件内容归类到「功法体系 / 神兵利器 / 势力总览 /
 *    势力详情」，优先展示。
 * 2. `world-building.md` 的武侠维度 `##` 节（与 WorldView 差异化聚焦） +
 *    `characters/profiles.md` 的武学路数——补充与新项目兼容。
 */

/**
 * 武侠设定维度：按标题关键词从 world-building 筛选对应 `##` 分组。
 * 维度与 plugins/wuxia/templates/world-building.md 的 `##` 节 1:1 对齐，
 * 顺序亦与模板一致（时代背景 → … → 历史恩怨）。
 * 「神兵利器」独立成维，与旧版 novel-wuxia 的「兵器谱」章呼应；
 * 「武功体系」不再吞并兵器关键词。
 */
const DIMENSIONS: Array<{ keys: string[]; title: string; color: string; hint: string }> = [
  {
    keys: ['时代背景', '时代', '朝代', '年代'],
    title: '时代背景',
    color: '#64748b',
    hint: '朝代、社会状况、武林大势之根基',
  },
  {
    keys: ['江湖格局', '门派', '势力', '格局'],
    title: '门派江湖',
    color: '#8b5cf6',
    hint: '门派架构、正邪中立势力、江湖格局',
  },
  {
    keys: ['武功体系', '武功', '武学', '内力', '功法', '招式', '轻功'],
    title: '武功体系',
    color: '#f97316',
    hint: '内功外功、招式轻功、力量分层与代价',
  },
  {
    keys: ['百工', '技艺', '锻造', '火药', '机关', '医术'],
    title: '百工技艺',
    color: '#0ea5e9',
    hint: '冶金火药、机关医毒——武能的天花板',
  },
  {
    keys: ['神兵', '兵器', '利器', '名剑', '名刀'],
    title: '神兵利器',
    color: '#ef4444',
    hint: '兵器谱、神兵来历、持有者与特殊能力',
  },
  {
    keys: ['重要地点', '地点', '地理'],
    title: '重要地点',
    color: '#10b981',
    hint: '关键场所、势力所在、地理格局',
  },
  {
    keys: ['江湖规矩', '规矩', '戒律', '道义'],
    title: '江湖规矩',
    color: '#14b8a6',
    hint: '道义准则、江湖铁律、两难抉择',
  },
  {
    keys: ['历史恩怨', '恩怨', '渊源', '旧仇'],
    title: '历史恩怨',
    color: '#a16207',
    hint: '门派渊源、世仇旧约、未解之恨',
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

/** 角色武学路数维度标题：固定青色，区别于其它维度的动态色。 */
const martialDimTitle = css`
  color: #0ea5e9;
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

// ── .novel/wuxia/ 独立文件归类 ───────────────────────────────────────

interface WuxiaFileItem {
  title: string;
  rawMd: string;
  /** 相对 .novel/ 的源文件路径，用于卡片级修订/重命名定位。 */
  filePath: string;
}

interface WuxiaGroup {
  key: string;
  title: string;
  color: string;
  hint: string;
  items: WuxiaFileItem[];
}

/** wuxia/ 文件分组的元数据（顺序即展示顺序）。 */
const WUXIA_GROUP_META: Array<{ key: string; title: string; color: string; hint: string }> = [
  { key: 'martial', title: '功法体系', color: '#f97316', hint: '武学体系、内力招式、轻功身法' },
  { key: 'weapon', title: '神兵利器', color: '#ef4444', hint: '兵器谱、装备、甲胄工具' },
  { key: 'sect-overview', title: '势力总览', color: '#8b5cf6', hint: '江湖格局、势力生态、利益纠葛' },
  { key: 'sect-detail', title: '势力详情', color: '#a855f7', hint: '各势力档案：地盘、钱脉、弱点' },
  { key: 'other', title: '其它设定', color: '#64748b', hint: '未归类的武侠设定文件' },
];

/** 文件名（去扩展名）作为展示名。 */
function fileDisplayName(path: string): string {
  return path.split('/').pop()!.replace(/\.md$/, '');
}

/**
 * 把 `.novel/wuxia/` 下的已加载文件归类成展示分组。
 * - martial/weapon/sect-overview：拆成文件内 `##` 节作为独立卡片；
 * - sect-detail/other：每个文件整篇作为一张卡片。
 */
function categorizeWuxiaFiles(files: { path: string; content: string }[]): WuxiaGroup[] {
  const buckets: Record<string, WuxiaFileItem[]> = {
    martial: [],
    weapon: [],
    'sect-overview': [],
    'sect-detail': [],
    other: [],
  };
  for (const f of files) {
    const parsed = parseSections(f.content);
    const title = parsed.title || fileDisplayName(f.path);
    const hint = `${title} ${f.path}`;
    let cat: keyof typeof buckets;
    if (f.path.startsWith('wuxia/sects/')) cat = 'sect-detail';
    else if (f.path === 'wuxia/sects.md') cat = 'sect-overview';
    else if (/martial|功法|武功|武学/.test(hint)) cat = 'martial';
    else if (/weapon|兵器|神兵|兵刃/.test(hint)) cat = 'weapon';
    else if (/sect|门派|势力|江湖/.test(hint)) cat = 'sect-overview';
    else cat = 'other';

    if (cat === 'sect-detail' || cat === 'other') {
      buckets[cat].push({ title, rawMd: f.content, filePath: f.path });
    } else if (parsed.sections.length === 0) {
      buckets[cat].push({ title, rawMd: f.content, filePath: f.path });
    } else {
      for (const s of parsed.sections) {
        buckets[cat].push({ title: s.title, rawMd: s.fullRawMd, filePath: f.path });
      }
    }
  }
  return WUXIA_GROUP_META.map((g) => ({ ...g, items: buckets[g.key] ?? [] }));
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
  const revision = useFileRevision({ projectId, targetFile: '', stage: 'wuxia' });

  // .novel/wuxia/ 独立文件（旧工具迁移项目）
  const { data: fileList } = useNovelFileList(projectId);
  const wuxiaPaths = useMemo(
    () => (fileList ?? []).filter((f) => f.startsWith('wuxia/') && f.endsWith('.md')),
    [fileList],
  );
  const wuxiaQueries = useQueries({
    queries: wuxiaPaths.map((p) => ({
      queryKey: ['novel-file', projectId, `wuxia-file-${p}`],
      queryFn: async () => {
        const res = await fetch(
          `/api/projects/${projectId}/files?path=${encodeURIComponent(p)}`,
        );
        if (!res.ok) return null;
        const data = await res.json();
        return { path: p, content: data.content as string };
      },
      staleTime: 30_000,
    })),
  });
  const wuxiaLoadedCount = wuxiaQueries.filter((q) => q.data !== undefined).length;
  const wuxiaGroups = useMemo(
    () =>
      categorizeWuxiaFiles(
        wuxiaQueries
          .map((q) => q.data)
          .filter((d): d is { path: string; content: string } => !!d),
      ),
    // 仅在加载进度变化时重算（避免 useQueries 数组引用变化导致的频繁重算）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wuxiaLoadedCount],
  );
  const hasWuxiaFiles = wuxiaGroups.some((g) => g.items.length > 0);

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
  if (!worldData && !charData && !hasWuxiaFiles) {
    return <EmptyState message="尚未创建武侠设定。" command="/world" />;
  }

  const hasWorldDim = dimensions.some((d) => d.sections.length > 0);
  const hasChars = martialChars.length > 0;

  return (
    <div>
      <div className={viewHeaderRow}>
        <h3 className={pageHeading}>武侠</h3>
        <button className={reviseBtn} onClick={() => revision.openRevise('world-building.md')} title="修订世界观/武侠设定">✎ 修订</button>
        <button className={renameBtn} onClick={() => revision.openRename('world-building.md')} title="重命名">⇄ 重命名</button>
        <button
          className={reviseBtn}
          onClick={() => window.dispatchEvent(new CustomEvent(DEEPEN_TO_CHAT_EVENT, { detail: { stage: 'world' } }))}
          title="自主循环深化武侠设定阶段"
        >🔁 深化</button>
        <ViewToolbar mode={viewMode} onChange={setViewMode} />
      </div>

      {!hasWorldDim && !hasChars && !hasWuxiaFiles && (
        <EmptyState message="世界观与角色档案中暂无可识别的武侠维度内容。" command="/world" />
      )}

      {/* 武侠设定库（来自 .novel/wuxia/ 独立文件，旧工具迁移项目） */}
      {wuxiaGroups.map((group) => {
        if (group.items.length === 0) return null;
        return (
          <div key={group.key}>
            <div className={dimHeading}>
              <span className={dimTitle} style={{ color: group.color } as CSSProperties}>
                {group.title}
              </span>
              <span className={dimHint}>{group.hint}</span>
            </div>
            <div className={dimGrid}>
              {group.items.map((item, i) => (
                <div
                  key={`${group.key}-${i}`}
                  className={card}
                  style={{ borderLeft: `3px solid ${group.color}` } as CSSProperties}
                >
                  <div className={cardTitle}>
                    <span className={cardTitleText}>{item.title}</span>
                    <button className={cardReviseBtn} onClick={() => revision.openRevise(item.filePath, item.title)} title="修订这一节">✎</button>
                    <button className={cardReviseBtn} onClick={() => revision.openRename(item.filePath)} title="重命名">⇄</button>
                    {group.key === 'sect-detail' && (
                      <InlineInspiration mode="generate-in-faction" factionName={item.title} />
                    )}
                  </div>
                  <CardContent rawMd={item.rawMd} mode={viewMode} projectId={projectId} />
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {hasWuxiaFiles && (hasWorldDim || hasChars) && <hr className={divider} />}

      {/* 世界观武侠维度（来自 world-building.md） */}
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
                    <div className={cardTitle}>
                      <span className={cardTitleText}>{s.title}</span>
                      <button className={cardReviseBtn} onClick={() => revision.openRevise('world-building.md', s.title)} title="修订这一节">✎</button>
                      <button className={cardReviseBtn} onClick={() => revision.openRename('world-building.md')} title="重命名">⇄</button>
                    </div>
                    {empty ? (
                      <span className={dimEmpty}>暂无内容</span>
                    ) : (
                      <CardContent rawMd={s.fullRawMd} mode={viewMode} projectId={projectId} />
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
            <span className={cx(dimTitle, martialDimTitle)}>
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
                    <button className={cardReviseBtn} onClick={() => revision.openRevise('characters/profiles.md', c.raw.title)} title="修订这一组">✎</button>
                    <button className={cardReviseBtn} onClick={() => revision.openRename('characters/profiles.md')} title="重命名">⇄</button>
                  </div>
                  {c.subs.map((sub, j) => {
                    const empty = isSectionEmpty(sub as unknown as MdSection);
                    return (
                      <div key={j}>
                        <div className={subTitle}>{sub.title}</div>
                        {empty ? (
                          <span className={subEmpty}>暂无内容</span>
                        ) : (
                          <CardContent rawMd={sub.rawMd} mode={viewMode} projectId={projectId} />
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
      {revision.renameDialog}
    </div>
  );
}
