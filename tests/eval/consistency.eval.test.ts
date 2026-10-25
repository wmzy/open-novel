// @vitest-environment node
/**
 * P2 长程一致性评测（docs/改进计划-内置Pi-SDK.md §7）：规模可配的一体化评测。
 *
 * 与 tests/integration/canon-consistency.test.ts 共用同一套种子化 fixture，差异：
 * - 章节数可配：EVAL_CHAPTERS（默认 100；夜间 CI 跑 300）；
 * - 注入配额随规模伸缩（三类 P0 各 ~chapters/10，三类 major 各 ~chapters/20）；
 * - 输出命中率 + 性能数字的 JSON 产物（tests/eval/results/consistency-<N>ch.json）；
 * - 可选 LLM judge：EVAL_JUDGE=1 且 Pi 凭据可用时，从干净章节抽 5 章按 rubric 打分；
 *   无 Key 时打印「JUDGE SKIPPED: no api key」，LLM 失败不判评测失败（只记录 error）。
 *
 * 运行（默认 include 不含 tests/eval，必须显式 EVAL_RUN 门控打开）：
 *   EVAL_RUN=1 npx vitest run tests/eval/ --maxWorkers=4     # 100 章
 *   EVAL_CHAPTERS=300 EVAL_RUN=1 npx vitest run tests/eval/  # 300 章
 *   EVAL_JUDGE=1 …                                           # 追加 LLM judge
 * 等价一条命令：node scripts/eval-consistency.mjs（见其头注释）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCanonContext,
  readCanon,
  readChapterContract,
  validateChapterContract,
  type ContractFinding,
} from '../../src/shared/canon';
import {
  buildConsistencyFixture,
  chapterBodyFile,
  injectContradictions,
  mulberry32,
  type ConsistencyInjection,
} from '../fixtures/consistency-fixture';

/** 评测参数：章节数可配（默认 100），seed 固定保证逐字节可复现。 */
const CHAPTERS = Math.max(1, Number.parseInt(process.env.EVAL_CHAPTERS ?? '', 10) || 100);
const SEED = 20261025;
const JUDGE_REQUESTED = process.env.EVAL_JUDGE === '1';
const JUDGE_SAMPLE = 5;
const JUDGE_TIMEOUT_MS = 120_000;
/** buildCanonContext 采样章节：首/中/末（台账静态，末章上下文最全、最耗时）。 */
const CONTEXT_SAMPLE_CHAPTERS = [1, Math.max(1, Math.floor(CHAPTERS / 2)), CHAPTERS];

/** 注入配额随规模伸缩：P0 每类 ~chapters/10、major 每类 ~chapters/20（小规模下限保护）。 */
const p0PerKind = Math.max(3, Math.round(CHAPTERS / 10));
const majorPerKind = Math.max(2, Math.round(CHAPTERS / 20));

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));
const RESULT_FILE = path.join(RESULTS_DIR, `consistency-${CHAPTERS}ch.json`);

interface JudgeEntry {
  chapter: number;
  ok: boolean;
  plotCoherence?: number;
  characterConsistency?: number;
  logicConsistency?: number;
  notes?: string;
  error?: string;
}

interface EvalResult {
  timestamp: string;
  finishedAt?: string;
  params: {
    chapters: number;
    seed: number;
    p0PerKind: number;
    majorPerKind: number;
    judgeRequested: boolean;
    node: string;
  };
  deterministic: {
    p0: { total: number; hits: number; rate: number; byKind: Record<string, string>; missed: string[] };
    major: { total: number; hits: number; rate: number; byKind: Record<string, string>; missed: string[] };
    cleanChapters: { total: number; falsePositives: number; offenders: number[] };
    performance: {
      fixtureBuildMs: number;
      injectMs: number;
      validateTotalMs: number;
      validatePerChapterMs: number;
      buildCanonContext: Array<{ chapter: number; ms: number; contextChars: number }>;
      buildCanonContextMaxMs: number;
    };
  };
  judge: {
    status: 'disabled' | 'skipped' | 'ran' | 'failed';
    reason?: string;
    model?: string;
    entries: JudgeEntry[];
    averages?: Record<string, number>;
  };
}

const result: EvalResult = {
  timestamp: new Date().toISOString(),
  params: {
    chapters: CHAPTERS,
    seed: SEED,
    p0PerKind,
    majorPerKind,
    judgeRequested: JUDGE_REQUESTED,
    node: process.version,
  },
  deterministic: {
    p0: { total: 0, hits: 0, rate: 0, byKind: {}, missed: [] },
    major: { total: 0, hits: 0, rate: 0, byKind: {}, missed: [] },
    cleanChapters: { total: 0, falsePositives: 0, offenders: [] },
    performance: {
      fixtureBuildMs: 0,
      injectMs: 0,
      validateTotalMs: 0,
      validatePerChapterMs: 0,
      buildCanonContext: [],
      buildCanonContextMaxMs: 0,
    },
  },
  judge: { status: 'disabled', entries: [] },
};

let dir: string | undefined;
let injections: ConsistencyInjection[] = [];
let findingsByChapter = new Map<number, ContractFinding[]>();
let judgeChapters: number[] = [];

/** 从洗牌序列中按条件取 n 个不重叠章号（烧掉不满足条件的章号，保持确定性）。 */
function deal(
  shuffled: number[],
  from: number,
  pred: (c: number) => boolean,
  n: number,
): { taken: number[]; next: number } {
  const taken: number[] = [];
  let idx = from;
  while (taken.length < n && idx < shuffled.length) {
    if (pred(shuffled[idx])) taken.push(shuffled[idx]);
    idx += 1;
  }
  if (taken.length < n) throw new Error(`洗牌池不足以分配 ${n} 个满足条件的章号`);
  return { taken, next: idx };
}

function hitStats(list: ConsistencyInjection[]) {
  const missed = list.filter(
    (i) => !(findingsByChapter.get(i.chapter) ?? []).some(
      (f) => f.code === i.expectCode && f.severity === i.expectSeverity,
    ),
  );
  const hits = list.length - missed.length;
  return { total: list.length, hits, rate: list.length ? hits / list.length : 1, missed };
}

function toResultBlock(list: ConsistencyInjection[]): EvalResult['deterministic']['p0'] {
  const stats = hitStats(list);
  const byKind: Record<string, string> = {};
  for (const kind of [...new Set(list.map((i) => i.kind))]) {
    const k = hitStats(list.filter((i) => i.kind === kind));
    byKind[kind] = `${k.hits}/${k.total}`;
  }
  return {
    total: stats.total,
    hits: stats.hits,
    rate: stats.rate,
    byKind,
    missed: stats.missed.map((m) => `第${m.chapter}章/${m.kind}`),
  };
}

function buildJudgePrompt(chapter: number, content: string, pov: string, cast: string[]): string {
  return [
    '你是小说一致性评审员。阅读下面这一章的正文，并对照章节合同（POV 与出场角色），按 rubric 打分：',
    '- plot_coherence（情节连贯，1-5 分）：本章内部情节是否连贯自洽；',
    '- character_consistency（人物一致，1-5 分）：人物言行与合同设定是否一致；',
    '- logic_consistency（无逻辑矛盾，1-5 分）：是否存在前后矛盾、设定冲突。',
    '只输出一个 JSON 对象（不要调用任何工具，不要读写文件）：',
    '{"chapter": 章号, "scores": {"plot_coherence": 1-5, "character_consistency": 1-5, "logic_consistency": 1-5}, "notes": "一句话点评"}',
    '',
    `【第 ${chapter} 章合同】POV：${pov}；出场：${cast.join('、')}`,
    '',
    '【正文】',
    content,
  ].join('\n');
}

describe.skipIf(!process.env.EVAL_RUN)(`长程一致性评测（${CHAPTERS} 章）`, () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-novel-eval-'));

    // ---- 阶段 1a：生成 fixture（计时）----
    const buildStart = Date.now();
    await buildConsistencyFixture(dir, { chapters: CHAPTERS, seed: SEED });
    result.deterministic.performance.fixtureBuildMs = Date.now() - buildStart;

    // ---- 阶段 1b：确定性分配互不重叠的注入章号 ----
    // 最早退场实体在第 4 章退场，dead-entity-cast 只要求章号 > 4。
    const rand = mulberry32(20261107);
    const shuffled = Array.from({ length: CHAPTERS }, (_, i) => i + 1);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const dead = deal(shuffled, 0, (c) => c > 4, p0PerKind);
    const rest = deal(shuffled, dead.next, () => true, p0PerKind * 2 + majorPerKind * 3);
    injections = [
      ...dead.taken.map((chapter) => ({
        chapter, kind: 'dead-entity-cast', expectSeverity: 'blocker', expectCode: 'dead-entity-cast',
      } as const)),
      ...rest.taken.slice(0, p0PerKind).map((chapter) => ({
        chapter, kind: 'pov-missing', expectSeverity: 'blocker', expectCode: 'pov-missing',
      } as const)),
      ...rest.taken.slice(p0PerKind, p0PerKind * 2).map((chapter) => ({
        chapter, kind: 'must-not-reveal-present', expectSeverity: 'blocker', expectCode: 'must-not-reveal-present',
      } as const)),
      ...rest.taken.slice(p0PerKind * 2, p0PerKind * 2 + majorPerKind).map((chapter) => ({
        chapter, kind: 'cast-missing', expectSeverity: 'major', expectCode: 'cast-missing',
      } as const)),
      ...rest.taken.slice(p0PerKind * 2 + majorPerKind, p0PerKind * 2 + majorPerKind * 2).map((chapter) => ({
        chapter, kind: 'must-reveal-missing', expectSeverity: 'major', expectCode: 'must-reveal-missing',
      } as const)),
      ...rest.taken.slice(p0PerKind * 2 + majorPerKind * 2).map((chapter) => ({
        chapter, kind: 'word-budget', expectSeverity: 'major', expectCode: 'word-budget',
      } as const)),
    ];
    const injectStart = Date.now();
    await injectContradictions(dir, injections);
    result.deterministic.performance.injectMs = Date.now() - injectStart;

    // ---- 阶段 1c：逐章确定性校验（计时）----
    const canon = await readCanon(dir);
    findingsByChapter = new Map();
    const validateStart = Date.now();
    for (let chapter = 1; chapter <= CHAPTERS; chapter++) {
      const contract = await readChapterContract(dir, chapter);
      if (!contract) throw new Error(`第 ${chapter} 章缺少合同`);
      const content = await fs.readFile(chapterBodyFile(dir, chapter), 'utf-8');
      findingsByChapter.set(chapter, validateChapterContract({ content, contract, canon }));
    }
    result.deterministic.performance.validateTotalMs = Date.now() - validateStart;
    result.deterministic.performance.validatePerChapterMs =
      Math.round((result.deterministic.performance.validateTotalMs / CHAPTERS) * 100) / 100;

    result.deterministic.p0 = toResultBlock(injections.filter((i) => i.expectSeverity === 'blocker'));
    result.deterministic.major = toResultBlock(injections.filter((i) => i.expectSeverity === 'major'));

    const injected = new Set(injections.map((i) => i.chapter));
    const clean = Array.from({ length: CHAPTERS }, (_, i) => i + 1).filter((c) => !injected.has(c));
    const offenders = clean.filter((c) => (findingsByChapter.get(c) ?? []).length > 0);
    result.deterministic.cleanChapters = { total: clean.length, falsePositives: offenders.length, offenders };

    // ---- judge 抽样：从干净章节确定性抽 5 章 ----
    const sampleRand = mulberry32(SEED + 7);
    const pool = [...clean];
    judgeChapters = [];
    while (judgeChapters.length < Math.min(JUDGE_SAMPLE, pool.length) && pool.length > 0) {
      judgeChapters.push(pool.splice(Math.floor(sampleRand() * pool.length), 1)[0]);
    }
  }, 600_000);

  afterAll(async () => {
    // 无论断言成败都落盘 JSON 产物（诊断依赖），再清理临时目录。
    result.finishedAt = new Date().toISOString();
    try {
      await fs.mkdir(RESULTS_DIR, { recursive: true });
      await fs.writeFile(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
      console.log(`[eval] 结果已写入 ${path.relative(process.cwd(), RESULT_FILE)}`);
    } catch (err) {
      console.error(`[eval] 写入结果 JSON 失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it('P0 注入命中 ≥90%（跌破即评测失败，夜间 CI 红灯）', () => {
    const { p0 } = result.deterministic;
    console.log(
      `[eval] P0 命中 ${p0.hits}/${p0.total}（${Object.entries(p0.byKind).map(([k, v]) => `${k} ${v}`).join('，')}）；` +
      `未命中：${p0.missed.join('、') || '无'}`,
    );
    expect(p0.rate).toBeGreaterThanOrEqual(0.9);
  });

  it('major 注入命中 ≥80%', () => {
    const { major } = result.deterministic;
    console.log(
      `[eval] major 命中 ${major.hits}/${major.total}（${Object.entries(major.byKind).map(([k, v]) => `${k} ${v}`).join('，')}）；` +
      `未命中：${major.missed.join('、') || '无'}`,
    );
    expect(major.rate).toBeGreaterThanOrEqual(0.8);
  });

  it('干净章节零 findings（含零 blocker 误报）', () => {
    const { cleanChapters } = result.deterministic;
    console.log(
      `[eval] 干净章节 ${cleanChapters.total}/${CHAPTERS}，误报 ${cleanChapters.falsePositives} 章` +
      `${cleanChapters.offenders.length ? `（第 ${cleanChapters.offenders.join('、')} 章）` : ''}`,
    );
    expect(cleanChapters.offenders).toEqual([]);
  });

  it('buildCanonContext 采样耗时 < 500ms（记录最耗章节实际值）', async () => {
    if (!dir) throw new Error('fixture 目录未初始化');
    const names = ['沈青梧', '陆云帆', '顾长风', '白锦瑟'];
    for (const chapter of CONTEXT_SAMPLE_CHAPTERS) {
      const start = Date.now();
      const context = await buildCanonContext(dir, chapter, names);
      result.deterministic.performance.buildCanonContext.push({
        chapter,
        ms: Date.now() - start,
        contextChars: context.length,
      });
    }
    const samples = result.deterministic.performance.buildCanonContext;
    const max = samples.reduce((acc, s) => Math.max(acc, s.ms), 0);
    result.deterministic.performance.buildCanonContextMaxMs = max;
    const worst = samples.find((s) => s.ms === max);
    console.log(
      `[eval] buildCanonContext 采样 ${samples.map((s) => `第${s.chapter}章 ${s.ms}ms`).join('，')}；` +
      `最大 ${max}ms（第 ${worst?.chapter ?? '?'} 章），预算 500ms`,
    );
    expect(contextStillValid(samples)).toBe(true);
    expect(max).toBeLessThan(500);
  });

  it('LLM judge（可选）：EVAL_JUDGE=1 且凭据可用才执行，失败不判评测失败', async () => {
    if (!JUDGE_REQUESTED) {
      result.judge = { status: 'disabled', reason: 'EVAL_JUDGE 未设置', entries: [] };
      console.log('[eval] JUDGE SKIPPED: EVAL_JUDGE 未设置');
      return;
    }
    // 惰性导入：Pi/DB 链只在 judge 真正执行时加载（常规确定性评测不触碰 agent 基础设施）。
    // ensureDbReady 先在隔离的测试库上跑迁移（user_settings 表初始不存在），
    // 与 tests/unit/agent/pi-config-stages.test.ts 的用法一致。
    const { ensureDbReady } = await import('../../src/db/drizzle');
    await ensureDbReady();
    const { readPiSettings } = await import('../../src/agent/pi/config');
    const settings = await readPiSettings();
    // custom provider 走本地反代时可以无 Key（凭据由网关持有）。
    const usable =
      Boolean(settings.apiKey) || (settings.provider === 'custom' && Boolean(settings.baseUrl));
    if (!usable) {
      result.judge = { status: 'skipped', reason: 'no api key', entries: [] };
      console.log('[eval] JUDGE SKIPPED: no api key');
      return;
    }

    const { callPiOnce } = await import('../../src/agent/pi/runtime');
    // 括号计数式宽容解析复用 canon-extractor 的实现（处理 ```json 围栏与前后杂文）。
    const { extractBalancedJson } = await import('../../src/agent/canon-extractor');
    const entries: JudgeEntry[] = [];
    for (const chapter of judgeChapters) {
      if (!dir) break;
      const contract = await readChapterContract(dir, chapter);
      if (!contract) continue;
      const content = await fs.readFile(chapterBodyFile(dir, chapter), 'utf-8');
      const entry: JudgeEntry = { chapter, ok: false };
      try {
        const raw = await callPiOnce(
          buildJudgePrompt(chapter, content, contract.pov, contract.cast),
          dir,
          JUDGE_TIMEOUT_MS,
        );
        const candidate = extractBalancedJson(raw);
        const parsed = candidate ? (JSON.parse(candidate) as { scores?: Record<string, unknown>; notes?: unknown }) : null;
        const dims: Array<[keyof JudgeEntry, string]> = [
          ['plotCoherence', 'plot_coherence'],
          ['characterConsistency', 'character_consistency'],
          ['logicConsistency', 'logic_consistency'],
        ];
        const scores = dims.map(([key, dim]) => [key, Number(parsed?.scores?.[dim])] as const);
        if (scores.every(([, v]) => Number.isFinite(v) && v >= 1 && v <= 5)) {
          entry.ok = true;
          for (const [key, v] of scores) {
            if (key === 'plotCoherence') entry.plotCoherence = v;
            else if (key === 'characterConsistency') entry.characterConsistency = v;
            else entry.logicConsistency = v;
          }
          if (typeof parsed?.notes === 'string') entry.notes = parsed.notes;
        } else {
          entry.error = '无法从模型输出解析 1-5 分的 rubric JSON';
        }
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
      entries.push(entry);
      console.log(
        `[eval] judge 第${chapter}章 ${entry.ok
          ? `plot ${entry.plotCoherence}/char ${entry.characterConsistency}/logic ${entry.logicConsistency}`
          : `失败：${entry.error}`}`,
      );
    }

    const okEntries = entries.filter((e) => e.ok);
    const averages: Record<string, number> = {};
    for (const key of ['plotCoherence', 'characterConsistency', 'logicConsistency'] as const) {
      const vals = okEntries.map((e) => e[key]).filter((v): v is number => typeof v === 'number');
      averages[key] = vals.length
        ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
        : 0;
    }
    result.judge = {
      status: okEntries.length > 0 ? 'ran' : 'failed',
      model: `${settings.provider}/${settings.model || '(默认)'}`,
      entries,
      averages,
    };
    console.log(
      `[eval] judge ${result.judge.status}：${okEntries.length}/${entries.length} 章评分成功；` +
      `均分 plot ${averages.plotCoherence} / char ${averages.characterConsistency} / logic ${averages.logicConsistency}`,
    );
    // LLM 失败不判评测失败：只要求产物结构完整。
    expect(result.judge.entries).toHaveLength(judgeChapters.length);
  }, JUDGE_SAMPLE * JUDGE_TIMEOUT_MS + 60_000);
});

/** 采样结果必须至少包含一个非空上下文（防止实现退化为返回空串）。 */
function contextStillValid(
  samples: Array<{ chapter: number; ms: number; contextChars: number }>,
): boolean {
  return samples.some((s) => s.contextChars > 0);
}
