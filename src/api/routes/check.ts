import { Hono } from 'hono';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { resolveProjectDir } from '../../shared/project-dir';
import {
  parseForeshadowFile,
  computeForeshadowStats,
  resolveCurrentChapter,
  type Foreshadow,
} from '../../shared/foreshadow';
import {
  detectAiPatterns,
  checkForeshadows,
  detectOoc,
  readChapter,
  readChapterSummary,
  detectMechanicalFactIssues,
  buildFactCheckPrompt,
  parseFactCheckResponse,
  type FactCheckFinding,
  type RosterNameInput,
} from '../../agent/quality-checker';
import { extractChapterOutline, identifyCast } from '../../agent/chapter-context';
import {
  getStateTable,
  readCharacterKnowledge,
  readCharacterRoster,
  type CharacterKnowledge,
} from '../../agent/context-manager';
import { callAgentOnce } from '../../agent/agent-once';

const checkRouter = new Hono();

/** 宽容读取 .novel/foreshadow.json（新 schema + 旧格式迁移）；文件缺失返回空清单。 */
async function readForeshadowFile(projectDir: string): Promise<{
  foreshadows: Foreshadow[];
  migrated: boolean;
  warnings: string[];
}> {
  try {
    const raw = await readFile(path.join(projectDir, '.novel', 'foreshadow.json'), 'utf-8');
    return parseForeshadowFile(raw);
  } catch {
    return { foreshadows: [], migrated: false, warnings: [] };
  }
}

/** 读取 state.json 的 lastUpdatedChapter，缺失/损坏返回 0。 */
async function readLastUpdatedChapter(projectDir: string): Promise<number> {
  try {
    const raw = await readFile(path.join(projectDir, '.novel', 'state.json'), 'utf-8');
    const state = JSON.parse(raw) as { lastUpdatedChapter?: unknown };
    return typeof state.lastUpdatedChapter === 'number' && Number.isFinite(state.lastUpdatedChapter)
      ? state.lastUpdatedChapter
      : 0;
  } catch {
    return 0;
  }
}

/**
 * 反 AI 味检测。
 * body: { content?: string, chapterNum?: number, threshold?: number }
 * 优先使用传入的 content；否则按 chapterNum 读取章节正文。
 */
checkRouter.post('/ai-patterns', async (c) => {
  const projectId = c.req.param('projectId')!;
  let body: { content?: string; chapterNum?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // 允许空 body
  }

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  let text = typeof body.content === 'string' ? body.content : '';
  if (!text && typeof body.chapterNum === 'number') {
    text = await readChapter(projectDir, body.chapterNum);
  }
  if (!text) return c.json({ error: 'content or chapterNum is required' }, 400);

  const report = detectAiPatterns(text);
  return c.json(report);
});

/**
 * 伏笔遗忘 + 债务检测。
 * - 遗忘/提及分析：quality-checker 关键词比对（forgotten/resolved/healthy）
 * - 逾期检测：改用新 schema 的 resolveDeadline（债务系统），不再依赖提及间隔启发
 * query: threshold（连续未提及章节数阈值，默认 5，仅作用于遗忘检测）
 */
checkRouter.post('/foreshadows', async (c) => {
  const projectId = c.req.param('projectId')!;
  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const thresholdRaw = c.req.query('threshold');
  const threshold = thresholdRaw ? parseInt(thresholdRaw, 10) : undefined;
  const report = await checkForeshadows(
    projectDir,
    Number.isFinite(threshold) ? threshold : undefined,
  );

  // 债务视角：宽容解析（旧格式自动迁移），currentChapter = max(进度章, 最大埋设章, 0)
  const { foreshadows, migrated, warnings } = await readForeshadowFile(projectDir);
  const currentChapter = resolveCurrentChapter(foreshadows, await readLastUpdatedChapter(projectDir));
  let chapterCount = 0;
  try {
    const [project] = await db
      .select({ chapterCount: projects.chapterCount })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    chapterCount = project?.chapterCount ?? 0;
  } catch { /* 章节数未知：孤儿章号判定自动跳过 */ }
  const stats = computeForeshadowStats(foreshadows, currentChapter, chapterCount);

  return c.json({
    ...report,
    // 逾期（期限已过未回收）与临近到期：按 resolveDeadline 判定
    overdue: stats.overdue,
    dueSoon: stats.dueSoon,
    debtScore: stats.debtScore,
    currentChapter,
    migrated,
    warnings,
  });
});

/**
 * 人物 OOC 检测。
 * body: { chapterNum: number }
 */
checkRouter.post('/ooc', async (c) => {
  const projectId = c.req.param('projectId')!;
  let body: { chapterNum?: number } = {};
  try {
    body = await c.req.json();
  } catch {
    // 允许空 body
  }

  if (typeof body.chapterNum !== 'number') {
    return c.json({ error: 'chapterNum is required' }, 400);
  }

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const report = await detectOoc(projectDir, body.chapterNum);
  return c.json(report);
});

/** 语义核查 agent 调用超时：单章正文 + 背景上下文，给足 3 分钟。 */
const FACT_CHECK_TIMEOUT_MS = 3 * 60 * 1000;

/** 名册条目展开为「别名 → 规范角色名」的检测输入。 */
function toRosterInputs(
  roster: Array<{ name: string; aliases: string[] }>,
): RosterNameInput[] {
  const inputs: RosterNameInput[] = [];
  for (const entry of roster) {
    inputs.push({ name: entry.name, canonical: entry.name });
    for (const alias of entry.aliases) {
      inputs.push({ name: alias, canonical: entry.name });
    }
  }
  return inputs;
}

/** 事实核查结果严重度排序（阻断 → 重要 → 轻微）。 */
const FACT_SEVERITY_RANK: Record<FactCheckFinding['severity'], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

/** 机械与语义结果合并去重（同类型 + 同章节 + 同引文视为同一条）。 */
function dedupeFindings(findings: FactCheckFinding[]): FactCheckFinding[] {
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      const key = `${finding.type}|${finding.chapter}|${finding.quote}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => FACT_SEVERITY_RANK[a.severity] - FACT_SEVERITY_RANK[b.severity]);
}

/** 读取最近 N 章摘要（章节号升序拼接），供语义核查比对既有剧情。 */
async function readRecentSummaries(
  projectDir: string,
  chapterNum: number,
  count = 3,
): Promise<string> {
  const parts: string[] = [];
  for (let offset = 1; offset <= count; offset++) {
    const num = chapterNum - offset;
    const summary = await readChapterSummary(projectDir, num);
    if (summary) parts.unshift(`第${num}章：${summary}`);
  }
  return parts.join('\n\n');
}

/**
 * 写后事实核查（非阻断、只报告）：
 * - 机械检查（始终运行）：POV 知情越界启发式 + 名册人名近似笔误；
 * - 语义检查（deep=true 时）：调用一次内置 Pi，按 POV 泄漏 / 姓名别名 / 设定时间线三类返回 JSON。
 *
 * body: { chapterNum: number, agentId?: string, deep?: boolean }
 * deep 默认 true；agentId 也可用 query ?agent= 传入。
 * 返回 { chapter, pov, findings, mechanical, semantic, semanticError? }。
 * 不写任何文件，不影响样章门禁、CJK 阈值或写作锁。
 */
checkRouter.post('/fact-check', async (c) => {
  const projectId = c.req.param('projectId')!;
  let body: { chapterNum?: number; agentId?: string; deep?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    // 允许空 body（会按 chapterNum 缺失返回 400）
  }

  if (typeof body.chapterNum !== 'number' || !Number.isFinite(body.chapterNum)) {
    return c.json({ error: 'chapterNum is required' }, 400);
  }
  const chapterNum = Math.trunc(body.chapterNum);

  let projectDir: string;
  try {
    projectDir = await resolveProjectDir(projectId);
  } catch {
    return c.json({ error: 'Project not found' }, 404);
  }

  const chapterText = await readChapter(projectDir, chapterNum);
  if (!chapterText) {
    return c.json({ error: `第${chapterNum}章正文不存在` }, 404);
  }

  const outline = await extractChapterOutline(projectDir, chapterNum);
  const roster = await readCharacterRoster(projectDir);
  const cast = await identifyCast(
    projectDir,
    chapterNum,
    outline.content,
    roster.map((entry) => entry.name),
  );

  // 知情边界：专属表 + state.json 的 knows 合并（只补漏，不覆盖）
  const knowledgeTable = await readCharacterKnowledge(projectDir);
  const knowledgeEntry = cast.pov
    ? knowledgeTable.find((entry) => entry.name === cast.pov)
    : undefined;
  const state = await getStateTable(projectDir);
  const mergedKnows = [...(knowledgeEntry?.knows ?? [])];
  const stateKnows = cast.pov
    ? state.characters.find((entry) => entry.name === cast.pov)?.knows ?? []
    : [];
  for (const fact of stateKnows) {
    if (!mergedKnows.some((entry) => entry.fact === fact)) mergedKnows.push({ fact });
  }
  const knowledge: CharacterKnowledge | undefined = cast.pov
    && (mergedKnows.length > 0 || (knowledgeEntry?.doesNotKnow.length ?? 0) > 0)
    ? {
        name: cast.pov,
        knows: mergedKnows,
        doesNotKnow: (knowledgeEntry?.doesNotKnow ?? []).filter(
          (fact) => !mergedKnows.some((known) => known.fact === fact),
        ),
        ...(knowledgeEntry?.updatedChapter !== undefined
          ? { updatedChapter: knowledgeEntry.updatedChapter }
          : {}),
      }
    : undefined;

  const mechanical = detectMechanicalFactIssues({
    chapterText,
    chapter: chapterNum,
    pov: cast.pov,
    roster: toRosterInputs(roster),
    knowledge,
  });

  let semantic: FactCheckFinding[] = [];
  let semanticError: string | undefined;
  const deep = body.deep !== false;
  if (deep) {
    const prompt = buildFactCheckPrompt({
      chapter: chapterNum,
      chapterText,
      pov: cast.pov,
      roster,
      knowledge,
      timeline: state.timeline,
      previousSummary: await readRecentSummaries(projectDir, chapterNum),
      outline: outline.content,
    });

    try {
      const output = await callAgentOnce(prompt, projectDir, FACT_CHECK_TIMEOUT_MS);
      const parsed = parseFactCheckResponse(output, chapterNum);
      if (parsed === null) {
        semanticError = 'AI 输出无法解析为事实核查 JSON，已仅返回机械检查结果';
      } else {
        semantic = parsed;
      }
    } catch (e) {
      // 语义核查失败不阻断：保留机械检查结果，前端展示错误提示
      semanticError = e instanceof Error ? e.message : String(e);
    }
  }

  return c.json({
    chapter: chapterNum,
    pov: cast.pov || null,
    findings: dedupeFindings([...mechanical, ...semantic]),
    mechanical,
    semantic,
    ...(semanticError ? { semanticError } : {}),
  });
});

export default checkRouter;
