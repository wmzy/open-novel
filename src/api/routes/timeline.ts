import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
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

export default timelineRouter;
