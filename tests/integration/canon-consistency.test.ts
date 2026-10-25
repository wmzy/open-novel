// @vitest-environment node
/**
 * P1-b：100 章一致性规模回归。
 *
 * 验收（docs/改进计划-内置Pi-SDK.md §6）：
 * - 三类 P0 注入（pov-missing / must-not-reveal-present / dead-entity-cast）命中 ≥90%；
 * - major 注入（cast-missing / must-reveal-missing / word-budget）命中 ≥80%；
 * - 干净章节零 blocker 误报（fixture 设计下应为零 findings）；
 * - buildCanonContext 在 100 章台账规模下 < 500ms。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

const CHAPTERS = 100;

let dir: string;
let injections: ConsistencyInjection[];
let findingsByChapter: Map<number, ContractFinding[]>;
let injectedChapters: Set<number>;

/** 从洗牌序列中按条件取 n 个不重叠章号（烧掉不满足条件的章号，保持确定性）。 */
function deal(shuffled: number[], from: number, pred: (c: number) => boolean, n: number): { taken: number[]; next: number } {
  const taken: number[] = [];
  let idx = from;
  while (taken.length < n && idx < shuffled.length) {
    if (pred(shuffled[idx])) taken.push(shuffled[idx]);
    idx += 1;
  }
  if (taken.length < n) throw new Error(`洗牌池不足以分配 ${n} 个满足条件的章号`);
  return { taken, next: idx };
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-consistency-'));
  await buildConsistencyFixture(dir, { chapters: CHAPTERS, seed: 20261025 });

  // 确定性抽取互不重叠的注入章号（42 ≈ 40 个矛盾）。
  const rand = mulberry32(20261107);
  const shuffled = Array.from({ length: CHAPTERS }, (_, i) => i + 1);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // 全部退场实体在第 49 章前退场，>60 的章号必有 dead-entity-cast 候选。
  const first = deal(shuffled, 0, (c) => c > 60, 10);
  const rest = deal(shuffled, first.next, () => true, 10 + 10 + 5 + 4 + 4);

  injections = [
    ...first.taken.map((chapter) => ({
      chapter, kind: 'dead-entity-cast', expectSeverity: 'blocker', expectCode: 'dead-entity-cast',
    } as const)),
    ...rest.taken.slice(0, 10).map((chapter) => ({
      chapter, kind: 'pov-missing', expectSeverity: 'blocker', expectCode: 'pov-missing',
    } as const)),
    ...rest.taken.slice(10, 20).map((chapter) => ({
      chapter, kind: 'must-not-reveal-present', expectSeverity: 'blocker', expectCode: 'must-not-reveal-present',
    } as const)),
    ...rest.taken.slice(20, 25).map((chapter) => ({
      chapter, kind: 'cast-missing', expectSeverity: 'major', expectCode: 'cast-missing',
    } as const)),
    ...rest.taken.slice(25, 29).map((chapter) => ({
      chapter, kind: 'must-reveal-missing', expectSeverity: 'major', expectCode: 'must-reveal-missing',
    } as const)),
    ...rest.taken.slice(29, 33).map((chapter) => ({
      chapter, kind: 'word-budget', expectSeverity: 'major', expectCode: 'word-budget',
    } as const)),
  ];
  await injectContradictions(dir, injections);

  injectedChapters = new Set(injections.map((i) => i.chapter));
  const canon = await readCanon(dir);
  findingsByChapter = new Map();
  for (let chapter = 1; chapter <= CHAPTERS; chapter++) {
    const contract = await readChapterContract(dir, chapter);
    if (!contract) throw new Error(`第 ${chapter} 章缺少合同`);
    const content = await fs.readFile(chapterBodyFile(dir, chapter), 'utf-8');
    findingsByChapter.set(chapter, validateChapterContract({ content, contract, canon }));
  }
}, 120_000);

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function hitRate(list: ConsistencyInjection[]) {
  const missed = list.filter(
    (i) => !(findingsByChapter.get(i.chapter) ?? []).some(
      (f) => f.code === i.expectCode && f.severity === i.expectSeverity,
    ),
  );
  return { total: list.length, hits: list.length - missed.length, missed };
}

describe('100 章一致性 fixture', () => {
  it('P0 注入（pov-missing / must-not-reveal-present / dead-entity-cast）命中 ≥90%', () => {
    const p0 = injections.filter((i) => i.expectSeverity === 'blocker');
    const byKind = (kind: string) => hitRate(p0.filter((i) => i.kind === kind));
    const perKind = ['pov-missing', 'must-not-reveal-present', 'dead-entity-cast']
      .map((kind) => {
        const r = byKind(kind);
        return `${kind} ${r.hits}/${r.total}`;
      })
      .join('，');
    const result = hitRate(p0);
    console.log(`[一致性回归] P0 命中 ${result.hits}/${result.total}（${perKind}）；未命中：${
      result.missed.map((m) => `第${m.chapter}章/${m.kind}`).join('、') || '无'
    }`);
    expect(result.hits / result.total).toBeGreaterThanOrEqual(0.9);
  });

  it('major 注入（cast-missing / must-reveal-missing / word-budget）命中 ≥80%', () => {
    const majors = injections.filter((i) => i.expectSeverity === 'major');
    const result = hitRate(majors);
    const perKind = ['cast-missing', 'must-reveal-missing', 'word-budget']
      .map((kind) => {
        const r = hitRate(majors.filter((i) => i.kind === kind));
        return `${kind} ${r.hits}/${r.total}`;
      })
      .join('，');
    console.log(`[一致性回归] major 命中 ${result.hits}/${result.total}（${perKind}）；未命中：${
      result.missed.map((m) => `第${m.chapter}章/${m.kind}`).join('、') || '无'
    }`);
    expect(result.hits / result.total).toBeGreaterThanOrEqual(0.8);
  });

  it('干净章节零 findings（含零 blocker 误报）', () => {
    const clean = Array.from({ length: CHAPTERS }, (_, i) => i + 1).filter((c) => !injectedChapters.has(c));
    const offenders = clean
      .map((c) => ({ chapter: c, findings: findingsByChapter.get(c) ?? [] }))
      .filter((r) => r.findings.length > 0);
    console.log(`[一致性回归] 干净章节 ${clean.length}/${CHAPTERS}，误报 ${offenders.length} 章`);
    expect(offenders).toEqual([]);
  });

  it('buildCanonContext 100 章台账规模 < 500ms', async () => {
    const names = ['沈青梧', '陆云帆', '顾长风', '白锦瑟'];
    const start = Date.now();
    const context = await buildCanonContext(dir, CHAPTERS, names);
    const elapsed = Date.now() - start;
    console.log(`[一致性回归] buildCanonContext 耗时 ${elapsed}ms（输出 ${context.length} 字符）`);
    expect(elapsed).toBeLessThan(500);
    expect(context).toContain('Canon 台账');
  });
});
