/**
 * 大纲元数据：结构化存储三幕分界与每章视点角色。
 * 供 diagram-builders 派生三幕节奏图与视点轮换图。
 */

export interface ChapterPov {
  chapter: number;
  pov: string;
}

export interface OutlineMeta {
  /** [第一幕结束章, 第二幕结束章]；第三幕从 actBreaks[1]+1 到末尾。 */
  actBreaks: [number, number];
  chapters: ChapterPov[];
}

/** 解析未知来源的 outline-meta.json，校验失败返回 null。 */
export function parseOutlineMeta(raw: unknown): OutlineMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const ab = obj.actBreaks;
  if (!Array.isArray(ab) || ab.length < 2 || typeof ab[0] !== 'number' || typeof ab[1] !== 'number') {
    return null;
  }
  const ch = obj.chapters;
  if (!Array.isArray(ch)) return null;
  const chapters: ChapterPov[] = [];
  for (const c of ch) {
    if (c && typeof c === 'object') {
      const co = c as Record<string, unknown>;
      if (typeof co.chapter === 'number' && typeof co.pov === 'string') {
        chapters.push({ chapter: co.chapter, pov: co.pov });
      }
    }
  }
  if (chapters.length === 0) return null;
  return { actBreaks: [ab[0], ab[1]], chapters };
}

/** 按章节数生成默认大纲元数据骨架（与 template-generator planActs 一致）。 */
export function defaultOutlineMeta(chapterCount: number): OutlineMeta {
  const n = Math.max(1, chapterCount);
  const act1End = Math.max(1, Math.round(n * 0.25));
  const act3Start = n - Math.max(1, Math.round(n * 0.25)) + 1;
  return {
    actBreaks: [act1End, Math.max(act1End + 1, act3Start - 1)],
    chapters: Array.from({ length: n }, (_, i) => ({ chapter: i + 1, pov: '' })),
  };
}
