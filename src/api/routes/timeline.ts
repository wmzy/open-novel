import { Hono } from 'hono';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveNovelDir } from '../../shared/project-dir';
import {
  parseOutlineChapters,
  buildStoryTimeline,
} from '../../shared/diagram-builders';

const timelineRouter = new Hono();

/**
 * 返回 timeline 源码 + 各章交互字段原文。
 * sequenceDiagram 源码由前端按需生成（便于修正后即时重渲染）。
 */
timelineRouter.get('/:id/timeline', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  let outline = '';
  try {
    outline = await readFile(path.join(novelDir, 'outline-detailed.md'), 'utf-8');
  } catch {
    return c.json({ timeline: null, chapters: [] });
  }

  const chapters = parseOutlineChapters(outline);
  const timeline = buildStoryTimeline(chapters);

  // 提取每章的「角色交互」字段原文（用于前端生成 sequenceDiagram）
  const chapterInteractions = chapters.map((ch) => {
    const interaction = extractChapterField(outline, ch.number, '角色交互');
    return { number: ch.number, title: ch.title, interaction };
  });

  return c.json({ timeline, chapters: chapterInteractions });
});

/** 从大纲全文提取第 N 章某字段值（如「角色交互」「核心事件」「出场角色」），无则返回空串。 */
export function extractChapterField(outline: string, chapter: number, field: string): string {
  const lines = outline.split('\n');
  const anchorRe = /^####\s+第([\d]+)(?:-[\d]+)?章/;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(anchorRe);
    if (m && parseInt(m[1], 10) === chapter) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return '';
  const fieldRe = new RegExp(`^\\|\\s*${field}\\s*\\|\\s*(.+?)\\s*\\|`);
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^#{3,4}\s/.test(lines[j])) break;
    const m = lines[j].match(fieldRe);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * 替换或插入第 N 章的「角色交互」行。
 * - 已有「角色交互」行 → 替换
 * - 无 → 在「出场角色」行后插入；若无出场角色行则追加到表格末尾
 * 返回更新后的全文；章号不存在返回 null。
 */
export function replaceChapterInteraction(
  outline: string,
  chapter: number,
  interaction: string,
): string | null {
  const lines = outline.split('\n');
  const anchorRe = /^####\s+第([\d]+)(?:-[\d]+)?章/;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(anchorRe);
    if (m && parseInt(m[1], 10) === chapter) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  // 找该章表格范围（到下一个 #### 或 ###）
  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^#{3,4}\s/.test(lines[j])) {
      endIdx = j;
      break;
    }
  }

  let interactionLineIdx = -1;
  let castLineIdx = -1;
  let lastTableRowIdx = -1;
  for (let j = startIdx + 1; j < endIdx; j++) {
    if (/^\|/.test(lines[j])) {
      lastTableRowIdx = j;
      if (/^\|\s*角色交互\s*\|/.test(lines[j])) interactionLineIdx = j;
      if (/^\|\s*出场角色\s*\|/.test(lines[j])) castLineIdx = j;
    }
  }

  const newLine = `| 角色交互 | ${interaction} |`;

  if (interactionLineIdx >= 0) {
    lines[interactionLineIdx] = newLine;
  } else if (castLineIdx >= 0) {
    lines.splice(castLineIdx + 1, 0, newLine);
  } else if (lastTableRowIdx >= 0) {
    lines.splice(lastTableRowIdx + 1, 0, newLine);
  } else {
    return null;
  }

  return lines.join('\n');
}

/**
 * 修正单章「角色交互」字段，写回大纲 md。
 */
timelineRouter.put('/:id/interaction', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  const body = await c.req.json();
  const { chapter, interaction } = body as { chapter: number; interaction: string };
  if (typeof chapter !== 'number' || typeof interaction !== 'string') {
    return c.json({ error: 'chapter and interaction are required' }, 400);
  }

  const outlinePath = path.join(novelDir, 'outline-detailed.md');
  let outline: string;
  try {
    outline = await readFile(outlinePath, 'utf-8');
  } catch {
    return c.json({ error: 'outline-detailed.md not found' }, 404);
  }

  const updated = replaceChapterInteraction(outline, chapter, interaction);
  if (updated === null) {
    return c.json({ error: `第${chapter}章未在大纲中找到` }, 404);
  }

  await writeFile(outlinePath, updated, 'utf-8');
  return c.json({ ok: true });
});

export default timelineRouter;
