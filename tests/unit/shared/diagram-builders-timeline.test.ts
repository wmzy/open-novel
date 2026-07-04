import { describe, it, expect } from 'vitest';
import {
  parseOutlineChapters,
  buildStoryTimeline,
  parseInteractionField,
  buildSequenceDiagram,
} from '../../../src/shared/diagram-builders';
import type { OutlineChapter } from '../../../src/shared/diagram-builders';

const SAMPLE = `# 《示例集》详细大纲·卷一

## 卷一总览

| 项目 | 数值 |
|------|------|
| 总字数 | 约16万字 |

## 序章

#### 第1章：启程前夜
| 项目 | 内容 |
|------|------|
| POV | 武松 |
| 核心事件 | 备战 |
| 出场角色 | 武松（独角戏） |

## 第一卷

#### 第2章：启程
| 项目 | 内容 |
|------|------|
| POV | 武松 |
| 核心事件 | 离开师门 |
| 出场角色 | 武松、小镇百姓 |
`;

describe('parseOutlineChapters', () => {
  it('解析所有章节锚点（含章号、标题、POV、出场角色）', () => {
    const chapters = parseOutlineChapters(SAMPLE);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]).toEqual({
      number: 1,
      title: '启程前夜',
      pov: '武松',
      cast: ['武松'],
      section: expect.any(String),
    });
    expect(chapters[1]).toEqual({
      number: 2,
      title: '启程',
      pov: '武松',
      cast: ['武松', '小镇百姓'],
      section: expect.any(String),
    });
  });

  it('连读章节（第16-17章）取首个章号', () => {
    const chapters = parseOutlineChapters(`#### 第16-17章：城镇\n| POV | 武松 |`);
    expect(chapters[0].number).toBe(16);
    expect(chapters[0].title).toBe('城镇');
  });

  it('无出场角色行时 cast 为空数组', () => {
    const chapters = parseOutlineChapters(`#### 第3章：无角色\n| POV | 武松 |\n| 核心事件 | test |`);
    expect(chapters[0].cast).toEqual([]);
  });

  it('出场角色去掉括号批注（如"武松（独角戏）"→"武松"）', () => {
    const chapters = parseOutlineChapters(`#### 第1章：x\n| 出场角色 | 武松（独角戏） |`);
    expect(chapters[0].cast).toEqual(['武松']);
  });

  it('空字符串返回空数组', () => {
    expect(parseOutlineChapters('')).toEqual([]);
  });
});

describe('buildStoryTimeline', () => {
  const chapters: OutlineChapter[] = [
    { number: 1, title: '启程前夜', pov: '武松', cast: ['武松'], section: '第一卷' },
    { number: 2, title: '启程', pov: '武松', cast: ['武松', '小镇百姓'], section: '第一卷' },
    { number: 16, title: '城镇', pov: '武松', cast: ['武松', '鲁智深'], section: '第二卷' },
  ];

  it('空数组返回 null', () => {
    expect(buildStoryTimeline([])).toBeNull();
  });

  it('短书（≤ maxPerChunk）返回单块，含 title 与 section 划分', () => {
    const chunks = buildStoryTimeline(chapters)!;
    expect(chunks).toHaveLength(1);
    expect(chunks[0].title).toBe('故事脉络');
    expect(chunks[0].chart).toContain('timeline');
    expect(chunks[0].chart).toContain('section 第一卷');
    expect(chunks[0].chart).toContain('section 第二卷');
  });

  it('每个章节节点含章号 + POV', () => {
    const chunks = buildStoryTimeline(chapters)!;
    expect(chunks[0].chart).toContain('第1章 启程前夜');
    expect(chunks[0].chart).toContain('POV 武松');
  });

  it('同一 section 的章节归到同一 section 块（不重复 section 标题）', () => {
    const chart = buildStoryTimeline(chapters)![0].chart;
    const sectionCount = (chart.match(/section 第一卷/g) || []).length;
    expect(sectionCount).toBe(1);
  });

  it('长书按 section 边界分块，不在 section 中间切', () => {
    // 3 个 section：S1(1-10)、S2(11-20)、S3(21-30)，maxPerChunk=12
    const long: OutlineChapter[] = [];
    for (let i = 1; i <= 10; i++) long.push({ number: i, title: `章${i}`, pov: '甲', cast: [], section: 'S1' });
    for (let i = 11; i <= 20; i++) long.push({ number: i, title: `章${i}`, pov: '乙', cast: [], section: 'S2' });
    for (let i = 21; i <= 30; i++) long.push({ number: i, title: `章${i}`, pov: '丙', cast: [], section: 'S3' });
    const chunks = buildStoryTimeline(long, 12)!;
    // 30 章 / 12 ≈ 3 块；切点不割裂 section
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 第一块应包含完整 S1（1-10），不被切在中间
    const firstChart = chunks[0].chart;
    expect(firstChart).toContain('第1章');
    expect(firstChart).toContain('第10章');
    // 每块节点数 ≤ maxPerChunk*2（硬上限）
    for (const c of chunks) {
      const nodeCount = (c.chart.match(/第\d+章/g) || []).length;
      expect(nodeCount).toBeLessThanOrEqual(24);
    }
    // 块标题含 section 名或章号范围
    expect(chunks[0].title).toMatch(/故事脉络/);
  });

  it('块标题用 section 名（去括号注释）', () => {
    // 3 个 section 各 10 章，maxPerChunk=12 → 跨 section 合并
    const long: OutlineChapter[] = [];
    for (let i = 1; i <= 10; i++) long.push({ number: i, title: `章${i}`, pov: '甲', cast: [], section: '第一篇：出山（约4章，1.5万字）' });
    for (let i = 11; i <= 20; i++) long.push({ number: i, title: `章${i}`, pov: '乙', cast: [], section: '第二篇：南京（约6章）' });
    const chunks = buildStoryTimeline(long, 12)!;
    // 第一块应含两个 section 名（去括号），用 → 连接
    expect(chunks[0].title).toContain('第一篇：出山');
    expect(chunks[0].title).toContain('第二篇：南京');
    expect(chunks[0].title).not.toContain('约4章'); // 括号注释已去除
    expect(chunks[0].title).toContain('→');
  });

  it('无 section 的章节归入同一块也能正常分块', () => {
    const noSec: OutlineChapter[] = [];
    for (let i = 1; i <= 30; i++) noSec.push({ number: i, title: `章${i}`, pov: '甲', cast: [], section: '' });
    const chunks = buildStoryTimeline(noSec, 12)!;
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 无 section 时不应该出现 section 行
    expect(chunks[0].chart).not.toContain('section ');
  });
});

describe('parseInteractionField', () => {
  it('解析单条交互', () => {
    const result = parseInteractionField('武松→何九叔[冲突]：被盘问');
    expect(result).toEqual([
      { from: '武松', to: '何九叔', type: '冲突', action: '被盘问' },
    ]);
  });

  it('解析多条交互（ · 分隔）', () => {
    const result = parseInteractionField('武松→何九叔[冲突]：被盘问 · 何九叔→武松[善意]：出手相助');
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({ from: '何九叔', to: '武松', type: '善意', action: '出手相助' });
  });

  it('空字符串返回空数组', () => {
    expect(parseInteractionField('')).toEqual([]);
  });

  it('（无）返回空数组', () => {
    expect(parseInteractionField('（无）')).toEqual([]);
  });

  it('格式错的整条跳过，不抛异常', () => {
    const result = parseInteractionField('武松→何九叔[冲突]：被盘问 · 乱七八糟的文本');
    expect(result).toHaveLength(1);
  });

  it('类型不在枚举内也接受（宽松匹配，只做结构校验）', () => {
    const result = parseInteractionField('A→B[自定义]：某事');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('自定义');
  });
});

describe('buildSequenceDiagram', () => {
  it('空交互返回 null', () => {
    expect(buildSequenceDiagram([])).toBeNull();
  });

  it('生成 sequenceDiagram 源码，含 participant 声明与箭头', () => {
    const interactions = [
      { from: '武松', to: '何九叔', type: '冲突', action: '被盘问' },
      { from: '何九叔', to: '武松', type: '善意', action: '出手相助' },
    ];
    const sd = buildSequenceDiagram(interactions);
    expect(sd).not.toBeNull();
    expect(sd!).toContain('sequenceDiagram');
    expect(sd!).toContain('participant 武松');
    expect(sd!).toContain('participant 何九叔');
    expect(sd!).toContain('武松->>何九叔: 被盘问');
  });

  it('participant 去重（同一角色多次出现只声明一次）', () => {
    const interactions = [
      { from: '武松', to: '何九叔', type: '冲突', action: 'a' },
      { from: '何九叔', to: '武松', type: '善意', action: 'b' },
    ];
    const sd = buildSequenceDiagram(interactions)!;
    const participantCount = (sd.match(/participant 武松/g) || []).length;
    expect(participantCount).toBe(1);
  });

  it('每条交互生成 Note over 标注类型', () => {
    const interactions = [{ from: 'A', to: 'B', type: '对决', action: 'x' }];
    const sd = buildSequenceDiagram(interactions)!;
    expect(sd).toContain('Note over A,B: 对决');
  });
});
