// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendCanonChanges,
  buildCanonContext,
  buildContractContext,
  contractFilePath,
  readCanon,
  readChapterContract,
  recordContractOverride,
  removeChapterContract,
  shiftChapterContracts,
  validateChapterContract,
  writeChapterContract,
  writeCanon,
  type ChapterContract,
} from '../../../src/shared/canon';

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canon-'));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe('canon ledger', () => {
  it('追加实体/事实/知情边界，并把旧事实标记为 superseded', async () => {
    const first = await appendCanonChanges(projectDir, {
      entities: [
        { name: '林岚', type: 'character', aliases: ['阿岚'] },
        { name: '青云宗', type: 'faction' },
      ],
      facts: [{ subject: '林岚', predicate: 'location', object: '山门' }],
      knowledge: { 林岚: { knows: ['师父遇害'], doesNotKnow: ['真凶身份'] } },
    }, 3);
    expect(first.warnings).toEqual([]);
    expect(first.ledger.entities).toHaveLength(2);
    expect(first.ledger.facts[0]).toMatchObject({ subject: '林岚', predicate: 'location', object: '山门', validFrom: 3 });

    const second = await appendCanonChanges(projectDir, {
      facts: [{ subject: '林岚', predicate: 'location', object: '后山' }],
      knowledge: { 林岚: { knows: ['真凶身份'], doesNotKnow: ['掌门立场'] } },
    }, 8);
    const facts = second.ledger.facts;
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ object: '山门', status: 'superseded', validTo: 7 });
    expect(facts[1]).toMatchObject({ object: '后山', status: 'active', validFrom: 8 });
    expect(second.ledger.knowledge['林岚'].knows).toEqual(['师父遇害', '真凶身份']);
    expect(second.ledger.knowledge['林岚'].doesNotKnow).toEqual(['掌门立场']);

    const rawLog = await fs.readFile(path.join(projectDir, '.novel', 'canon', 'changes.jsonl'), 'utf-8');
    expect(rawLog.trim().split('\n')).toHaveLength(2);
  });

  it('全量写入后可读回，损坏文件返回空台账', async () => {
    await writeCanon(projectDir, {
      version: 1,
      entities: [{ id: 'e1', name: '林岚', type: 'character', aliases: [], status: 'active' }],
      facts: [],
      knowledge: {},
      updatedAt: '',
    });
    const ledger = await readCanon(projectDir);
    expect(ledger.entities[0]).toMatchObject({ id: 'e1', name: '林岚' });

    await fs.writeFile(path.join(projectDir, '.novel', 'canon', 'canon.json'), '{broken', 'utf-8');
    const empty = await readCanon(projectDir);
    expect(empty.entities).toEqual([]);
  });
});

describe('chapter contract', () => {
  const base: Omit<ChapterContract, 'updatedAt'> = {
    version: 1,
    chapter: 3,
    pov: '林岚',
    cast: ['林岚', '师父'],
    beats: ['山门夜谈', '发现密信'],
    mustReveal: ['密信'],
    mustNotReveal: ['真凶身份'],
    wordBudget: { target: 1000, min: 600, max: 1400 },
    status: 'frozen',
  };

  it('写入/读取合同', async () => {
    await writeChapterContract(projectDir, 3, base);
    const contract = await readChapterContract(projectDir, 3);
    expect(contract).toMatchObject({ chapter: 3, pov: '林岚', status: 'frozen' });
    expect(await fs.readFile(contractFilePath(projectDir, 3), 'utf-8')).toContain('林岚');
  });

  it('POV 缺失/禁止揭示是 blocker，出场缺失/字数越界是 major', async () => {
    const contract = { ...base, updatedAt: '' } as ChapterContract;
    const findings = validateChapterContract({
      content: '# 第3章\n\n师父说：真凶身份不能告诉你。',
      contract,
    });
    expect(findings.some((f) => f.code === 'pov-missing' && f.severity === 'blocker')).toBe(true);
    expect(findings.some((f) => f.code === 'must-not-reveal-present' && f.severity === 'blocker')).toBe(true);
    expect(findings.some((f) => f.code === 'cast-missing')).toBe(true);
    expect(findings.some((f) => f.code === 'word-budget' && f.severity === 'major')).toBe(true);
  });

  it('满足合同时没有 blocker/major', async () => {
    const contract = { ...base, updatedAt: '' } as ChapterContract;
    const content = `# 第3章\n\n${'林岚与师父在山门夜谈，发现密信。'.repeat(80)}`;
    const findings = validateChapterContract({ content, contract });
    expect(findings.filter((f) => f.severity !== 'minor')).toEqual([]);
  });

  it('canon 别名可满足出场检查，未知角色给 minor', async () => {
    const ledger = await appendCanonChanges(projectDir, {
      entities: [{ name: '林岚', type: 'character', aliases: ['阿岚'] }],
    }, 1);
    const contract = { ...base, pov: '阿岚', cast: ['阿岚', '路人甲'], updatedAt: '' } as ChapterContract;
    const findings = validateChapterContract({
      content: `# 第3章\n\n${'阿岚发现密信。'.repeat(100)}`,
      contract,
      canon: ledger.ledger,
    });
    expect(findings.some((f) => f.code === 'pov-missing')).toBe(false);
    expect(findings.some((f) => f.code === 'cast-missing' && f.message.includes('路人甲'))).toBe(true);
    expect(findings.some((f) => f.code === 'unknown-cast' && f.message.includes('路人甲'))).toBe(true);
  });
});

describe('prompt context', () => {
  it('注入 canon 实体/有效事实与合同硬约束', async () => {
    await appendCanonChanges(projectDir, {
      entities: [{ name: '林岚', type: 'character', aliases: ['阿岚'] }],
      facts: [{ subject: '林岚', predicate: 'location', object: '山门' }],
      knowledge: { 林岚: { knows: ['师父遇害'] } },
    }, 2);
    await writeChapterContract(projectDir, 3, {
      pov: '林岚',
      cast: ['林岚'],
      beats: ['发现密信'],
      mustReveal: ['密信'],
      mustNotReveal: ['真凶身份'],
      wordBudget: { target: 1000 },
      status: 'frozen',
    });

    const canon = await buildCanonContext(projectDir, 3, ['林岚']);
    expect(canon).toContain('Canon 台账');
    expect(canon).toContain('林岚');
    expect(canon).toContain('location = 山门');
    expect(canon).toContain('已知：师父遇害');

    const contract = await buildContractContext(projectDir, 3);
    expect(contract).toContain('章节合同（第3章，已冻结');
    expect(contract).toContain('禁止提前揭示：真凶身份');
  });

  it('删除/重编号时清理或平移合同', async () => {
    await writeChapterContract(projectDir, 1, { pov: 'A', status: 'frozen' });
    await writeChapterContract(projectDir, 2, { pov: 'B', status: 'frozen' });
    await writeChapterContract(projectDir, 3, { pov: 'C', status: 'frozen' });

    await shiftChapterContracts(projectDir, 2);
    expect(await readChapterContract(projectDir, 1)).toMatchObject({ pov: 'A' });
    expect(await readChapterContract(projectDir, 2)).toMatchObject({ pov: 'C' });
    expect(await readChapterContract(projectDir, 3)).toBeNull();

    await removeChapterContract(projectDir, 2);
    expect(await readChapterContract(projectDir, 2)).toBeNull();
  });

  it('强制定稿留痕写入 overrides.jsonl', async () => {
    await recordContractOverride(projectDir, 3, [{ severity: 'blocker', code: 'pov-missing', message: 'x' }], '作者确认');
    const raw = await fs.readFile(path.join(projectDir, '.novel', 'canon', 'overrides.jsonl'), 'utf-8');
    expect(raw).toContain('作者确认');
    expect(raw).toContain('pov-missing');
  });
});
