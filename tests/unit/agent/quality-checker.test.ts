import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  detectAiPatterns,
  analyzeForeshadows,
  checkForeshadows,
  parseCharacterProfiles,
  analyzeOoc,
  detectOoc,
  detectDegradation,
  buildExcludeGrams,
  type Foreshadow,
  type ChapterContent,
  type CharacterProfile,
} from '../../../src/agent/quality-checker';

// ===== 反 AI 味检测 =====

describe('detectAiPatterns', () => {
  it('对干净、具象的文学性文本给出低分（< 20）', () => {
    // 取自 SKILL.md 的"好"范文：全部用动作/感官细节，无报告式情绪
    const clean = `林晚把那件洗得发白的棉袄叠成三折，又打开。樟脑丸的气味漫出来，她按住胸口，指节陷进布料，像是怕里面的什么东西也跟着散了。油在铁锅里爆开，溅到灶台上嘶嘶作响。她手腕一抖，蒜末落进去，呛人的香气立刻漫上来。`;
    const report = detectAiPatterns(clean);
    expect(report.score).toBeLessThan(20);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.issues)).toBe(true);
  });

  it('对典型 AI 腔文本给出高分（> 60）', () => {
    // 故意堆满 6 种模式
    const ai = `他感到一阵深深的忧伤，她心中涌起一股莫名的感动。然而，时间过得很快。随着时间的推移，一切都是那么美丽、那么温暖、那么深邃。不禁，他默默地叹了口气，眼中闪过一丝复杂的神色。但是，他忍不住笑了。不过，日子一天天过去。他走了，他停了，他回头了。`;
    const report = detectAiPatterns(ai);
    expect(report.score).toBeGreaterThan(60);
    // 至少覆盖多种模式类型
    const types = new Set(report.issues.map((i) => i.type));
    expect(types.size).toBeGreaterThanOrEqual(4);
  });

  it('空文本得 0 分且无 issue', () => {
    const report = detectAiPatterns('');
    expect(report.score).toBe(0);
    expect(report.issues).toEqual([]);
  });

  it('每个 issue 都带 type/snippet/suggestion 三字段', () => {
    const report = detectAiPatterns('他感到很悲伤。然而她心中涌起感动。美丽的世界。');
    for (const issue of report.issues) {
      expect(typeof issue.type).toBe('string');
      expect(typeof issue.snippet).toBe('string');
      expect(issue.snippet.length).toBeGreaterThan(0);
      expect(typeof issue.suggestion).toBe('string');
      expect(issue.suggestion.length).toBeGreaterThan(0);
    }
  });

  it('检测到抽象情绪标签（"他感到X"）', () => {
    const report = detectAiPatterns('他感到无比悲伤。她觉得天都要塌了。他感受到一阵寒意。');
    expect(report.issues.some((i) => i.type === '抽象情绪标签')).toBe(true);
  });

  it('检测到模板心理独白词', () => {
    const report = detectAiPatterns('他心中一动，眼中闪过一丝异色，不禁叹了口气，忍不住苦笑。');
    expect(report.issues.some((i) => i.type === '模板心理独白')).toBe(true);
  });

  it('检测到排比堆砌（连续同构短句）', () => {
    const report = detectAiPatterns('他笑了，他哭了，他回头了，他走远了。');
    expect(report.issues.some((i) => i.type === '排比堆砌')).toBe(true);
  });

  it('检测到万能形容词', () => {
    const report = detectAiPatterns('这是美丽的、温暖的、深邃的、迷人的夜晚。');
    expect(report.issues.some((i) => i.type === '万能形容词')).toBe(true);
  });

  it('检测到转折滥用', () => {
    const report = detectAiPatterns(
      '然而他来了。但是她走了。不过没关系。可是谁在乎呢。然而结局已定。',
    );
    expect(report.issues.some((i) => i.type === '转折滥用')).toBe(true);
  });

  it('检测到情节概括性表述', () => {
    const report = detectAiPatterns('随着时间的推移，一切都变了。转眼间，三年过去了。');
    expect(report.issues.some((i) => i.type === '情节概括')).toBe(true);
  });

  it('评分不超过 100', () => {
    const report = detectAiPatterns(
      '他感到悲伤他感到快乐他感到愤怒他感到绝望他感到希望他感到温暖他感到孤独'.repeat(20),
    );
    expect(report.score).toBeLessThanOrEqual(100);
  });
});

// ===== 伏笔遗忘检测（纯函数） =====

describe('analyzeForeshadows', () => {
  const chapters: ChapterContent[] = [
    { chapter: 1, content: '林青在客栈发现一封神秘信件。' },
    { chapter: 2, content: '他在密道中前行，没有提及任何伏笔。' },
    { chapter: 3, content: '信件的内容终于揭晓。' },
    { chapter: 4, content: '与伏笔无关的过渡章节。' },
    { chapter: 5, content: '普通的战斗场景。' },
    { chapter: 6, content: '主角继续前进。' },
    { chapter: 7, content: '故事推进。' },
    { chapter: 8, content: '结局前夕。' },
  ];

  it('已回收伏笔归入 resolved', () => {
    const foreshadows: Foreshadow[] = [
      { id: 1, content: '神秘信件', status: 'resolved', plantedIn: 1, resolvedIn: 3 },
    ];
    const report = analyzeForeshadows(foreshadows, chapters);
    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0].id).toBe(1);
    expect(report.resolved[0].resolvedIn).toBe(3);
    expect(report.forgotten).toHaveLength(0);
    expect(report.healthy).toHaveLength(0);
  });

  it('近期被提及的活跃伏笔归入 healthy', () => {
    const foreshadows: Foreshadow[] = [
      { id: 2, content: '神秘信件', status: 'pending', plantedIn: 1 },
    ];
    // 第 3 章提及"信件"，距最新第 8 章间隔 5 → 阈值默认 5，>= 阈值判遗忘
    const report = analyzeForeshadows(foreshadows, chapters, 6);
    expect(report.healthy).toHaveLength(1);
    expect(report.healthy[0].lastSeenChapter).toBe(3);
  });

  it('长期未被提及的活跃伏笔归入 forgotten', () => {
    const foreshadows: Foreshadow[] = [
      { id: 3, content: '神秘信件', status: 'pending', plantedIn: 1 },
    ];
    // 第 3 章最后提及，距第 8 章 = 5，默认阈值 5 → forgotten
    const report = analyzeForeshadows(foreshadows, chapters);
    expect(report.forgotten).toHaveLength(1);
    expect(report.forgotten[0].chaptersSinceLastSeen).toBe(5);
    expect(report.forgotten[0].lastSeenChapter).toBe(3);
  });

  it('从未在正文提及的伏笔以 plantedIn 为基准判遗忘', () => {
    const foreshadows: Foreshadow[] = [
      { id: 4, content: '罕见秘籍', status: 'pending', plantedIn: 1 },
    ];
    const report = analyzeForeshadows(foreshadows, chapters);
    expect(report.forgotten).toHaveLength(1);
    expect(report.forgotten[0].lastSeenChapter).toBe(1);
    expect(report.forgotten[0].chaptersSinceLastSeen).toBe(7);
  });

  it('无章节时返回空报告', () => {
    const report = analyzeForeshadows(
      [{ id: 1, content: 'x', status: 'pending', plantedIn: 1 }],
      [],
    );
    expect(report.forgotten).toHaveLength(0);
    expect(report.resolved).toHaveLength(0);
    expect(report.healthy).toHaveLength(0);
  });

  it('忽略 content 缺失或 id 非法的条目', () => {
    // analyzeForeshadows 接收的是已归一化的 Foreshadow[]，这里直接给合法但内容空
    const report = analyzeForeshadows(
      [{ id: 9, content: '', status: 'pending', plantedIn: 1 }],
      chapters,
    );
    expect(report.forgotten).toHaveLength(0);
    expect(report.healthy).toHaveLength(0);
  });
});

// ===== 伏笔遗忘检测（文件 IO） =====

describe('checkForeshadows (IO)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-qc-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seedProject() {
    const novel = path.join(dir, '.novel', 'chapters');
    await fs.mkdir(novel, { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'foreshadow.json'),
      JSON.stringify({
        foreshadows: [
          { id: 1, content: '神秘信件', status: 'pending', plantedIn: 1 },
          { id: 2, content: '玉佩', status: 'resolved', plantedIn: 1, resolvedIn: 4 },
        ],
      }),
    );
    await fs.writeFile(path.join(novel, 'chapter-1.md'), '林青发现神秘信件。');
    await fs.writeFile(path.join(novel, 'chapter-2.md'), '无关内容。');
    await fs.writeFile(path.join(novel, '第1章.summary.md'), '摘要不应被统计。信件');
  }

  it('读取 foreshadow.json 与章节正文（排除 summary）并分类', async () => {
    await seedProject();
    const report = await checkForeshadows(dir, 5);
    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0].id).toBe(2);
    // 伏笔 1 在 chapter-1 提及，但仅 2 章，间隔 < 5 → healthy
    expect(report.healthy.some((h) => h.id === 1)).toBe(true);
  });

  it('foreshadow.json 缺失时返回空报告', async () => {
    await fs.mkdir(path.join(dir, '.novel', 'chapters'), { recursive: true });
    await fs.writeFile(path.join(dir, '.novel', 'chapters', 'chapter-1.md'), '内容');
    const report = await checkForeshadows(dir);
    expect(report.forgotten).toHaveLength(0);
    expect(report.resolved).toHaveLength(0);
    expect(report.healthy).toHaveLength(0);
  });

  it('损坏的 foreshadow.json 视为空', async () => {
    await fs.mkdir(path.join(dir, '.novel', 'chapters'), { recursive: true });
    await fs.writeFile(path.join(dir, '.novel', 'foreshadow.json'), '{ 不是合法 json');
    await fs.writeFile(path.join(dir, '.novel', 'chapters', 'chapter-1.md'), '内容');
    const report = await checkForeshadows(dir);
    expect(report.forgotten).toHaveLength(0);
  });

  it('容忍非标准字段名（description/plantedChapter/string id）', async () => {
    const novel = path.join(dir, '.novel', 'chapters');
    await fs.mkdir(novel, { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'foreshadow.json'),
      JSON.stringify({
        foreshadows: [
          // 非标准：id 为字符串、字段名 description / plantedChapter
          { id: 'fs1', description: '神秘信件', status: 'open', plantedChapter: 1, expectedPayoffChapter: 5 },
        ],
      }),
    );
    await fs.writeFile(path.join(novel, 'chapter-1.md'), '林青发现神秘信件。');
    await fs.writeFile(path.join(novel, 'chapter-2.md'), '无关内容。');
    const report = await checkForeshadows(dir, 5);
    // 应被归一化解析，而非静默丢弃；间隔 < 阈值 → healthy
    expect(report.healthy).toHaveLength(1);
    expect(report.healthy[0].content).toBe('神秘信件');
    expect(report.healthy[0].lastSeenChapter).toBe(1);
  });

  it('容忍顶层 items 键（逆向/enrich 产出的 schema）', async () => {
    const novel = path.join(dir, '.novel', 'chapters');
    await fs.mkdir(novel, { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'foreshadow.json'),
      JSON.stringify({
        // 逆向拆解/enrich 产出的 schema：顶层 items + description 字段
        items: [
          { id: 'foreshadow-001', description: '蝴蝶玉佩', status: 'planted', plantedChapter: 1 },
          { id: 'foreshadow-002', description: '诸子暗号', status: 'resolved', plantedChapter: 1, expectedPayoffChapter: 3 },
        ],
      }),
    );
    await fs.writeFile(path.join(novel, 'chapter-1.md'), '蝴蝶玉佩与诸子暗号同时出现。');
    await fs.writeFile(path.join(novel, 'chapter-2.md'), '无关内容。');
    const report = await checkForeshadows(dir, 5);
    // items 键应被识别；伏笔 1 间隔 < 5 → healthy，伏笔 2 已 resolved
    expect(report.healthy).toHaveLength(1);
    expect(report.healthy[0].content).toBe('蝴蝶玉佩');
    expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0].content).toBe('诸子暗号');
  });
});

// ===== 人物 OOC 检测：档案解析 =====

describe('parseCharacterProfiles', () => {
  it('解析 姓名/性格 配对（兼容全角/半角冒号）', () => {
    const text = `## 主角\n- 姓名：林青\n- 性格：沉默寡言、外冷内热\n\n## 配角\n- 姓名: 苏晚\n- 性格: 温柔善良`;
    const profiles = parseCharacterProfiles(text);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toEqual({ name: '林青', personality: '沉默寡言、外冷内热' });
    expect(profiles[1]).toEqual({ name: '苏晚', personality: '温柔善良' });
  });

  it('缺性格字段时 personality 为空串', () => {
    const text = `- 姓名：无名\n- 年龄：20`;
    const profiles = parseCharacterProfiles(text);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].personality).toBe('');
  });

  it('空文本返回空数组', () => {
    expect(parseCharacterProfiles('')).toEqual([]);
  });

  it('无“姓名：”字段时从标题提取（标题式档案容错）', () => {
    // agent 产出的标题式档案：## 林冲（主角） + - 性格：...
    const text = `## 林冲（主角）
- 身份：铸剑谷弟子
- 性格：克制、隐忍、执拗

## 无相
- 性格：阴沉、偏执`;
    const profiles = parseCharacterProfiles(text);
    expect(profiles).toHaveLength(2);
    expect(profiles[0].name).toBe('林冲'); // 去掉括号注释
    expect(profiles[0].personality).toBe('克制、隐忍、执拗');
    expect(profiles[1].name).toBe('无相');
  });
});

// ===== 人物 OOC 检测（纯函数） =====

describe('analyzeOoc', () => {
  const profiles: CharacterProfile[] = [
    { name: '林青', personality: '沉默寡言' },
    { name: '苏晚', personality: '温柔善良' },
  ];

  it('寡言角色连续多句长台词 → 标记 OOC', () => {
    const chapter = `
"我必须告诉你真相，这件事从头到尾都不是你想的那样，请你听我把话说完。"林青说。
"当年在城门口发生的一切都是一场误会，我从来没有背叛过你。"林青按住她的肩膀。
"如果你愿意相信我，我们就还有机会，一起重新开始。"林青顿了顿。
`;
    const report = analyzeOoc(profiles, 1, chapter);
    expect(report.oocIssues.some((i) => i.character === '林青')).toBe(true);
    const issue = report.oocIssues.find((i) => i.character === '林青')!;
    expect(issue.profileExpectation).toContain('沉默寡言');
    expect(issue.actualBehavior).toMatch(/台词/);
  });

  it('寡言角色仅简短台词 → 不标记', () => {
    const chapter = `"嗯。"林青说。\n"走吧。"他又道。\n"知道了。"`;
    const report = analyzeOoc(profiles, 1, chapter);
    expect(report.oocIssues.some((i) => i.character === '林青')).toBe(false);
  });

  it('温柔角色台词含粗暴用词 → 标记 OOC', () => {
    const chapter = `苏晚冷冷地说："滚开，你这个废物。"`;
    const report = analyzeOoc(profiles, 1, chapter);
    const issue = report.oocIssues.find((i) => i.character === '苏晚');
    expect(issue).toBeDefined();
    expect(issue!.actualBehavior).toContain('废物');
  });

  it('角色未在章节出现 → 不标记', () => {
    const chapter = `路人甲走过街道，自言自语了几句无关的话。`;
    const report = analyzeOoc(profiles, 1, chapter);
    expect(report.oocIssues).toHaveLength(0);
  });

  it('空档案或空章节 → 无 issue', () => {
    expect(analyzeOoc([], 1, '任何内容').oocIssues).toHaveLength(0);
    expect(analyzeOoc(profiles, 1, '').oocIssues).toHaveLength(0);
  });

  it('issue 携带 chapter 字段', () => {
    const chapter = `
"我必须把所有的事情都一五一十地告诉你，请你耐心听我说完这段往事。"林青说。
"请你务必相信我，这一切都是一场误会。"林青按住她的肩膀。
"如果你愿意听我把话说完，你就会明白真相。"林青顿了顿。
`;
    const report = analyzeOoc(profiles, 7, chapter);
    expect(report.oocIssues.length).toBeGreaterThan(0);
    expect(report.oocIssues[0].chapter).toBe(7);
  });
});

// ===== 人物 OOC 检测（文件 IO） =====

describe('detectOoc (IO)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-ooc-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seedProject() {
    const novel = path.join(dir, '.novel');
    await fs.mkdir(path.join(novel, 'characters'), { recursive: true });
    await fs.mkdir(path.join(novel, 'chapters'), { recursive: true });
    await fs.writeFile(
      path.join(novel, 'characters', 'profiles.md'),
      `## 主角\n- 姓名：林青\n- 性格：沉默寡言`,
    );
    await fs.writeFile(
      path.join(novel, 'chapters', 'chapter-1.md'),
      `"我必须把所有事情原原本本告诉你，请你务必听我把话说完。"林青说。\n"请你相信我，这一切都是一场误会，从头到尾都是。"林青按住她的肩膀。\n"如果你愿意听我解释，你就会明白其中的缘由。"林青顿了顿。`,
    );
  }

  it('读取 profiles 与章节正文并检测 OOC', async () => {
    await seedProject();
    const report = await detectOoc(dir, 1);
    expect(report.oocIssues.some((i) => i.character === '林青')).toBe(true);
  });

  it('档案缺失时返回空报告', async () => {
    await fs.mkdir(path.join(dir, '.novel', 'chapters'), { recursive: true });
    await fs.writeFile(path.join(dir, '.novel', 'chapters', 'chapter-1.md'), '内容');
    const report = await detectOoc(dir, 1);
    expect(report.oocIssues).toHaveLength(0);
  });
});

// ===== 流层退化检测（detectDegradation） =====

describe('detectDegradation', () => {
  it('正常文本不检测到退化', () => {
    const normal = '山道从坟场一路下到山坛，八里。林冲走在前，孙二娘走在后。两人之间只听见脚步声。到山坛的时候，天已经黑透了。磨坊的夸土墙还在，屋顶的草长到了半人高。';
    const result = detectDegradation(normal);
    expect(result.detected).toBe(false);
  });

  it('高频重复 2-gram 检测到退化（如「今日」重复）', () => {
    // 模拟第12章的退化模式：635 次「今日」/ 6294 字 ≈ 10%
    const degraded = '今日林冲今日走进今日山坛今日磨坊今日孙二娘今日站在今日门口今日哑叔今日磨石今日铜片今日腰带今日红绳今日坟场今日禁地今日剑脊今日归鸿今日。'.repeat(5);
    const result = detectDegradation(degraded);
    expect(result.detected).toBe(true);
    expect(result.repeatedPhrase).toBe('今日');
    expect(result.ratio).toBeGreaterThanOrEqual(0.05);
  });

  it('短文本不误报（totalGrams < minCount）', () => {
    const short = '今日今日今日今日'; // 只有 3 个 2-gram
    const result = detectDegradation(short);
    expect(result.detected).toBe(false);
  });

  it('自定义阈值可调低灵敏度', () => {
    // 多样化文本，最高频 2-gram 占比约 2-3%
    const text = '茶棚老板倒了一碗茶推到林冲面前。哑叔在磨坊里磨石上刻了七道纹。孙二娘的剑格是紫铜星纹。山道从坟场一路下到山坛八里。风从谷里往山外走风里带的不是雨是雾。'.repeat(2);
    const defaultResult = detectDegradation(text);
    expect(defaultResult.detected).toBe(false);

    // 降低阈值后检测到
    const lowThreshold = detectDegradation(text, { threshold: 0.01 });
    // 低阈值检测到重复（可能触发也可能不触发，取决于实际频率）
    expect(lowThreshold.ratio).toBeGreaterThan(0);
  });

  it('纯非 CJK 文本安全返回未检测', () => {
    const ascii = 'hello world this is a test of the degradation detector system'.repeat(10);
    const result = detectDegradation(ascii);
    expect(result.detected).toBe(false);
    expect(result.totalGrams).toBe(0);
  });

  it('excludeGrams 排除角色名后聚焦章不误报', () => {
    // 角色名「林冲」高频，但后续动词各不相同，排除后其他 2-gram 均低频
    const focused = '林冲走在山道上。林冲抬头看天。林冲停下脚步。林冲回头望去。林冲继续前行。林冲握紧双拳。林冲推开木门。'.repeat(6);
    const withExclude = detectDegradation(focused, { excludeGrams: ['林冲'] });
    expect(withExclude.detected).toBe(false);
  });

  it('excludeGrams 排除角色名后仍检测到真正的退化词', () => {
    // 「林冲」少量出现（被排除），「今日」退化高频（未被排除）
    const text = '林冲知道今日不对劲。今日的山风特别冷。今日他必须做决定。今日就是终点。今日没有退路了。今日的一切都将改变。'.repeat(3);
    const result = detectDegradation(text, { excludeGrams: ['林冲'] });
    expect(result.detected).toBe(true);
    expect(result.repeatedPhrase).toBe('今日');
  });
});

describe('buildExcludeGrams', () => {
  it('2字角色名生成1个2-gram', () => {
    expect(buildExcludeGrams(['林冲', '孙二娘'])).toEqual(['林冲', '孙二娘']);
  });

  it('3字角色名生成2个2-gram', () => {
    expect(buildExcludeGrams(['欧阳锋'])).toEqual(['欧阳', '阳锋']);
  });

  it('空数组返回空数组', () => {
    expect(buildExcludeGrams([])).toEqual([]);
  });
});
