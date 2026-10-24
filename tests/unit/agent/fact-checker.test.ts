import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  isSingleEditApart,
  detectNameAnomalies,
  extractKnowledgeTerms,
  detectPovLeakage,
  detectMechanicalFactIssues,
  buildFactCheckPrompt,
  parseFactCheckResponse,
  type FactKnowledgeInput,
} from '../../../src/agent/quality-checker';
import {
  buildPovKnowledgeLayer,
  formatPovKnowledgeSection,
} from '../../../src/agent/chapter-context';
import {
  normalizeKnowledgeTable,
  parseKnowledgeFile,
  readCharacterKnowledge,
  readCharacterRoster,
} from '../../../src/agent/context-manager';

describe('isSingleEditApart', () => {
  it('识别一次替换/插入/删除', () => {
    expect(isSingleEditApart('林青', '林清')).toBe(true);
    expect(isSingleEditApart('林青', '林青儿')).toBe(true);
    expect(isSingleEditApart('林青儿', '林青')).toBe(true);
    expect(isSingleEditApart('林青', '青林')).toBe(false); // 换位不算一次编辑
    expect(isSingleEditApart('林青', '林青')).toBe(false);
    expect(isSingleEditApart('林青', '林青儿们')).toBe(false);
  });
});

describe('detectNameAnomalies', () => {
  it('检出与角色名册仅差一字的疑似笔误（fixture: near-duplicate name）', () => {
    const findings = detectNameAnomalies(
      '林清说：“师父不会回来了。”\n林青沉默着，没有应声。',
      3,
      ['林青'],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('name-inconsistency');
    expect(findings[0].severity).toBe('minor');
    expect(findings[0].source).toBe('mechanical');
    expect(findings[0].character).toBe('林青');
    expect(findings[0].quote).toContain('林清');
  });

  it('不会把普通词语误判为人名笔误（林间小路）', () => {
    const findings = detectNameAnomalies(
      '林间小路通向山坳。林青说：“走吧。”',
      2,
      ['林青'],
    );
    expect(findings).toEqual([]);
  });

  it('别名笔误归属到规范角色名', () => {
    const findings = detectNameAnomalies(
      '青歌笑道：“好。”',
      4,
      [{ name: '青哥', canonical: '林青' }],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].character).toBe('林青');
    expect(findings[0].detail).toContain('别名');
  });

  it('已登记的人名/别名不会被当作笔误', () => {
    const findings = detectNameAnomalies('青歌笑道：“好。”', 4, [
      { name: '青哥', canonical: '林青' },
      { name: '青歌', canonical: '苏晚' },
    ]);
    expect(findings).toEqual([]);
  });

  it('较短真名不会被较长已登记名字的子串误报', () => {
    const findings = detectNameAnomalies('林青儿说：“我来了。”', 5, ['林青', '林青儿']);
    expect(findings).toEqual([]);
  });
});

describe('extractKnowledgeTerms', () => {
  it('剥离否定/所属前缀，保留内容词与后缀 2-gram', () => {
    expect(extractKnowledgeTerms('不知道自己的真实身世')).toContain('身世');
    expect(extractKnowledgeTerms('自己是被收养的')).toContain('收养');
    expect(extractKnowledgeTerms('玉佩的真正来历')).toContain('来历');
  });

  it('空事实返回空数组', () => {
    expect(extractKnowledgeTerms('')).toEqual([]);
    expect(extractKnowledgeTerms('不知道')).toEqual([]);
  });
});

describe('detectPovLeakage', () => {
  const knowledge: FactKnowledgeInput = {
    name: '林青',
    knows: [{ fact: '师父是被毒死的', learnedIn: 5 }],
    doesNotKnow: ['自己的真实身世'],
  };

  it('POV 同段落使用「尚不知」信息 → 报告越界（fixture: leak）', () => {
    const text = '林青握紧信纸，低声道：“原来我的身世是这样。”';
    const findings = detectPovLeakage(text, 3, '林青', knowledge);
    expect(findings.some((f) => f.type === 'pov-leakage')).toBe(true);
    const leak = findings.find((f) => f.type === 'pov-leakage')!;
    expect(leak.severity).toBe('major');
    expect(leak.character).toBe('林青');
    expect(leak.detail).toContain('尚不知');
    expect(leak.quote).toContain('身世');
  });

  it('关键词只出现在他人段落 → 不报越界（fixture: no-leak）', () => {
    const text = '老者低声道：“你的身世……”\n林青没有回答，转身走进雨里。';
    const findings = detectPovLeakage(text, 3, '林青', knowledge);
    expect(findings).toEqual([]);
  });

  it('POV 明确写「并不知道」时不算越界（negated no-leak）', () => {
    const text = '林青并不知道自己的真实身世，只是隐约觉得不安。';
    const findings = detectPovLeakage(text, 3, '林青', knowledge);
    expect(findings).toEqual([]);
  });

  it('POV 尚未到 learnedIn 章即使用该信息 → 提前知情', () => {
    const text = '林青说：“师父是被毒死的，我早就知道。”';
    const findings = detectPovLeakage(text, 3, '林青', knowledge);
    const premature = findings.find((f) => f.type === 'pov-leakage' && f.detail.includes('提前知情'));
    expect(premature).toBeDefined();
    expect(premature!.detail).toContain('第 5 章');
  });

  it('到达 learnedIn 章后不再报提前知情', () => {
    const text = '林青说：“师父是被毒死的，我早就知道。”';
    const findings = detectPovLeakage(text, 5, '林青', knowledge);
    expect(findings).toEqual([]);
  });

  it('缺少知情边界数据时不做任何推断', () => {
    const text = '林青说：“原来我的身世是这样。”';
    expect(detectPovLeakage(text, 3, '林青', undefined)).toEqual([]);
  });
});

describe('detectMechanicalFactIssues', () => {
  it('合并 POV 越界与人名笔误并按严重度排序', () => {
    const findings = detectMechanicalFactIssues({
      chapterText: '林清说：“林青，原来你的身世是这样。”\n林青沉默着，没有应声。',
      chapter: 2,
      pov: '林青',
      roster: ['林青'],
      knowledge: { name: '林青', knows: [], doesNotKnow: ['自己的真实身世'] },
    });
    expect(findings.some((f) => f.type === 'pov-leakage')).toBe(true);
    expect(findings.some((f) => f.type === 'name-inconsistency')).toBe(true);
    expect(findings[0].severity).toBe('major');
  });
});

describe('buildPovKnowledgeLayer (IO)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-pov-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function writeKnowledge(entries: unknown[]) {
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'character-knowledge.json'),
      JSON.stringify({ characters: entries }),
      'utf-8',
    );
  }

  it('无知识表且 state.json 无 knows → 返回空串（提示词不变）', async () => {
    expect(await buildPovKnowledgeLayer(dir, '林青')).toBe('');
    expect(await buildPovKnowledgeLayer(dir, '')).toBe('');
  });

  it('读取专属知识表并格式化已知/尚不知', async () => {
    await writeKnowledge([{
      name: '林青',
      knows: [{ fact: '密道在厨房后面', learnedIn: 2 }],
      doesNotKnow: ['自己的真实身世'],
      updatedChapter: 3,
    }]);
    const layer = await buildPovKnowledgeLayer(dir, '林青');
    expect(layer).toContain('### POV 知情边界（林青）');
    expect(layer).toContain('密道在厨房后面');
    expect(layer).toContain('（第2章获知）');
    expect(layer).toContain('**尚不知（禁止以此行动）**');
    expect(layer).toContain('自己的真实身世');
  });

  it('只注入当前章之前已获知的事实（learnedIn ≤ 当前章，state 兜底不越过边界）', async () => {
    await writeKnowledge([{
      name: '林青',
      knows: [
        { fact: '早期事实：密道在厨房后面', learnedIn: 1 },
        { fact: '未来事实：国师是内奸', learnedIn: 9 },
      ],
      doesNotKnow: [],
    }]);
    // state.json 中也可能残留同名事实——不得绕过 learnedIn 边界提前注入
    await fs.writeFile(
      path.join(dir, '.novel', 'state.json'),
      JSON.stringify({
        characters: [{ name: '林青', location: '', emotion: '', knows: ['未来事实：国师是内奸'], relationships: {}, lastAppearance: 1 }],
        timeline: '',
        activeForeshadows: [],
        lastUpdatedChapter: 1,
        updatedAt: '2026-01-01',
      }),
      'utf-8',
    );
    const layer = await buildPovKnowledgeLayer(dir, '林青', 3);
    expect(layer).toContain('早期事实');
    expect(layer).not.toContain('未来事实');
  });

  it('兼容 state.json 的 knows（旧项目无需迁移）', async () => {
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'state.json'),
      JSON.stringify({
        characters: [{ name: '林青', location: '', emotion: '', knows: ['密道'], relationships: {}, lastAppearance: 1 }],
        timeline: '',
        activeForeshadows: [],
        lastUpdatedChapter: 1,
        updatedAt: '2026-01-01',
      }),
      'utf-8',
    );
    const layer = await buildPovKnowledgeLayer(dir, '林青');
    expect(layer).toContain('密道');
    expect(layer).not.toContain('尚不知');
  });

  it('注入受条数与字符预算约束', async () => {
    const knows = Array.from({ length: 20 }, (_, i) => ({
      fact: `第${i + 1}条事实：${'密'.repeat(80)}`,
      learnedIn: i + 1,
    }));
    await writeKnowledge([{ name: '林青', knows, doesNotKnow: [] }]);
    const layer = await buildPovKnowledgeLayer(dir, '林青');
    expect(layer.length).toBeLessThan(1500);
    // 只保留最近 8 条
    expect(layer).toContain('第20条事实');
    expect(layer).not.toContain('第1条事实');
  });

  it('formatPovKnowledgeSection 空数据返回空串', () => {
    expect(formatPovKnowledgeSection('林青', [], [])).toBe('');
    expect(formatPovKnowledgeSection('', [{ fact: 'x' }], [])).toBe('');
  });
});

describe('knowledge table normalization', () => {
  it('兼容角色名映射形态并去重', () => {
    const entries = normalizeKnowledgeTable({
      '林青': { knows: ['密道', { fact: '密道', learnedIn: 2 }], doesNotKnow: ['身世', '身世'] },
      '苏晚': { knows: [{ content: '账本在抽屉里', learnedIn: 3 }], unknown: ['林青的真实身份'] },
      updatedAt: '2026-01-01',
    });
    expect(entries).toHaveLength(2);
    const lin = entries.find((e) => e.name === '林青')!;
    expect(lin.knows).toHaveLength(1);
    expect(lin.knows[0].learnedIn).toBe(2);
    expect(lin.doesNotKnow).toEqual(['身世']);
    const su = entries.find((e) => e.name === '苏晚')!;
    expect(su.knows[0].fact).toBe('账本在抽屉里');
    expect(su.doesNotKnow).toEqual(['林青的真实身份']);
  });

  it('损坏 JSON 返回空表', () => {
    expect(parseKnowledgeFile('{oops')).toEqual([]);
  });

  it('readCharacterKnowledge 读取 .novel/character-knowledge.json', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-kn-'));
    try {
      await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.novel', 'character-knowledge.json'),
        JSON.stringify({ characters: [{ name: '林青', knows: ['密道'], doesNotKnow: [] }] }),
      );
      const entries = await readCharacterKnowledge(dir);
      expect(entries[0].name).toBe('林青');
      expect(entries[0].knows[0].fact).toBe('密道');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('readCharacterRoster', () => {
  it('从标题式档案、独立档案目录与知识表汇总姓名与别名', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-roster-'));
    try {
      const novel = path.join(dir, '.novel');
      await fs.mkdir(path.join(novel, 'characters', 'profiles'), { recursive: true });
      await fs.writeFile(
        path.join(novel, 'characters', 'profiles.md'),
        ['# 角色档案', '', '## 林青（青哥）', '- **性格**：沉稳', '', '## 苏晚（主角）', '- **性格**：机敏'].join('\n'),
      );
      await fs.writeFile(path.join(novel, 'characters', 'profiles', '沈砚.md'), '# 沈砚');
      await fs.writeFile(
        path.join(novel, 'character-knowledge.json'),
        JSON.stringify({ characters: [{ name: '陆知白', knows: [], doesNotKnow: [] }] }),
      );
      const roster = await readCharacterRoster(dir);
      const names = roster.map((entry) => entry.name);
      expect(names).toContain('林青');
      expect(names).toContain('苏晚');
      expect(names).toContain('沈砚');
      expect(names).toContain('陆知白');
      const lin = roster.find((entry) => entry.name === '林青')!;
      expect(lin.aliases).toContain('青哥');
      const su = roster.find((entry) => entry.name === '苏晚')!;
      expect(su.aliases).toEqual([]); // 「主角」是定位标注，不是别名
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildFactCheckPrompt / parseFactCheckResponse', () => {
  it('prompt 包含正文、名册、知情边界与严格 JSON 输出约束', () => {
    const prompt = buildFactCheckPrompt({
      chapter: 7,
      chapterText: '林青走进客栈，把信纸按在桌上。',
      pov: '林青',
      roster: [{ name: '林青', aliases: ['青哥'] }, { name: '苏晚', aliases: [] }],
      knowledge: {
        name: '林青',
        knows: [
          { fact: '密道在厨房后面', learnedIn: 2 },
          { fact: '国师是内奸', learnedIn: 9 },
        ],
        doesNotKnow: ['自己的真实身世'],
      },
      timeline: '第一夜，雪停之后。',
      previousSummary: '林青得到一封无名信。',
      outline: '## 第 7 章：夜访',
    });
    expect(prompt).toContain('第7章');
    expect(prompt).toContain('林青走进客栈');
    expect(prompt).toContain('别名：青哥');
    expect(prompt).toContain('自己的真实身世');
    expect(prompt).not.toContain('国师是内奸');
    expect(prompt).toContain('pov-leakage|name-inconsistency|canon-contradiction');
    expect(prompt).toContain('不要调用任何写入工具');
    expect(prompt).toContain('"findings":[]');
  });

  it('解析带 markdown 围栏的 JSON，并归一化 type/severity', () => {
    const output = '```json\n' + JSON.stringify({
      findings: [
        {
          type: 'POV Leakage',
          severity: '严重',
          chapter: 7,
          character: '林青',
          quote: '林青说：“我知道你的身世。”',
          detail: 'POV 使用了尚不知的信息',
          suggestion: '补写获知过程',
        },
        { type: 'name-inconsistency', severity: 'minor', quote: '林清说' },
        { type: 'unknown-type', severity: 'blocker', quote: '丢弃' },
        { type: 'canon-contradiction', severity: 'minor', quote: '' },
      ],
    }) + '\n```';
    const findings = parseFactCheckResponse(output, 7);
    expect(findings).not.toBeNull();
    expect(findings).toHaveLength(2);
    expect(findings![0].type).toBe('pov-leakage');
    expect(findings![0].severity).toBe('blocker');
    expect(findings![0].source).toBe('semantic');
    expect(findings![0].character).toBe('林青');
    expect(findings![1].type).toBe('name-inconsistency');
  });

  it('空 findings 返回空数组；无法解析返回 null', () => {
    expect(parseFactCheckResponse('{"findings":[]}', 3)).toEqual([]);
    expect(parseFactCheckResponse('我觉得这一章很好，没有问题。', 3)).toBeNull();
    expect(parseFactCheckResponse('', 3)).toBeNull();
  });
});
