import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { createRun, getRun, emitEvent, finishRun, cancelRun, subscribeRun, resolveAsk, getActiveRunForProject } from '../../agent/run';
import type { RunSession } from '../../agent/run';
import { composePrompt } from '../../agent/prompt-composer';
import { getAgentDef } from '../../agent/registry';
import { detectAgents } from '../../agent/detection';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler, createJsonEventHandler } from '../../agent/stream-parser';
import { runAcpTurn, isAcpFailure } from '../../agent/acp-bridge';
import { collectWrittenPaths, syncFilesToDb } from '../../agent/artifacts';
import { detectAiPatterns, detectDegradation, buildExcludeGrams } from '../../agent/quality-checker';
import type { AgentEvent, StreamEvent } from '../../agent/types';
import { ensureContextArtifacts, getStateTable } from '../../agent/context-manager';
import { readFile, readdir, rename, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSnapshot, restoreSnapshot, listSnapshots, createUserSnapshot } from '../../agent/snapshot';
import { resolveProjectDir } from '../../shared/project-dir';
import { trimHistory, extractScoreTrajectory, estimateTokens } from '../../shared/deepen';
import { parseChapterNumber } from '../../shared/chapter-names';
import { config } from '../../config';
import { db } from '../../db/drizzle';
import { conversations, messages, projects, runs as runsTable, chapters } from '../../db/schema';
import { generateId } from '../../utils/id';
import { eq, desc, and } from 'drizzle-orm';
import { resyncChaptersFromDisk } from './chapters';

// ===== 流层 watchdog 配置 =====
/** 滑动窗口大小（字符数）。窗口内统计 2-gram 重复率。 */
const WATCHDOG_WINDOW_SIZE = 2000;

// ===== 样章门禁 =====
/** 进入 writing 阶段前，磁盘上 CJK 字数 ≥ 此值的正文章节最少数量（样章要求）。 */
const SAMPLE_GATE_REQUIRED = 3;
/** 样章门「有效正文」下限：只含标题的空壳文件不计入。 */
const SAMPLE_GATE_MIN_CJK = 100;

// ===== 普通聊天历史窗口 =====
/** 非 deepen 续聊同样折叠中间消息（文件是跨轮状态层，历史只保留决策脉络）。 */
const GENERAL_HISTORY_TRIM_THRESHOLD = 14;

// ===== 写后质检门禁阈值 =====
const QUALITY_REJECT_SCORE = 60;
const QUALITY_WARN_SCORE = 30;

// ===== 字数校验配置 =====
const DEFAULT_TARGET_WORDS = 3500; // 项目元数据不可用时的兜底
const WORD_DEVIATION_THRESHOLD = 0.3; // 从 0.5 收紧到 0.3

/** 章节正文文件名（中英文命名、全角数字、带标题后缀，排除摘要/退化文件）。
 * 返回章节号或 null。宽松识别防止 agent 用「第3章 风雪夜.md」等近似命名时整章隐形。 */
function isChapterBody(p: string): number | null {
  return parseChapterNumber(path.basename(p));
}

/** 将 writtenPath 解析为绝对路径并校验项目目录越界。
 * agent 上报的绝对路径不校验会允许质检环节 rename 任意系统路径。
 * 越界返回 null，调用方跳过并告警。 */
function resolveWrittenPath(projectDir: string, p: string): string | null {
  const full = path.isAbsolute(p) ? p : path.join(projectDir, p);
  const root = path.resolve(projectDir);
  const resolved = path.resolve(full);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/** 项目级串行锁冲突（launchAndTrack 二次检查命中）。 */
class RunLockError extends Error {
  constructor(public readonly runId: string) {
    super('run-in-progress');
  }
}

/** 读取 .novel/config.json（不存在/损坏返回空对象）。 */
async function readNovelConfig(projectDir: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(projectDir, '.novel', 'config.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/** 文件是否存在（存在且可读）。 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 统计 sample-feedback.md 中的复盘篇数（结构化计数）。
 * 每篇复盘固定四节，其中「声口落地」为节标题：
 * - 结构化格式（当前 prompt 约定）：行首 `- **声口落地**：` 或 `### 声口落地` 等标题行
 * - 旧格式回退：正文中裸出现的「声口落地」子串（历史项目兼容）
 */
async function countSampleFeedback(projectDir: string): Promise<number> {
  try {
    const content = await readFile(path.join(projectDir, '.novel', 'sample-feedback.md'), 'utf-8');
    // 结构化节标题：行首为列表标记/标题标记 + 可选加粗 + 「声口落地」+ 可选冒号
    const structured = (content.match(/^\s*(?:[-*]\s+|#{1,4}\s+)?\**声口落地\**\s*[：:]?/gm) || []).length;
    if (structured > 0) return structured;
    return (content.match(/声口落地/g) || []).length;
  } catch {
    return 0;
  }
}

/** force 旁路样章门后落盘记录 sampleGateBypassed，Dashboard 常驻警示徽标。 */
async function recordSampleGateBypass(projectDir: string): Promise<void> {
  try {
    const existing = await readNovelConfig(projectDir);
    existing.sampleGateBypassed = true;
    await writeFile(path.join(projectDir, '.novel', 'config.json'), JSON.stringify(existing, null, 2), 'utf-8');
  } catch { /* 记录失败不阻断写作 */ }
}

/** 样章门已满足时清除旁路警示标记：惩罚可逆，门槛达标即撤销徽标。 */
async function clearSampleGateBypass(projectDir: string): Promise<void> {
  try {
    const existing = await readNovelConfig(projectDir);
    if (existing.sampleGateBypassed !== true) return;
    delete existing.sampleGateBypassed;
    await writeFile(path.join(projectDir, '.novel', 'config.json'), JSON.stringify(existing, null, 2), 'utf-8');
  } catch { /* 清除失败不阻断写作 */ }
}

/** 记录「经历过样章阶段」标记：复盘门以该标记为判据（而非文件是否存在）。 */
async function recordSampleStageCompleted(projectDir: string): Promise<void> {
  try {
    const existing = await readNovelConfig(projectDir);
    if (existing.sampleStageCompleted === true) return;
    existing.sampleStageCompleted = true;
    await writeFile(path.join(projectDir, '.novel', 'config.json'), JSON.stringify(existing, null, 2), 'utf-8');
  } catch { /* 记录失败不阻断写作 */ }
}

/** 统计磁盘上有有效正文的章节数（CJK 字数 ≥ SAMPLE_GATE_MIN_CJK）。
 * 归档章节（.novel/degraded/ 隔离目录）同样计入——质检归档不等于未完成样章，
 * 归档可一键恢复，不应重新卡住样章门。 */
async function countWrittenChaptersFromDisk(projectDir: string): Promise<number> {
  const novelDir = path.join(projectDir, '.novel');
  let count = 0;
  for (const sub of ['chapters', 'degraded']) {
    const dir = path.join(novelDir, sub);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const num = isChapterBody(f);
      if (num === null) continue;
      try {
        const content = await readFile(path.join(dir, f), 'utf-8');
        const stripped = content.replace(/^[#*>\-[\]()!|]+\s*/gm, '').trim();
        const cjk = (stripped.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
        if (cjk >= SAMPLE_GATE_MIN_CJK) count++;
      } catch { /* skip unreadable */ }
    }
  }
  return count;
}

/** 返回 .novel/degraded/ 中归档章节的章号列表（门禁错误信息中提示可恢复）。 */
async function listDegradedChapterNumbers(projectDir: string): Promise<number[]> {
  const dir = path.join(projectDir, '.novel', 'degraded');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const nums: number[] = [];
  for (const f of files) {
    const num = isChapterBody(f);
    if (num !== null) nums.push(num);
  }
  return nums.sort((a, b) => a - b);
}

/** 检测正文中是否出现章节编号引用（如「第15章」），排除首行标题。 */
function hasMetaNarrativeLeak(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const bodyLines = lines.length > 0 && /^\s{0,3}#{1,6}\s/.test(lines[0]) ? lines.slice(1) : lines;
  return /第\d+章|第[一二三四五六七八九十百]+章/.test(bodyLines.join('\n'));
}

/** 把质检不通过的章节移入 .novel/degraded/ 隔离目录（保留原文件名），
 * 使其不再出现在写作视图与导出中；恢复端点可移回。 */
async function archiveDegradedChapter(projectDir: string, fullPath: string): Promise<boolean> {
  try {
    const degradedDir = path.join(projectDir, '.novel', 'degraded');
    await mkdir(degradedDir, { recursive: true });
    await rename(fullPath, path.join(degradedDir, path.basename(fullPath)));
    return true;
  } catch {
    return false;
  }
}

/** 归档章节后清理残留引用：
 * 1. 该章摘要文件同步移入 degraded/（否则滚动摘要会注入已归档章节的摘要）；
 * 2. state.json 的 lastUpdatedChapter 若指向归档章节，回退到剩余章节的最大章号。
 * 恢复端点把摘要一并移回，引用即可无损恢复。 */
async function cleanupArchivedChapterRefs(projectDir: string, chapterNum: number): Promise<void> {
  const novelDir = path.join(projectDir, '.novel');
  // 1. 摘要随正文归档（旧版英文摘要名同样处理）
  const degradedDir = path.join(novelDir, 'degraded');
  for (const name of [`第${chapterNum}章.summary.md`, `chapter-${chapterNum}.summary.md`]) {
    try {
      await rename(path.join(novelDir, 'chapters', name), path.join(degradedDir, name));
    } catch { /* 无摘要文件，忽略 */ }
  }
  // 2. state.json 章号回退
  try {
    const statePath = path.join(novelDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8')) as { lastUpdatedChapter?: number };
    if (typeof state.lastUpdatedChapter === 'number' && state.lastUpdatedChapter === chapterNum) {
      let maxChapter = 0;
      try {
        const files = await readdir(path.join(novelDir, 'chapters'));
        for (const f of files) {
          const num = isChapterBody(f);
          if (num !== null && num > maxChapter) maxChapter = num;
        }
      } catch { /* 目录不可读，保持 0 */ }
      state.lastUpdatedChapter = maxChapter;
      await writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
    }
  } catch { /* state.json 缺失/损坏：ensureContextArtifacts 会兜底重建 */ }
}

/** 写后质检门禁：对新章节正文跑全文退化终检 + detectAiPatterns + 元叙事泄漏检测。
 * canArchive 控制「退化归档为 .novel/degraded/ 隔离文件」是否允许——仅成功且写作产出阶段允许，
 * 失败 run 与 revision/polish/decompose 等改写已有内容只告警不归档，
 * 避免把用户导入/修订的原文误伤。 */
async function qualityGateCheck(
  run: ReturnType<typeof createRun>,
  projectDir: string,
  writtenPaths: Set<string>,
  excludeGrams: string[],
  canArchive: boolean,
): Promise<void> {
  for (const p of writtenPaths) {
    const chapterNum = isChapterBody(p);
    if (chapterNum === null) continue;

    const fullPath = resolveWrittenPath(projectDir, p);
    if (fullPath === null) {
      // 越界路径：agent 上报了项目目录之外的文件——不读、不归档、不删，仅告警
      emitEvent(run, 'agent', {
        type: 'quality-warning',
        reason: 'path-out-of-scope',
        path: p,
        message: 'agent 报告了项目目录之外的文件路径，已忽略（不会归档或删除该文件）',
      });
      continue;
    }
    let content: string;
    try { content = await readFile(fullPath, 'utf-8'); } catch { continue; }

    // P0 缺陷1: 全文退化终检——补全流式 watchdog 的短章节盲区
    // 流式 watchdog 需积满 2000 字符才检测，短章节（<2000字）从未触发
    const degradation = detectDegradation(content, { excludeGrams });
    if (degradation.detected) {
      if (canArchive) {
        const archived = await archiveDegradedChapter(projectDir, fullPath);
        if (archived) {
          // 移出 chapters/ 后同步删除 DB 行，避免写作视图显示幽灵章节（wordCount 为退化文本）
          await db.delete(chapters)
            .where(and(eq(chapters.projectId, run.projectId), eq(chapters.number, chapterNum)))
            .catch(() => {});
          // 清理摘要文件与 state.json 引用，避免滚动摘要注入已归档章节
          await cleanupArchivedChapterRefs(projectDir, chapterNum).catch(() => {});
        }
        emitEvent(run, 'agent', {
          type: 'quality-rejected',
          chapter: chapterNum,
          score: 100,
          reason: 'degradation',
          phrase: degradation.repeatedPhrase,
          count: degradation.count,
          ratio: Math.round(degradation.ratio * 100),
          archived,
        });
      } else {
        emitEvent(run, 'agent', {
          type: 'quality-warning',
          chapter: chapterNum,
          reason: 'degradation',
          phrase: degradation.repeatedPhrase,
          count: degradation.count,
        });
      }
      continue; // 退化章节不再检测 AI 味
    }

    const report = detectAiPatterns(content);
    if (report.score >= QUALITY_REJECT_SCORE) {
      if (canArchive) {
        const archived = await archiveDegradedChapter(projectDir, fullPath);
        if (archived) {
          // 移出 chapters/ 后同步删除 DB 行，避免写作视图显示幽灵章节
          await db.delete(chapters)
            .where(and(eq(chapters.projectId, run.projectId), eq(chapters.number, chapterNum)))
            .catch(() => {});
          // 清理摘要文件与 state.json 引用，避免滚动摘要注入已归档章节
          await cleanupArchivedChapterRefs(projectDir, chapterNum).catch(() => {});
        }
        emitEvent(run, 'agent', {
          type: 'quality-rejected',
          chapter: chapterNum,
          score: report.score,
          topIssues: report.issues.slice(0, 3).map((i) => i.suggestion),
          archived,
        });
      } else {
        // 非写作产出阶段：高 AI 味只告警不归档（如 decompose 导入原文、revision 改写稿）
        emitEvent(run, 'agent', {
          type: 'quality-warning',
          chapter: chapterNum,
          score: report.score,
          topIssues: report.issues.slice(0, 3).map((i) => i.suggestion),
        });
      }
    } else if (report.score >= QUALITY_WARN_SCORE) {
      emitEvent(run, 'agent', {
        type: 'quality-warning',
        chapter: chapterNum,
        score: report.score,
      });
    }

    // P1 缺陷3: 元叙事泄漏检测——正文出现章节编号引用
    if (hasMetaNarrativeLeak(content)) {
      emitEvent(run, 'agent', {
        type: 'quality-warning',
        chapter: chapterNum,
        reason: 'meta-narrative-leak',
        message: '正文中出现章节编号引用（如「第15章」），违反元叙事禁令',
      });
    }
  }
}

/** 字数校验：对新章节统计 CJK 字数，偏差超阈值时通知前端。 */
async function wordCountCheck(
  run: ReturnType<typeof createRun>,
  projectDir: string,
  writtenPaths: Set<string>,
  targetWords: number,
): Promise<void> {
  for (const p of writtenPaths) {
    const chapterNum = isChapterBody(p);
    if (chapterNum === null) continue;

    const fullPath = resolveWrittenPath(projectDir, p);
    if (fullPath === null) continue;
    let content: string;
    try { content = await readFile(fullPath, 'utf-8'); } catch { continue; }

    const cjkCount = [...content].filter((c) => c >= '\u4e00' && c <= '\u9fff').length;
    const deviation = Math.abs(cjkCount - targetWords) / targetWords;
    if (deviation > WORD_DEVIATION_THRESHOLD) {
      emitEvent(run, 'agent', {
        type: 'word-count-warning',
        chapter: chapterNum,
        wordCount: cjkCount,
        target: targetWords,
        deviation: Math.round(deviation * 100),
      });
    }
  }
}

/** 从 agent 子进程 stderr 中脱敏常见凭证模式，避免泄露到前端。 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/[sS][kK]-[A-Za-z0-9_-]{20,}/g, 'sk-[REDACTED]'], // OpenAI/Anthropic API key
  [/[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [REDACTED]'], // Bearer token
  [
    /((?:api[_-]?key|token|secret|password|authorization)["'\s]*[:=]\s*["']?)[A-Za-z0-9._/+=-]{8,}/gi,
    '$1[REDACTED]',
  ], // key=value / key: value 形式
];

export function sanitizeStderr(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/**
 * 将原始 StreamEvent[] 转换为可持久化的 AgentEvent[] 格式（合并连续 text/thinking delta）。
 * 同时提取纯文本 content 供消息表存储。无文本输出时用工具调用摘要兜底。
 */
export function transformStreamEvents(rawEvents: Record<string, unknown>[]): { content: string; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  let textBuf = '';
  let thinkingBuf = '';

  const flush = () => {
    if (thinkingBuf) { events.push({ kind: 'thinking', text: thinkingBuf }); thinkingBuf = ''; }
    if (textBuf) { events.push({ kind: 'text', text: textBuf }); textBuf = ''; }
  };

  for (const e of rawEvents) {
    const type = e.type as string;
    if (type === 'text_delta') {
      textBuf += String(e.delta || '');
    } else if (type === 'thinking_delta') {
      thinkingBuf += String(e.delta || '');
    } else {
      flush();
      switch (type) {
        case 'tool_use':
          events.push({ kind: 'tool_use', id: String(e.id || ''), name: String(e.name || ''), input: e.input });
          break;
        case 'tool_result':
          events.push({ kind: 'tool_result', toolUseId: String(e.toolUseId || ''), content: String(e.content || ''), isError: e.isError === true });
          break;
        case 'status':
          events.push({ kind: 'status', label: String(e.label || ''), detail: e.detail as string | undefined });
          break;
        case 'usage': {
          const u = e.usage as Record<string, unknown> | null;
          events.push({ kind: 'usage', inputTokens: u?.input_tokens as number | undefined, outputTokens: u?.output_tokens as number | undefined, costUsd: e.costUsd as number | undefined });
          break;
        }
        case 'error':
          events.push({ kind: 'raw', line: String(e.message || '') });
          break;
        case 'raw':
          events.push({ kind: 'raw', line: String(e.line || '') });
          break;
      }
    }
  }
  flush();

  const textContent = events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).join('');
  const toolSummary = events.filter((e) => e.kind === 'tool_use').map((e) => `[${(e as { name: string }).name}]`).join(' ');
  const content = textContent || toolSummary;

  return { content, events };
}

const runsRouter = new Hono();

runsRouter.post('/', async (c) => {
  const body = await c.req.json();
  const { projectId, agentId, skillId, stage, message, conversationId, model,
          mode = 'generate', targetFile, revisionNote, autonomous = false,
          trimHistory: shouldTrim = false, deepenRound, interruptedResume } = body;
  const planMode = body.planMode === true;

  const def = getAgentDef(agentId);
  if (!def) return c.json({ error: 'Agent not found' }, 404);

  // stage 枚举校验：拒绝 typo/未知阶段——未知 stage 会静默走通用指令且不注入
  // 写作上下文，浪费一次 agent 调用。合法集 = 7 主阶段 + 写作子模式 + 隐藏阶段。
  const VALID_RUN_STAGES = new Set([
    'concept', 'world', 'characters', 'outline', 'scenes', 'sample', 'writing',
    'drafting', 'revision', 'polish', 'decompose', 'enrich',
  ]);
  if (stage !== undefined && !VALID_RUN_STAGES.has(stage)) {
    return c.json({ error: 'invalid-stage', message: `未知阶段：${stage}` }, 400);
  }

  const agents = await detectAgents();
  const detected = agents.find((a) => a.id === agentId);
  if (!detected?.available) return c.json({ error: 'Agent not available' }, 400);

  // 提前解析 projectDir：trimHistory 需要读取 deepen-log.md
  const projectDir = await resolveProjectDir(projectId);

  // 项目级串行锁：同项目同时刻只允许一个 run——并行写 state.json/character-states.md
  // 会互相污染（last-writer-wins）。前端也会禁用发送，此处是服务端兜底。
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目已有正在运行的写作任务，请等待完成后再开始新任务',
      runId: activeRun.id,
    }, 409);
  }

  // 样章门禁：任何会写正文章件的阶段（writing/drafting/revision/polish 共用）
  // 在正文不足 3 章时拦截——revision/polish 同样能写新章节，只拦 writing/drafting
  // 会被「/revision 写第2章」旁路。
  // 以磁盘为事实源（import-source 写盘不入库、退化归档改名、回滚都会让 DB 行失真）。
  // - stage==='sample' 放行（样章阶段本身就是写正文）
  // - 已有 ≥3 章正文的存量项目不受影响（质检归档到 degraded/ 的章节同样计入，
  //   归档可一键恢复，不应重新卡住样章门）
  // - 请求显式携带 force: true 时旁路（用户明确强制开始正式写作），并落盘记录；
  //   门槛后续达标时自动清除警示标记（惩罚可逆）
  // - 复盘门：以「经历过样章阶段」标记（config.json sampleStageCompleted）为判据——
  //   经历过样章阶段就要求 ≥3 篇结构化复盘，文件不存在/不足均拦截；
  //   存量项目无标记时回退旧判据（sample-feedback.md 存在则要求 ≥3 篇）；
  //   import-source 逆向拆书项目（sourceImported）豁免复盘要求
  const gateStages = new Set(['writing', 'drafting', 'revision', 'polish']);
  if (gateStages.has(stage)) {
    if (body.force === true) {
      await recordSampleGateBypass(projectDir);
    } else {
      const written = await countWrittenChaptersFromDisk(projectDir);
      if (written < SAMPLE_GATE_REQUIRED) {
        const degradedChapters = await listDegradedChapterNumbers(projectDir);
        return c.json({
          error: 'sample-gate',
          message: `需先完成样章阶段：writing/drafting/revision/polish 阶段要求至少 ${SAMPLE_GATE_REQUIRED} 章正文（当前 ${written} 章）${degradedChapters.length > 0 ? `。另有 ${degradedChapters.length} 章样章被质检归档（第 ${degradedChapters.join('、')} 章），可在写作视图「已归档」分组一键恢复后计入` : ''}。请切换到 sample 阶段完成 3 章样章后再开始正式写作，或携带 force: true 强制开始。`,
          completedSamples: written,
          degradedChapters,
          required: SAMPLE_GATE_REQUIRED,
        }, 409);
      }
      // 复盘门：经历过样章阶段的项目必须提交 ≥3 篇结构化复盘
      const novelCfg = await readNovelConfig(projectDir);
      if (novelCfg.sourceImported !== true) {
        const feedbackFileExists = await fileExists(path.join(projectDir, '.novel', 'sample-feedback.md'));
        const feedbackRequired = novelCfg.sampleStageCompleted === true || feedbackFileExists;
        if (feedbackRequired) {
          const feedbackCount = await countSampleFeedback(projectDir);
          if (feedbackCount < SAMPLE_GATE_REQUIRED) {
            return c.json({
              error: 'sample-gate',
              message: `样章复盘不足：需在 sample-feedback.md 中完成至少 ${SAMPLE_GATE_REQUIRED} 篇复盘（当前 ${feedbackCount} 篇${feedbackFileExists ? '' : '，复盘文件缺失'}）。请回到样章阶段完成复盘并修订大纲后再开始正式写作，或携带 force: true 强制开始。`,
              completedSamples: written,
              feedbackCount,
              required: SAMPLE_GATE_REQUIRED,
            }, 409);
          }
        }
      }
      // 门槛全部满足：撤销历史 force 旁路警示（惩罚可逆）
      await clearSampleGateBypass(projectDir);
    }
  }

  let convId: string;
  let history: { role: string; content: string }[] = [];
  /** 本 run 是否折叠过对话历史（折叠后向用户发出提示，避免静默丢失上下文）。 */
  let historyTrimmed = false;

  if (conversationId) {
    // Load existing conversation
    const existing = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (existing.length === 0) return c.json({ error: 'Conversation not found' }, 404);
    // 归属校验：会话必须属于当前项目，防止把项目 A 的历史注入项目 B 的 prompt
    if (existing[0].projectId !== projectId) {
      return c.json({
        error: 'conversation-mismatch',
        message: '该会话不属于当前项目，无法继续使用',
      }, 409);
    }
    convId = conversationId;

    // Load prior messages for history
    const priorMessages = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    history = priorMessages.map((m) => ({ role: m.role, content: m.content }));
    // Deepen 循环的对话历史滑动窗口：保留首轮 + 最近 6 条，中间折叠。
    // 文件（.novel/*.md）是跨轮持久状态层，history 只需保留决策脉络。
    // 仅在 Deepen 续轮请求中启用，避免影响普通聊天/修订的上下文完整性。
    if (shouldTrim) {
      // 读取 deepen-log.md 的评分轨迹，注入截断占位行，让 agent 即使看不到早期轮次也能了解评分趋势
      let contextNote: string | undefined;
      try {
        const logContent = await readFile(path.join(projectDir, '.novel', 'deepen-log.md'), 'utf-8');
        const trajectory = extractScoreTrajectory(logContent);
        if (trajectory) contextNote = `评分轨迹：${trajectory}`;
      } catch { /* deepen-log.md may not exist yet */ }
      history = trimHistory(history, 2, 6, contextNote);
      historyTrimmed = true;
    } else if (history.length > GENERAL_HISTORY_TRIM_THRESHOLD) {
      // 普通聊天同样限制上下文：文件是跨轮状态层，历史超长只会推高成本与退化风险
      history = trimHistory(history, 2, 8);
      historyTrimmed = true;
    }
  } else {
    // Create new conversation
    convId = generateId('conv_');
    await db.insert(conversations).values({ id: convId, projectId, agentId, stage });
  }

  // Insert current user message
  const msgId = generateId('msg_');
  await db.insert(messages).values({ id: msgId, conversationId: convId, role: 'user', content: message });

  // Compose prompt with project context, skill, and conversation history

  // revise 模式：读取目标文件全文作为上下文 + baseSnapshot（run-local 快照，用于 close handler 生成 diff）
  let reviseContent: string | undefined;
  let baseSnapshot: string | undefined;
  let reviseFileList: string[] | undefined;
  if (mode === 'revise' && targetFile) {
    // targetFile 相对 .novel/（如 "chapters/第3章.md"）；尝试两种解析以兼容绝对/带前缀路径
    const candidates = path.isAbsolute(targetFile)
      ? [targetFile]
      : [path.join(projectDir, '.novel', targetFile), path.join(projectDir, targetFile)];
    let resolved: string | null = null;
    for (const cand of candidates) {
      try { await readFile(cand, 'utf-8'); resolved = cand; break; } catch { /* noop */ }
    }
    if (!resolved) {
      return c.json({ error: `Target file not found: ${targetFile}` }, 404);
    }
    const indexContent = await readFile(resolved, 'utf-8');
    baseSnapshot = indexContent;

    // 拆分文档检测：targetFile 形如 <type>/index.md 时，内容实际分布在 <type>/chapters/*.md
    // （或 <type>/*.md）卡片文件中。仅注入 index.md 会让 LLM 看不到实际内容。
    // 检测到后读取合并内容 + 卡片文件列表，提示词中引导 LLM 用 Edit 修改具体卡片文件。
    const splitMatch = targetFile.match(/^(concept|world|outline)\/index\.md$/);
    if (splitMatch) {
      const docDir = path.dirname(resolved);
      let entries: string[];
      try {
        entries = (await readdir(docDir, { recursive: true })) as string[];
      } catch {
        entries = [];
      }
      const cardFiles = entries
        .filter((f) => f !== 'index.md' && f.endsWith('.md'))
        .sort();

      if (cardFiles.length > 0) {
        const parts: string[] = [indexContent.trim(), ''];
        for (const relPath of cardFiles) {
          try {
            const content = await readFile(path.join(docDir, relPath), 'utf-8');
            parts.push(content.trim(), '');
          } catch { /* skip unreadable */ }
        }
        reviseContent = parts.join('\n').trim() + '\n';
        reviseFileList = cardFiles.map((f) => `${splitMatch[1]}/${f}`);
      } else {
        reviseContent = indexContent;
      }
    } else {
      reviseContent = indexContent;
    }
  }

  const composedPrompt = await composePrompt({
    message,
    projectId,
    skillId,
    stage,
    projectDir,
    history: history.length > 0 ? history : undefined,
    mode,
    reviseTarget: targetFile,
    reviseNote: revisionNote,
    reviseContent,
    reviseFileList,
    autonomous,
    planMode,
    deepenContext: deepenRound != null ? { round: deepenRound } : undefined,
    agentId,
    interruptedResume,
  });

  /**
   * Launch the agent subprocess and wire up all stream handling, watchdog,
   * quality checks, and teardown. Extracted as a closure so it can be
   * re-invoked for zero-output auto-retry.
   *
   * @param retryOf  Run ID this attempt is retrying (for logging). null on first attempt.
   * @returns The RunSession for this attempt.
   */
  async function launchAndTrack(retryOf: string | null, existingRun?: RunSession): Promise<RunSession> {
  if (!def) throw new Error('Agent definition missing');
  // retry 复用同一 run/stream，前端 SSE 不断流、事件累积在同一流中
  if (!existingRun) {
    // 二次锁检查：composePrompt 是异步耗时路径，两个并发请求可能同时通过
    // 早前检查——真正创建 run 前再验一次，保证串行性。
    const active = getActiveRunForProject(projectId);
    if (active) throw new RunLockError(active.id);
  }
  const run = existingRun ?? createRun({ projectId, agentId, skillId, stage, conversationId: convId });
  run.status = 'running';

  // 历史折叠提示：仅首次 attempt 推送，向用户说明早期对话已折叠（文件是跨轮状态层）
  if (!existingRun && historyTrimmed) {
    emitEvent(run, 'agent', {
      type: 'status',
      label: '早期对话已折叠，仅保留决策脉络（产出文件为跨轮状态层，未丢失）',
    });
  }

  // 通知前端上下文大小（字符数 + 估算 token）
  emitEvent(run, 'agent', { type: 'context_size', chars: composedPrompt.length, tokens: estimateTokens(composedPrompt) });

  // Store run in DB（仅首次创建时插入；retry 复用同一记录）
  if (!existingRun) {
    void db.insert(runsTable).values({
      id: run.id,
      conversationId: convId,
      agent: agentId,
      status: 'running',
      mode,
      payload: mode === 'revise' && targetFile
        ? { targetFile, revisionNote, baseSnapshot }
        : null,
    }).execute();
  }

  // Launch agent
  const { child } = launchAgent(def, composedPrompt, projectDir, [], model);
  run.child = child;

  // Watchdog: cancel the run if the agent subprocess exceeds the configured timeout.
  // unref() so the timer never keeps the event loop (and process) alive.
  // ask 挂起时暂停计时（用户思考时间不计入超时），回答后恢复。
  let timeoutTimer: NodeJS.Timeout | null = null;
  let timeoutRemaining = config.agent.timeoutMs;
  let timeoutStartedAt = Date.now();
  const armTimeout = () => {
    timeoutTimer = setTimeout(() => cancelRun(run), timeoutRemaining);
    timeoutTimer.unref?.();
  };
  const pauseTimeout = () => {
    if (!timeoutTimer) return;
    clearTimeout(timeoutTimer);
    timeoutRemaining = Math.max(0, timeoutRemaining - (Date.now() - timeoutStartedAt));
    timeoutTimer = null;
  };
  const resumeTimeout = () => {
    if (timeoutTimer) return;
    timeoutStartedAt = Date.now();
    armTimeout();
  };
  armTimeout();
  run._pauseTimeout = pauseTimeout;
  run._resumeTimeout = resumeTimeout;

  // P2 缺陷5: 读取角色名生成 excludeGrams，避免聚焦章误报退化检测
  const characterState = await getStateTable(projectDir).catch(() => null);
  const excludeGrams = characterState?.characters
    ? buildExcludeGrams(characterState.characters.map((c) => c.name))
    : [];

  // P1 缺陷4: 从项目元数据计算每章字数目标
  let perChapterTarget = DEFAULT_TARGET_WORDS;
  try {
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (proj?.targetWords && proj?.chapterCount) {
      perChapterTarget = Math.round(proj.targetWords / proj.chapterCount);
    }
  } catch { /* noop */ }

  // Parse stream
  const onStreamComplete = () => {
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end();
    }
  };
  // P1-a: 流层 watchdog — 累积 text_delta 做重复率检测，退化时自动 kill
  let watchdogBuffer = '';
  let watchdogTriggered = false;
  const emitWithWatchdog = (event: StreamEvent) => {
    // claude CLI 的 AskUserQuestion：子进程阻塞等待 stdin tool_result，
    // 与 ACP registerAsk 同样属于「暂停等待用户输入」——暂停超时计时，回答后恢复。
    if (event.type === 'tool_use' && event.name === 'AskUserQuestion') {
      run._pauseTimeout?.();
    }
    if (event.type === 'text_delta' && typeof event.delta === 'string') {
      if (watchdogTriggered) return;
      watchdogBuffer = (watchdogBuffer + event.delta).slice(-WATCHDOG_WINDOW_SIZE);
      if (watchdogBuffer.length >= WATCHDOG_WINDOW_SIZE) {
        const result = detectDegradation(watchdogBuffer, { excludeGrams });
        if (result.detected) {
          watchdogTriggered = true;
          emitEvent(run, 'agent', {
            type: 'degradation',
            phrase: result.repeatedPhrase,
            count: result.count,
            ratio: Math.round(result.ratio * 100),
          });
          cancelRun(run);
          return;
        }
      }
    }
    emitEvent(run, 'agent', event);
  };

  // ACP 协议（omp）：不读 stdout 原始流，而是经 runAcpTurn 驱动 JSON-RPC 会话
  const isAcp = def.streamFormat === 'acp-json-rpc';
  // ACP 正常结束后的 stopReason（omp 常驻进程需主动 kill，exit code 无意义，改用此判定成败）
  let acpStopReason: string | null = null;
  const handler = isAcp
    ? { feed: () => {}, flush: () => {} }
    : def.streamFormat === 'claude-stream-json'
      ? createClaudeStreamHandler(emitWithWatchdog, onStreamComplete)
      : createJsonEventHandler(emitWithWatchdog);

  if (!isAcp) {
    child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
  }
  child.stderr?.on('data', (chunk: Buffer) => emitEvent(run, 'stderr', { text: sanitizeStderr(chunk.toString()) }));

  // ACP: 驱动协议会话，事件经 emitWithWatchdog 注入
  if (isAcp) {
    runAcpTurn(child, composedPrompt, projectDir, [], emitWithWatchdog, model, run.id)
      .then(({ stopReason }) => {
        acpStopReason = stopReason;
        if (stopReason === 'refusal' || stopReason === 'max_turn_requests') {
          emitEvent(run, 'agent', { type: 'error', message: `ACP stop: ${stopReason}` });
        }
        // omp 是常驻进程，会话结束后不自行退出。主动 kill 触发 child.on('close') 收尾链路。
        if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      })
      .catch((err) => {
        acpStopReason = 'error';
        emitEvent(run, 'agent', { type: 'error', message: err?.message || 'ACP turn failed' });
        if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      });
  }

  child.on('error', (err) => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    emitEvent(run, 'agent', { type: 'error', message: err.message });
    handler.flush();
    finishRun(run, 'failed');
    db.update(runsTable).set({ status: run.status, finishedAt: new Date() }).where(eq(runsTable.id, run.id)).execute();
  });

  child.on('close', async (code) => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    handler.flush();

    // ACP 模式：omp 常驻进程被 SIGTERM 终止，exit code 无意义。
    // 用 stopReason 判定：只有显式失败（refusal/max_turn_requests/error）才算失败；
    // null（close 在 runAcpTurn resolve 前触发，如 timeout/进程退出）按成功处理，
    // 避免误丢已产生的 agent 响应。
    if (isAcp) {
      code = isAcpFailure(acpStopReason) ? 1 : 0;
    }

    // 从 RunStream 读取全部事件（DB + 内存窗口合并），提取写入路径 + emit artifacts
    await run.stream.flush();
    const allEvents = await run.stream.replay(0);
    const agentEvents = allEvents
      .filter((e) => e.event === 'agent')
      .map((e) => e.data as Record<string, unknown>);
    const writtenPaths = collectWrittenPaths(agentEvents);

    // Emit artifact summary event
    if (writtenPaths.size > 0) {
      emitEvent(run, 'artifacts', {
        count: writtenPaths.size,
        paths: [...writtenPaths],
      });
    }

    // P0: 以下所有收尾操作完成后再 finishRun — 'end' 事件 = 管道完全收尾

    // Sync file changes back to DB
    const projectDir = await resolveProjectDir(projectId);
    if (writtenPaths.size > 0) {
      await syncFilesToDb(projectId, writtenPaths, projectDir).catch(() => {});
    }

    // P1-b: 写后质检门禁 — 退化分高的章节移入 .novel/degraded/ 隔离区（可恢复）
    // 仅成功（code===0）且写作产出阶段（writing/sample/drafting）允许归档；
    // 失败 run 只告警不归档——失败可能是中途被杀（watchdog 误报/超时），
    // 此时归档会凭空"删除"用户可见的章节，与产品预期不符。
    // revision/polish/decompose 改写已有内容，高 AI 味/退化只告警不归档，避免误伤导入原文与修订稿。
    const canArchive = code === 0 && (stage === 'writing' || stage === 'sample' || stage === 'drafting');
    if (writtenPaths.size > 0) {
      await qualityGateCheck(run, projectDir, writtenPaths, excludeGrams, canArchive).catch(() => {});
    }

    // P2: 字数校验 — 偏差超阈值的章节通知前端
    // decompose（逆向拆书）的章节字数由导入源决定，跳过校验避免全程误报。
    if (code === 0 && writtenPaths.size > 0 && stage !== 'decompose') {
      await wordCountCheck(run, projectDir, writtenPaths, perChapterTarget).catch(() => {});
    }

    // 兜底：补全缺失的章节摘要与状态表（仅写作成功时）
    if (code === 0 && writtenPaths.size > 0) {
      await ensureContextArtifacts(projectDir, writtenPaths).catch(() => {});
    }

    // 样章阶段完成标记：sample run 成功后磁盘正文 ≥3 章 → 复盘门正式生效。
    // 复盘门以该标记为判据（而非 sample-feedback.md 是否存在），
    // 避免「没写复盘文件反而放行」的逻辑倒挂。
    if (code === 0 && stage === 'sample') {
      const writtenCount = await countWrittenChaptersFromDisk(projectDir).catch(() => 0);
      if (writtenCount >= SAMPLE_GATE_REQUIRED) {
        await recordSampleStageCompleted(projectDir).catch(() => {});
      }
    }

    // Create git snapshot
    await createSnapshot(projectDir, `Run ${run.id.slice(0, 8)}: ${writtenPaths.size} files modified`).catch(() => {});

    // revise 模式：生成 run-local diff 并 emit revision-applied 事件
    let reviseDiff: string | undefined;
    if (code === 0 && mode === 'revise' && targetFile && baseSnapshot !== undefined) {
      try {
        // 与启动时相同的解析逻辑（.novel 前缀兼容）
        const candidates = path.isAbsolute(targetFile)
          ? [targetFile]
          : [path.join(projectDir, '.novel', targetFile), path.join(projectDir, targetFile)];
        let newContent: string | null = null;
        for (const cand of candidates) {
          try { newContent = await readFile(cand, 'utf-8'); break; } catch { /* noop */ }
        }
        if (newContent !== null) {
          const { createUnifiedDiff, summarizeDiff } = await import('../../shared/diff-utils');
          reviseDiff = createUnifiedDiff(baseSnapshot, newContent, targetFile);
          const summary = summarizeDiff(reviseDiff);
          emitEvent(run, 'agent', {
            type: 'revision-applied',
            targetFile,
            addedLines: summary.addedLines,
            removedLines: summary.removedLines,
            diffPreview: reviseDiff.slice(0, 2000),
          });
        }
      } catch { /* diff 生成失败不阻断收尾 */ }
    }

    // P1: 零产出自动重试 — writing 阶段产出 0 个文件时自动重试一次。
    // 根因：agent 有时读上下文后空转退出（~30%概率），不写任何文件。
    // 不重试会浪费一轮对话额度且打断写作流程。
    if (code === 0 && writtenPaths.size === 0 && (stage === 'writing' || stage === 'drafting' || stage === 'sample') && retryOf === null) {
      emitEvent(run, 'agent', {
        type: 'status',
        label: 'Agent 未产出任何文件，正在自动重试…',
        retry: true,
      });
      // 短暂延迟后重试，复用同一 run/stream（前端 SSE 不断流）
      setTimeout(() => { void launchAndTrack(run.id, run); }, 2000);
      // 不 finishRun 也不 close stream — 重试复用同一事件流
      return;
    }

    // P1: 重试后仍零产出 → 明确失败，不再把空转标记为 succeeded。
    // retryOf !== null 表示本次 close 已是第二次尝试（或重试路径上的后续尝试）。
    if (code === 0 && writtenPaths.size === 0 && retryOf !== null && (stage === 'writing' || stage === 'drafting' || stage === 'sample')) {
      emitEvent(run, 'agent', {
        type: 'error',
        message: 'Agent 连续两次未产出任何文件，已标记为失败',
      });
      code = 1;
    }

    // Update run record（revise 模式附带 diff 进 payload）
    // 放在重试检查之后：retry 提前 return 时行保持 running，最终尝试统一在此落库。
    const updateSet: Record<string, unknown> = {
      status: code === 0 ? 'succeeded' : 'failed',
      finishedAt: new Date(),
    };
    if (reviseDiff !== undefined) {
      updateSet.payload = { targetFile, revisionNote, baseSnapshot, diff: reviseDiff };
    }
    await db.update(runsTable).set(updateSet).where(eq(runsTable.id, run.id)).execute();

    // P0: 最后才 finishRun — 'end' 事件表示管道完全收尾

    // 固化 assistant 消息到 messages 表（RunStream.close 内部完成聚合 + 写入）
    // 失败的 run（code !== 0）只要有 agent 输出也持久化，加标记前缀。
    // 放在 retry 检查之后：retry 时不 close，保留 stream 给重试 attempt。
    const finalArtifacts = writtenPaths.size > 0 ? { count: writtenPaths.size, paths: [...writtenPaths] } : null;
    await run.stream.close(transformStreamEvents, {
      failed: code !== 0,
      failLabel: acpStopReason || undefined,
      artifacts: finalArtifacts,
    });

    finishRun(run, code === 0 ? 'succeeded' : 'failed');
  });

  return run;
  } // end launchAndTrack

  // 启动首次尝试（二次锁检查命中时返回 409）
  let firstRun: RunSession;
  try {
    firstRun = await launchAndTrack(null);
  } catch (err) {
    if (err instanceof RunLockError) {
      return c.json({
        error: 'run-in-progress',
        message: '该项目已有正在运行的写作任务，请等待完成后再开始新任务',
        runId: err.runId,
      }, 409);
    }
    throw err;
  }
  return c.json({ runId: firstRun.id, conversationId: convId }, 201);
});

runsRouter.get('/:id/events', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);

  return stream(c, async (streamWriter) => {
    streamWriter.onAbort(() => { /* client disconnected */ });

    // Set SSE headers
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const lastEventId = Number(c.req.header('Last-Event-ID') || 0);

    // Subscribe for replay (from lastEventId) + live events
    const send = async (event: string, data: unknown, id: number) => {
      try {
        await streamWriter.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* client disconnected */ }
    };

    // If already finished, just replay and close
    if (['succeeded', 'failed', 'canceled'].includes(run.status)) {
      const missed = await run.stream.replay(lastEventId);
      for (const record of missed) {
        await send(record.event, record.data, record.id);
      }
      return;
    }

    // Subscribe: replay missed + live events (single source)
    const unsub = subscribeRun(run, lastEventId, send);

    // Keep-alive heartbeat
    const heartbeat = setInterval(async () => {
      try { await streamWriter.write(': keepalive\n\n'); }
      catch { clearInterval(heartbeat); }
    }, 15000);

    streamWriter.onAbort(() => {
      clearInterval(heartbeat);
      unsub();
    });

    // Wait until run finishes (event-driven, no polling)
    await run.finished;
  });
});

runsRouter.post('/:id/tool-result', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json();
  if (run.child?.stdin) {
    const msg = JSON.stringify({
      type: 'tool_result',
      tool_use_id: body.toolUseId,
      content: body.content,
      is_error: body.isError || false,
    });
    run.child.stdin.write(msg + '\n');
  }
  // AskUserQuestion 已回答：恢复超时计时
  run._resumeTimeout?.();
  return c.json({ ok: true });
});

runsRouter.delete('/:id', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  run.cancelReason = 'user-cancel';
  cancelRun(run);
  return c.json({ ok: true });
});

// 回答 agent 的 elicitation（ask 选择框）提问。
// 前端渲染选择框后，用户选完答案 POST 到此 endpoint，唤醒挂起的 elicitation handler。
// 提问已过期时答案暂存到 run._lateAnswers，返回 late 标记（不报错），
// retry 端点会把暂存答案并入中断现场回传。
runsRouter.post('/:id/ask/:askId', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  const askId = c.req.param('askId');
  const body = await c.req.json().catch(() => ({}));
  const action = body.action === 'accept' ? 'accept' : 'cancel';
  const content = action === 'accept' ? { value: body.value } : undefined;
  const result = resolveAsk(run, askId, { action, content });
  if (result === 'late') {
    return c.json({
      ok: true,
      late: true,
      message: '该提问已超时，本次任务已结束；答案已暂存，重试任务时会一并使用',
    });
  }
  return c.json({ ok: true });
});

// 返回 run 的当前状态 + 挂起的 elicitation askId 列表（供夜间探索等无人值守调度器轮询）。
runsRouter.get('/:id/status', async (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  const pendingAskIds = run._pendingAsks.size > 0 ? [...run._pendingAsks.keys()] : [];
  return c.json({ status: run.status, pendingAskIds });
});

runsRouter.get('/conversations/:id/messages', async (c) => {
  const convId = c.req.param('id');
  const existing = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
  if (existing.length === 0) return c.json({ error: 'Conversation not found' }, 404);

  const msgs = await db.select().from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(messages.createdAt);

  return c.json(msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts, createdAt: m.createdAt })));
});

// 返回某 conversation 最近一条仍在运行的 run，供前端刷新后恢复轮询。
// 已完成/不存在则返回 null。
runsRouter.get('/conversations/:id/active-run', async (c) => {
  const convId = c.req.param('id');
  const [latest] = await db.select().from(runsTable)
    .where(eq(runsTable.conversationId, convId))
    .orderBy(desc(runsTable.createdAt))
    .limit(1);
  if (!latest || latest.status !== 'running') return c.json({ runId: null });
  return c.json({ runId: latest.id });
});

/**
 * Conversation 级 SSE 流——前端 mount/刷新时的主入口。
 *
 * 一次性排空：推历史 messages + 桥接活跃 RunStream 事件。run 结束后推固化
 * 的完整消息，然后关闭。不是长期连接——用户发新消息时走 sendMessage 的
 * per-run SSE（现有机制不变）。此端点纯粹用于「刷新后追回错过的」场景。
 */
runsRouter.get('/conversations/:id/stream', async (c) => {
  const convId = c.req.param('id');

  return stream(c, async (streamWriter) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const write = async (event: string, data: unknown) => {
      try { await streamWriter.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* disconnected */ }
    };

    // 1. 推历史 messages（已固化的完整对话）
    const historyMsgs = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    for (const m of historyMsgs) {
      await write('message', { id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts });
    }

    // 2. 查活跃 run
    const [latestRun] = await db.select().from(runsTable)
      .where(eq(runsTable.conversationId, convId))
      .orderBy(desc(runsTable.createdAt))
      .limit(1);

    if (!latestRun || latestRun.status !== 'running') {
      // 无活跃 run：历史已推完，一次性流结束
      return;
    }

    const run = getRun(latestRun.id);
    if (!run) return;

    // 3. 桥接活跃 RunStream 事件（重放 fromSeq 0 + 实时推送）
    let unsub: (() => void) | null = null;
    unsub = run.stream.subscribe(0, async (event, data, id) => {
      try { await streamWriter.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* noop */ }
    });

    streamWriter.onAbort(() => { if (unsub) unsub(); });

    // 4. 等 run 结束
    await run.finished;
    await new Promise((r) => setTimeout(r, 100));
    if (unsub) unsub();

    // 5. 推 run 结束后固化的完整 assistant 消息（补充 events/artifacts）
    const finalMsgs = await db.select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt);
    const newMsgs = finalMsgs.slice(historyMsgs.length);
    for (const m of newMsgs) {
      await write('message', { id: m.id, role: m.role, content: m.content, events: m.events, artifacts: m.artifacts });
    }
  });
});

// Retry a failed run
runsRouter.post('/:id/retry', async (c) => {
  const runId = c.req.param('id');
  const run = getRun(runId);

  // DB 行是持久事实：内存 miss（服务重启 / 30 分钟回收）也要能重建重试上下文，
  // 否则「异常中断可重试继续」的承诺在重启后落空（旧缺陷：getRun 404）。
  const [runRecord] = await db.select().from(runsTable).where(eq(runsTable.id, runId)).limit(1);
  if (!run && !runRecord) return c.json({ error: 'Run not found' }, 404);

  const status = run ? run.status : runRecord!.status;
  if (status !== 'failed' && status !== 'canceled') return c.json({ error: 'Only failed/canceled runs can be retried' }, 400);

  // Get the conversation and original message
  const convId = runRecord?.conversationId ?? null;
  if (!convId) return c.json({ error: 'No conversation found' }, 404);

  const allMsgs = await db.select().from(messages)
    .where(eq(messages.conversationId, convId))
    .orderBy(messages.createdAt);

  const userMessage = allMsgs.filter((m) => m.role === 'user').pop();
  if (!userMessage) return c.json({ error: 'No user message to retry' }, 400);

  // 异常中断恢复：从 history 中提取上一轮的 user message 和 assistant content，
  // 构造 interruptedResume。前端收到后，在用户"继续"时将该对象回传给 POST /，注入中断现场。
  // 内存 miss（重启后）无法精确判定中断原因，给出如实的产品化说明。
  const assistantMsg = allMsgs.filter((m) => m.role === 'assistant').pop();
  const reason =
    !run
      ? '服务曾重启，任务被中断（已写入的文件保留，可继续）'
      : run.cancelReason === 'ask-timeout'
        ? '提问长时间无人回答，任务自动结束（已写入的文件保留）'
        : 'agent 进程异常退出（exit code != 0，可能因 timeout、watchdog 或 crash 中断）';
  const interruptedResume = {
    userMessage: userMessage.content,
    assistantContent: assistantMsg?.content ?? '',
    reason,
  };

  // 过期提问的暂存答案：仅内存中存在（重启后丢失），随 retry 响应回传。
  const lateAnswers = run
    ? [...run._lateAnswers.entries()].map(([askId, ans]) => ({
        askId,
        action: ans.action,
        content: ans.content,
      }))
    : [];

  // 内存 miss（重启后）无法读取 run.stage（runs 表无此列）：
  // 回退到会话所属项目的 currentStage，与「继续」时的默认阶段一致。
  let stage = run?.stage ?? 'writing';
  if (!run) {
    const [convRow] = await db.select().from(conversations).where(eq(conversations.id, convId)).limit(1);
    if (convRow) {
      const [projRow] = await db.select().from(projects).where(eq(projects.id, convRow.projectId)).limit(1);
      stage = projRow?.currentStage ?? 'writing';
    }
  }

  // Return info needed to retry
  return c.json({
    conversationId: convId,
    agentId: runRecord!.agent,
    stage,
    message: userMessage.content,
    interruptedResume,
    lateAnswers,
  });
});

// List snapshots for a project
runsRouter.get('/projects/:projectId/snapshots', async (c) => {
  const projectId = c.req.param('projectId');
  const projectDir = await resolveProjectDir(projectId);
  // 支持 ?limit= 提升返回条数（默认 20）；前端快照列表传 200 让早期里程碑可达
  const rawLimit = c.req.query('limit');
  let limit = 20;
  if (rawLimit) {
    const parsed = parseInt(rawLimit, 10);
    if (Number.isFinite(parsed)) limit = Math.min(500, Math.max(1, parsed));
  }
  const snapshots = await listSnapshots(projectDir, limit);
  return c.json({ snapshots });
});

// Rollback to a snapshot
runsRouter.post('/projects/:projectId/rollback', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await c.req.json();
  if (!body.commitHash) return c.json({ error: 'commitHash is required' }, 400);

  // 项目串行锁：run 正在写文件时回滚会覆盖工作区并污染 agent 后续写入
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再回滚',
      runId: activeRun.id,
    }, 409);
  }

  const projectDir = await resolveProjectDir(projectId);
  const success = await restoreSnapshot(projectDir, body.commitHash);
  if (!success) return c.json({ error: 'Rollback failed' }, 500);

  // 磁盘回滚后按磁盘重建 chapters 表：避免写作视图显示幽灵章节与过期字数
  await resyncChaptersFromDisk(projectId, { force: true }).catch(() => {});

  return c.json({ ok: true });
});

// Create a user milestone snapshot (commit pending changes + tag)
runsRouter.post('/projects/:projectId/snapshot', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);

  // 项目串行锁：run 写入途中提交会捕获半成品文件
  const activeRun = getActiveRunForProject(projectId);
  if (activeRun) {
    return c.json({
      error: 'run-in-progress',
      message: '该项目有正在运行的写作任务，请先等待完成或停止后再保存版本',
      runId: activeRun.id,
    }, 409);
  }

  const projectDir = await resolveProjectDir(projectId);
  const hash = await createUserSnapshot(projectDir, name);
  if (!hash) return c.json({ error: 'Failed to create snapshot' }, 500);

  return c.json({ ok: true, hash, tag: `milestone-${name}` });
});

export default runsRouter;
