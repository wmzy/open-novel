import { describe, it, expect } from 'vitest';
import { parseOutlineChapters, buildStoryTimeline } from '../../../src/shared/diagram-builders';
import type { OutlineChapter } from '../../../src/shared/diagram-builders';

const SAMPLE = `# 《示例集》详细大纲·卷一《示例卷》

## 卷一总览

| 项目 | 数值 |
|------|------|
| 总字数 | 约16万字 |

## 序章：序章（1章）

#### 第1章：启程前夜
| 项目 | 内容 |
|------|------|
| POV | 武松 |
| 核心事件 | 磨剑 |
| 出场角色 | 武松（独角戏） |

## 第一篇：出山

#### 第2章：下山
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
      title: '下山',
      pov: '武松',
      cast: ['武松', '小镇百姓'],
      section: expect.any(String),
    });
  });

  it('连读章节（第16-17章）取首个章号', () => {
    const chapters = parseOutlineChapters(`#### 第16-17章：南京\n| POV | 武松 |`);
    expect(chapters[0].number).toBe(16);
    expect(chapters[0].title).toBe('南京');
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
    { number: 1, title: '启程前夜', pov: '武松', cast: ['武松'], section: '第一篇 出山' },
    { number: 2, title: '下山', pov: '武松', cast: ['武松', '小镇百姓'], section: '第一篇 出山' },
    { number: 16, title: '南京', pov: '武松', cast: ['武松', '鲁智深'], section: '第二篇 南京' },
  ];

  it('空数组返回 null', () => {
    expect(buildStoryTimeline([])).toBeNull();
  });

  it('生成 timeline 源码，含 title 与 section 划分', () => {
    const tl = buildStoryTimeline(chapters);
    expect(tl).not.toBeNull();
    expect(tl!).toContain('timeline');
    expect(tl!).toContain('section 第一篇 出山');
    expect(tl!).toContain('section 第二篇 南京');
  });

  it('每个章节节点含章号 + POV', () => {
    const tl = buildStoryTimeline(chapters);
    expect(tl!).toContain('第1章 启程前夜');
    expect(tl!).toContain('POV 武松');
  });

  it('同一 section 的章节归到同一 section 块（不重复 section 标题）', () => {
    const tl = buildStoryTimeline(chapters)!;
    const sectionCount = (tl.match(/section 第一篇 出山/g) || []).length;
    expect(sectionCount).toBe(1);
  });
});
