import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveNovelDir } from '../../shared/project-dir';
import {
  parseOutlineChapters,
  buildStoryTimeline,
  buildRelationshipGraph,
  type OutlineChapter,
} from '../../shared/diagram-builders';
import { getAgentDef } from '../../agent/registry';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler, createJsonEventHandler } from '../../agent/stream-parser';
import type { StreamEvent, RuntimeAgentDef } from '../../agent/types';
import { buildFillPrompt, parseAiResponse, type FillChapterInput } from '../../agent/timeline-filler';

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

/** 返回角色关系图 mermaid 源码（从 state.json.characters[].relationships 生成）。 */
timelineRouter.get('/:id/character-graph', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  let stateRaw: string;
  try {
    stateRaw = await readFile(path.join(novelDir, 'state.json'), 'utf-8');
  } catch {
    return c.json({ graph: null });
  }
  const parsed = JSON.parse(stateRaw) as {
    characters?: Array<{ name?: string; relationships?: Record<string, string> }>;
  };
  const chars = (parsed.characters || [])
    .filter((ch): ch is { name: string; relationships: Record<string, string> } =>
      typeof ch.name === 'string' && !!ch.relationships)
    .map((ch) => ({ name: ch.name, relationships: ch.relationships }));
  return c.json({ graph: buildRelationshipGraph(chars) });
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

/**
 * SSE：批量预填所有缺「角色交互」字段的章节。
 * 逐章调 AI，每章完成后推送进度；已有字段的跳过。仅支持 CLI agent（非 ACP）。
 */
timelineRouter.post('/:id/fill', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  const agentId = c.req.query('agent') || 'claude';
  const def = getAgentDef(agentId);
  if (!def) return c.json({ error: `agent not found: ${agentId}` }, 400);
  if (def.usesAcp) {
    return c.json({ error: '批量预填暂不支持 ACP agent，请用 claude 等 CLI agent' }, 400);
  }

  let outline: string;
  try {
    outline = await readFile(path.join(novelDir, 'outline-detailed.md'), 'utf-8');
  } catch {
    return c.json({ error: 'outline-detailed.md not found' }, 404);
  }

  const chapters = parseOutlineChapters(outline);
  // 过滤出无「角色交互」字段的章节
  const toFill: OutlineChapter[] = [];
  for (const ch of chapters) {
    const existing = extractChapterField(outline, ch.number, '角色交互');
    if (!existing) toFill.push(ch);
  }

  return stream(c, async (streamWriter) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const filled: number[] = [];
    const failed: Array<{ chapter: number; message: string }> = [];

    const send = (obj: unknown) =>
      streamWriter.write(`data: ${JSON.stringify(obj)}\n\n`);

    send({ type: 'plan', total: toFill.length, skipped: chapters.length - toFill.length });

    for (const ch of toFill) {
      try {
        const input: FillChapterInput = {
          number: ch.number,
          title: ch.title,
          pov: ch.pov,
          coreEvent: extractChapterField(outline, ch.number, '核心事件'),
          cast: ch.cast,
        };
        const prompt = buildFillPrompt(input);
        const aiResponse = await callAgentOnce(def, prompt, novelDir);
        const interaction = parseAiResponse(aiResponse);

        if (interaction) {
          outline = replaceChapterInteraction(outline, ch.number, interaction) || outline;
          filled.push(ch.number);
          send({ type: 'progress', chapter: ch.number, filled: filled.length, total: toFill.length });
        } else {
          failed.push({ chapter: ch.number, message: 'AI 输出无法解析' });
        }
      } catch (e) {
        failed.push({ chapter: ch.number, message: (e as Error)?.message || 'unknown error' });
      }
    }

    // 一次性写回大纲
    if (filled.length > 0) {
      try {
        await writeFile(path.join(novelDir, 'outline-detailed.md'), outline, 'utf-8');
      } catch (e) {
        failed.push({ chapter: -1, message: `写回大纲失败: ${(e as Error)?.message}` });
      }
    }

    send({ type: 'done', filled, failed });
  });
});

/** 单次调 AI 取文本响应（同步等完）。复用 launchAgent + stream 解析。 */
async function callAgentOnce(def: RuntimeAgentDef, prompt: string, cwd: string): Promise<string> {
  const { child } = launchAgent(def, prompt, cwd, [], undefined);
  return new Promise((resolve, reject) => {
    let output = '';
    const onEvent = (event: StreamEvent) => {
      if (event.type === 'text_delta') output += String(event.delta || '');
    };
    const handler =
      def.streamFormat === 'claude-stream-json'
        ? createClaudeStreamHandler(onEvent)
        : createJsonEventHandler(onEvent);

    child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
    // 排空 stderr，避免背压
    child.stderr?.on('data', () => {});
    child.on('close', (code) => {
      handler.flush();
      if (code === 0) resolve(output);
      else reject(new Error(`agent exited with code ${code}`));
    });
    child.on('error', (e) => reject(e));
  });
}

export default timelineRouter;
