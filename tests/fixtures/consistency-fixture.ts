/**
 * 种子化一致性 fixture：确定性生成 N 章小说项目（正文 + 冻结合同 + canon 台账），
 * 并支持向指定章注入可预期的矛盾，用于 validateChapterContract 的规模化回归。
 *
 * 约定：
 * - 全部随机性来自 mulberry32 种子（禁止 Math.random），同 seed 输出逐字节一致；
 * - 干净章节必须零 findings：正文含 POV/全部 cast 名与全部 mustReveal 词，
 *   不含任何 mustNotReveal 短语与死亡实体名，CJK 字数落在合同预算内；
 * - mustNotReveal 用唯一合成短语（「幽泉圣骸·卷17」风格），与句子模板词汇零交集。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  readCanon,
  readChapterContract,
  writeCanon,
  writeChapterContract,
  type CanonEntity,
  type CanonFact,
  type CanonKnowledgeEntry,
  type CanonLedger,
  type ChapterContract,
} from '../../src/shared/canon';

/** 确定性 PRNG（mulberry32）：返回 [0, 1) 均匀浮点。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

/** 不放回抽取 n 个（n 超过池大小时取全部）。 */
function sample<T>(rand: () => number, arr: readonly T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

function countCjk(text: string): number {
  return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
}

// 活跃角色池：名字互不为子串，避免 content.includes 的跨名误命中。
const ACTIVE_POOL = [
  '沈青梧', '陆云帆', '顾长风', '白锦瑟', '裴远山',
  '谢明澜', '温如许', '萧疏影', '姜慕晴', '霍去疾',
  '孟拾遗', '崔九思',
] as const;

// 已退场角色池：第 4 + i*9 章起死亡/失踪（i = 0..5 → 4..49，均落在 100 章内）。
const DEAD_POOL = [
  { name: '秦无衣', alias: '无衣先生' },
  { name: '柳惊鸿', alias: '惊鸿剑' },
  { name: '段孤峰', alias: '孤峰客' },
  { name: '阮星河', alias: '星河上人' },
  { name: '岳承影', alias: '承影翁' },
  { name: '柯梦得', alias: '梦得居士' },
] as const;

// mustReveal 词库：仅通过专用句子写入正文，其他模板绝不包含。
const REVEAL_TERMS = [
  '青岚剑谱', '北境军报', '沉香木匣', '旧盟书信', '密库钥匙', '族印残页', '渡口账本', '药庐丹方',
] as const;

// mustNotReveal 词根：只用于拼装禁止短语，绝不进入正文模板词汇。
const FORBIDDEN_STEMS = ['幽泉圣骸', '焚天血契', '玄夜遗诏', '蚀骨蛊引', '龙脉残图'] as const;

const ROLE_FACTS = ['斥候出身', '账房出身', '医者出身', '镖师出身', '讼师出身', '琴师出身'] as const;
const PLACE_FACTS = ['临安城', '北岸渡口', '南山别院', '西市客栈', '旧盐场', '青石巷'] as const;

// 句子模板：无名字填充句 + POV 专属句 + cast 台词句 + 揭示句。
// 模板词汇与 FORBIDDEN_STEMS / REVEAL_TERMS / 死亡实体名零交集。
const FILLER_LINES = [
  '夜风穿过廊下，灯火晃了一晃。',
  '远处传来更鼓声，城门大约已经落锁。',
  '案上的茶凉了半盏，没人去续。',
  '雨点敲着窗纸，像有人在轻轻叩门。',
  '地图被收起，指尖在桌面上划出一道浅痕。',
  '巷口的灯笼熄了一盏，行人渐渐少了。',
  '檐下的铜铃轻响，惊起一只夜鸦。',
  '烛火毕剥一声，影子在墙上晃了晃。',
  '石阶上的青苔被雨水泡得发亮。',
  '更夫的梆子声由远及近，又慢慢远去。',
] as const;

const POV_LINES = [
  (n: string) => `${n}知道，今夜之后很多事情回不了头。`,
  (n: string) => `${n}数着更漏，把方才的对话在心里又过了一遍。`,
  (n: string) => `${n}合上册子，指腹在封皮的刻痕上停了停。`,
] as const;

const CAST_LINES = [
  (n: string) => `${n}压低了声音，把话说得极慢。`,
  (n: string) => `${n}抬眼看了看天色，又低下头去。`,
  (n: string) => `过了半晌，${n}才开口应了一声。`,
  (n: string) => `${n}把手中的信笺折好，收进袖中。`,
  (n: string) => `${n}沿着回廊走了几步，忽然停下。`,
] as const;

const revealLine = (speaker: string, term: string) => `${speaker}终于道出了${term}的下落。`;

export type InjectionKind =
  | 'pov-missing'
  | 'must-not-reveal-present'
  | 'dead-entity-cast'
  | 'cast-missing'
  | 'must-reveal-missing'
  | 'word-budget';

export interface ConsistencyInjection {
  chapter: number;
  kind: InjectionKind;
  expectSeverity: 'blocker' | 'major';
  expectCode: InjectionKind;
}

export interface ConsistencyFixtureMeta {
  cleanChapters: number[];
  injected: ConsistencyInjection[];
  activeCharacters: string[];
  deadEntities: Array<{ name: string; alias: string; deathChapter: number }>;
}

export function chapterBodyFile(dir: string, chapter: number): string {
  return path.join(dir, '.novel', 'chapters', `第${chapter}章.md`);
}

function deadDeathChapter(index: number): number {
  return 4 + index * 9;
}

/**
 * 生成 N 章（默认 100）一致性 fixture：
 * - 正文：`.novel/chapters/第N章.md`，POV/cast 名与 mustReveal 词必然出现；
 * - 合同：`.novel/contracts/第N章.json`（frozen，wordBudget 按实际 CJK 字数收紧）；
 * - 台账：`.novel/canon/canon.json`（活跃实体 + 死亡/失踪实体 + 事实 + 知情边界）。
 *
 * 返回元数据；生成完毕时全部章节都是干净章节（injected 为空，由注入函数补充记录）。
 */
export async function buildConsistencyFixture(
  dir: string,
  opts: { chapters?: number; seed?: number } = {},
): Promise<ConsistencyFixtureMeta> {
  const chapters = opts.chapters ?? 100;
  if (chapters < 1) throw new Error('chapters 必须 ≥ 1');
  const rand = mulberry32(opts.seed ?? 20261025);
  await fs.mkdir(path.join(dir, '.novel', 'chapters'), { recursive: true });

  // ---- canon 台账 ----
  const entities: CanonEntity[] = ACTIVE_POOL.map((name, i) => ({
    id: `char-${i + 1}`,
    name,
    type: 'character',
    aliases: [],
    description: `活跃角色 ${name}`,
    sourceChapter: 1,
    status: 'active',
  }));
  // 末位退场者用 lost 状态，覆盖 dead/lost 两种判定分支。
  DEAD_POOL.forEach((d, i) => {
    entities.push({
      id: `dead-${i + 1}`,
      name: d.name,
      type: 'character',
      aliases: [d.alias],
      description: `已退场角色 ${d.name}`,
      sourceChapter: deadDeathChapter(i),
      status: i === DEAD_POOL.length - 1 ? 'lost' : 'dead',
    });
  });

  const facts: CanonFact[] = [];
  ACTIVE_POOL.forEach((name, i) => {
    facts.push({
      id: `fact-role-${i + 1}`,
      subject: name,
      predicate: '出身',
      object: ROLE_FACTS[i % ROLE_FACTS.length],
      validFrom: 1,
      sourceChapter: 1,
      status: 'active',
      confidence: 'confirmed',
    });
    facts.push({
      id: `fact-place-${i + 1}`,
      subject: name,
      predicate: '所在地',
      object: PLACE_FACTS[i % PLACE_FACTS.length],
      validFrom: 1,
      sourceChapter: 1,
      status: 'active',
      confidence: 'confirmed',
    });
  });
  // 偶数位退场者附「结局 = 死亡/失踪」事实（覆盖事实推断路径）；
  // 奇数位仅靠 sourceChapter 回退推断，两条路径都被规模回归覆盖。
  DEAD_POOL.forEach((d, i) => {
    if (i % 2 !== 0 && i !== DEAD_POOL.length - 1) return;
    facts.push({
      id: `fact-exit-${i + 1}`,
      subject: d.name,
      predicate: i === DEAD_POOL.length - 1 ? '下落' : '结局',
      object: i === DEAD_POOL.length - 1 ? '失踪' : '死亡',
      validFrom: deadDeathChapter(i),
      sourceChapter: deadDeathChapter(i),
      status: 'active',
      confidence: 'confirmed',
    });
  });

  const knowledge: Record<string, CanonKnowledgeEntry> = {};
  ACTIVE_POOL.slice(0, 6).forEach((name) => {
    knowledge[name] = {
      knows: ['北境异动的传闻'],
      doesNotKnow: ['幕后主使的真实身份'],
      updatedChapter: 2,
    };
  });

  // ---- 章节正文 + 合同 ----
  for (let chapter = 1; chapter <= chapters; chapter++) {
    const pov = pick(rand, ACTIVE_POOL);
    const others = sample(
      rand,
      ACTIVE_POOL.filter((n) => n !== pov),
      2 + Math.floor(rand() * 2),
    );
    const cast = [pov, ...others];
    const reveals = sample(rand, REVEAL_TERMS, 1 + Math.floor(rand() * 2));
    const forbidden = sample(rand, FORBIDDEN_STEMS, 1 + Math.floor(rand() * 2)).map(
      (stem) => `${stem}·卷${chapter}`,
    );

    const targetCjk = 700 + Math.floor(rand() * 500);
    const lines: string[] = [pick(rand, POV_LINES)(pov)];
    for (const member of cast) lines.push(pick(rand, CAST_LINES)(member));
    for (const term of reveals) lines.push(revealLine(pov, term));
    while (countCjk(lines.join('')) < targetCjk) lines.push(pick(rand, FILLER_LINES));

    const content = `# 第${chapter}章\n\n${lines.join('\n\n')}\n`;
    const count = countCjk(content);
    await fs.writeFile(chapterBodyFile(dir, chapter), content, 'utf-8');
    const contract: Omit<ChapterContract, 'updatedAt'> = {
      version: 1,
      chapter,
      pov,
      cast,
      beats: [`第${chapter}节推进`, '线索合流'],
      mustReveal: [...reveals],
      mustNotReveal: forbidden,
      wordBudget: { min: Math.floor(count * 0.75), max: Math.ceil(count * 1.25), target: count },
      status: 'frozen',
    };
    await writeChapterContract(dir, chapter, contract);
  }

  await writeCanon(dir, { version: 1, entities, facts, knowledge, updatedAt: '' });

  return {
    cleanChapters: Array.from({ length: chapters }, (_, i) => i + 1),
    injected: [],
    activeCharacters: [...ACTIVE_POOL],
    deadEntities: DEAD_POOL.map((d, i) => ({ ...d, deathChapter: deadDeathChapter(i) })),
  };
}

/** 从台账中找出在指定章之前已退场（dead/lost）的实体；fixture 中 sourceChapter 即退场章。 */
function deadEntityForChapter(ledger: CanonLedger, chapter: number): CanonEntity | null {
  for (const entity of ledger.entities) {
    if (entity.status !== 'dead' && entity.status !== 'lost') continue;
    if ((entity.sourceChapter ?? Infinity) < chapter) return entity;
  }
  return null;
}

/**
 * 向指定章写入矛盾并重写对应文件（正文或合同）。注入是幂等意义下的单次操作：
 * 每种 kind 只依赖该章当前的合同/正文状态，不与其他注入共享章节时结果确定。
 * 返回传入的注入列表（便于调用方直接断言）。
 */
export async function injectContradictions(
  dir: string,
  injections: ConsistencyInjection[],
): Promise<ConsistencyInjection[]> {
  const ledger = await readCanon(dir);
  for (const injection of injections) {
    const file = chapterBodyFile(dir, injection.chapter);
    const content = await fs.readFile(file, 'utf-8');
    const contract = await readChapterContract(dir, injection.chapter);
    if (!contract) throw new Error(`第 ${injection.chapter} 章缺少合同，无法注入 ${injection.kind}`);

    switch (injection.kind) {
      case 'pov-missing': {
        // P0：POV 名字全部替换为中性指称，正文不再出现 POV。
        await fs.writeFile(file, content.split(contract.pov).join('那人'), 'utf-8');
        break;
      }
      case 'must-not-reveal-present': {
        // P0：把合同禁止的短语写进正文（追加句控制在字数预算余量内）。
        const term = contract.mustNotReveal[0];
        await fs.writeFile(file, `${content}\n\n他忽然想起「${term}」的旧闻。\n`, 'utf-8');
        break;
      }
      case 'dead-entity-cast': {
        // P0：合同 cast 换成已退场实体（保持 POV 不动，命中 dead-entity-cast blocker）。
        const dead = deadEntityForChapter(ledger, injection.chapter);
        if (!dead) {
          throw new Error(`第 ${injection.chapter} 章之前没有已退场实体，无法注入 dead-entity-cast`);
        }
        const victim = contract.cast.find((n) => n !== contract.pov) ?? contract.cast[0];
        const cast = contract.cast.map((n) => (n === victim ? dead.name : n));
        await writeChapterContract(dir, injection.chapter, { ...contract, cast });
        break;
      }
      case 'cast-missing': {
        // major：从正文删除一名非 POV cast 的名字。
        const victim = contract.cast.find((n) => n !== contract.pov);
        if (!victim) throw new Error(`第 ${injection.chapter} 章 cast 中没有非 POV 角色`);
        await fs.writeFile(file, content.split(victim).join('同伴'), 'utf-8');
        break;
      }
      case 'must-reveal-missing': {
        // major：把必须揭示的词从正文中替换掉。
        const term = contract.mustReveal[0];
        await fs.writeFile(file, content.split(term).join('旧物'), 'utf-8');
        break;
      }
      case 'word-budget': {
        // major：合同字数下限抬到正文 CJK 字数的 3 倍。
        const count = countCjk(content);
        await writeChapterContract(dir, injection.chapter, {
          ...contract,
          wordBudget: { ...contract.wordBudget, min: count * 3 },
        });
        break;
      }
    }
  }
  return injections;
}
