import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { readFile, writeFile, readdir } from 'node:fs/promises';
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

/** 读取 outline/chapters/ 目录全部章节卡片，按章号排序。 */
async function readAllChapterCards(
  novelDir: string,
): Promise<Array<{ number: number; content: string }>> {
  const chaptersDir = path.join(novelDir, 'outline', 'chapters');
  let files: string[];
  try {
    files = await readdir(chaptersDir);
  } catch {
    return [];
  }
  const chapterFiles = files
    .filter((f) => /^第\d+章\.md$/.test(f))
    .map((f) => ({ file: f, num: parseInt(f.match(/\d+/)?.[0] ?? '0', 10) }))
    .sort((a, b) => a.num - b.num);

  const result: Array<{ number: number; content: string }> = [];
  for (const { file, num } of chapterFiles) {
    try {
      const content = await readFile(path.join(chaptersDir, file), 'utf-8');
      result.push({ number: num, content });
    } catch { /* skip */ }
  }
  return result;
}

/**
 * 返回 timeline 源码 + 各章交互字段原文。
 * sequenceDiagram 源码由前端按需生成（便于修正后即时重渲染）。
 */
timelineRouter.get('/:id/timeline', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  const cards = await readAllChapterCards(novelDir);
  if (cards.length === 0) {
    return c.json({ timelines: null, chapters: [] });
  }

  const allChapters: OutlineChapter[] = [];
  const chapterInteractions: Array<{ number: number; title: string; interaction: string }> = [];

  for (const card of cards) {
    const parsed = parseOutlineChapters(card.content);
    for (const ch of parsed) {
      allChapters.push(ch);
      const interaction = extractChapterField(card.content, '角色交互');
      chapterInteractions.push({ number: ch.number, title: ch.title, interaction });
    }
  }

  const timelines = buildStoryTimeline(allChapters);
  return c.json({ timelines, chapters: chapterInteractions });
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

/** 从单章卡片内容提取某字段值（如「角色交互」「核心事件」「出场角色」），
 * 支持表格格式 `| field | value |` 和 bullet 格式 `- **field**：value`。 */
export function extractChapterField(chapterContent: string, field: string): string {
  const lines = chapterContent.split('\n');
  const tableRe = new RegExp(`^\\|\\s*${field}\\s*\\|\\s*(.+?)\\s*\\|`);
  const bulletRe = new RegExp(`^[-*]\\s*\\*\\*${field}\\*\\*[：:]\\s*(.+)`);
  for (const line of lines) {
    const tableM = line.match(tableRe);
    if (tableM) return tableM[1].trim();
    const bulletM = line.match(bulletRe);
    if (bulletM) return bulletM[1].trim();
  }
  return '';
}

/**
 * 替换或插入单章卡片的「角色交互」字段。
 * - 表格格式：已有 → 替换；无 → 在「出场角色」行后插入；若无则追加到末尾
 * - bullet 格式：同上逻辑
 * 返回更新后的全文；无法插入返回 null。
 */
export function replaceChapterInteraction(
  chapterContent: string,
  interaction: string,
): string | null {
  const lines = chapterContent.split('\n');

  let interactionLineIdx = -1;
  let castLineIdx = -1;
  let lastTableIdx = -1;
  let lastBulletIdx = -1;

  for (let j = 0; j < lines.length; j++) {
    if (/^\|/.test(lines[j])) {
      lastTableIdx = j;
      if (/^\|\s*角色交互\s*\|/.test(lines[j])) interactionLineIdx = j;
      if (/^\|\s*出场角色\s*\|/.test(lines[j])) castLineIdx = j;
    }
    if (/^[-*]\s*\*\*/.test(lines[j])) {
      lastBulletIdx = j;
      if (/^[-*]\s*\*\*角色交互\*\*/.test(lines[j])) interactionLineIdx = j;
      if (/^[-*]\s*\*\*出场角色\*\*/.test(lines[j])) castLineIdx = j;
    }
  }

  // 判断使用表格还是 bullet 格式
  const useTable = lastTableIdx >= 0 && (interactionLineIdx >= 0 && /^\|/.test(lines[interactionLineIdx])
    || castLineIdx >= 0 && /^\|/.test(lines[castLineIdx])
    || lastBulletIdx < 0);

  const newLine = useTable
    ? `| 角色交互 | ${interaction} |`
    : `- **角色交互**：${interaction}`;

  if (interactionLineIdx >= 0) {
    lines[interactionLineIdx] = newLine;
  } else if (castLineIdx >= 0) {
    lines.splice(castLineIdx + 1, 0, newLine);
  } else if (useTable && lastTableIdx >= 0) {
    lines.splice(lastTableIdx + 1, 0, newLine);
  } else if (!useTable && lastBulletIdx >= 0) {
    lines.splice(lastBulletIdx + 1, 0, newLine);
  } else {
    // 追加到末尾
    lines.push(newLine);
  }

  return lines.join('\n');
}

/**
 * 修正单章「角色交互」字段，写回单章卡片文件。
 */
timelineRouter.put('/:id/interaction', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  const body = await c.req.json();
  const { chapter, interaction } = body as { chapter: number; interaction: string };
  if (typeof chapter !== 'number' || typeof interaction !== 'string') {
    return c.json({ error: 'chapter and interaction are required' }, 400);
  }

  const chapterPath = path.join(novelDir, 'outline', 'chapters', `第${chapter}章.md`);
  let content: string;
  try {
    content = await readFile(chapterPath, 'utf-8');
  } catch {
    return c.json({ error: `第${chapter}章大纲文件未找到` }, 404);
  }

  const updated = replaceChapterInteraction(content, interaction);
  if (updated === null) {
    return c.json({ error: `第${chapter}章无法更新` }, 404);
  }

  await writeFile(chapterPath, updated, 'utf-8');
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

  const cards = await readAllChapterCards(novelDir);
  if (cards.length === 0) {
    return c.json({ error: 'outline/chapters/ 目录为空或不存在' }, 404);
  }

  // 解析全部章节，过滤出无「角色交互」字段的
  const toFill: Array<{ card: { number: number; content: string }; chapter: OutlineChapter }> = [];
  for (const card of cards) {
    const parsed = parseOutlineChapters(card.content);
    for (const ch of parsed) {
      const existing = extractChapterField(card.content, '角色交互');
      if (!existing) {
        toFill.push({ card, chapter: ch });
      }
    }
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

    send({ type: 'plan', total: toFill.length, skipped: cards.length - toFill.length });

    for (const item of toFill) {
      const { card, chapter: ch } = item;
      try {
        const input: FillChapterInput = {
          number: ch.number,
          title: ch.title,
          pov: ch.pov,
          coreEvent: extractChapterField(card.content, '核心事件'),
          cast: ch.cast,
        };
        const prompt = buildFillPrompt(input);
        const aiResponse = await callAgentOnce(def, prompt, novelDir);
        const interaction = parseAiResponse(aiResponse);

        if (interaction) {
          const updated = replaceChapterInteraction(card.content, interaction);
          if (updated) {
            const chapterPath = path.join(novelDir, 'outline', 'chapters', `第${card.number}章.md`);
            await writeFile(chapterPath, updated, 'utf-8');
            card.content = updated; // 后续迭代用更新后的内容
          }
          filled.push(ch.number);
          send({ type: 'progress', chapter: ch.number, filled: filled.length, total: toFill.length });
        } else {
          failed.push({ chapter: ch.number, message: 'AI 输出无法解析' });
        }
      } catch (e) {
        failed.push({ chapter: ch.number, message: (e as Error)?.message || 'unknown error' });
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
