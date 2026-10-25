import { describe, it, expect } from 'vitest';
import {
  formatForPublish,
  formatChapterForPublish,
  publishChapterTitle,
  PUBLISH_RULES,
  PUBLISH_TARGETS,
} from '../../../src/shared/publish-formats';

const ch1 = {
  number: 1,
  title: '起风',
  // 覆盖：全角段首缩进、粗体、引用、标题行、围栏、列表、分隔线、链接/图片、行内码
  content: [
    '　　雪落了三天，**他**握紧了刀。',
    '> 老人说：风要来了。',
    '看[地图](https://example.com/map)和![插图](img.png)，再按`F5`刷新。',
    '---',
    '```',
    '固若金汤',
    '```',
  ].join('\n'),
};

describe('publish-formats 四平台规则', () => {
  it('规则表覆盖四平台且标签齐全', () => {
    expect(PUBLISH_TARGETS).toEqual(['qidian', 'fanqie', 'qimao', 'jinjiang']);
    for (const target of PUBLISH_TARGETS) {
      expect(PUBLISH_RULES[target].label).toBeTruthy();
    }
  });

  it('qidian/jinjiang：章名独立行 + 标题后单空行 + 段落间单空行，markdown 全剥离、无段首缩进', () => {
    const expected = [
      '第1章 起风',
      '',
      '雪落了三天，他握紧了刀。',
      '',
      '老人说：风要来了。',
      '',
      '看地图和插图，再按F5刷新。',
      '',
      '固若金汤',
    ].join('\n');
    expect(formatChapterForPublish('qidian', ch1)).toBe(expected);
    expect(formatChapterForPublish('jinjiang', ch1)).toBe(expected);
  });

  it('fanqie：与起点一致但标题行后多一个空行', () => {
    const text = formatChapterForPublish('fanqie', ch1);
    expect(text.startsWith('第1章 起风\n\n\n雪落了三天，他握紧了刀。')).toBe(true);
    // 段落间仍是单空行
    expect(text).toContain('他握紧了刀。\n\n老人说：风要来了。');
  });

  it('qimao：段落间无空行（每段一行）', () => {
    expect(formatChapterForPublish('qimao', ch1)).toBe([
      '第1章 起风',
      '',
      '雪落了三天，他握紧了刀。',
      '老人说：风要来了。',
      '看地图和插图，再按F5刷新。',
      '固若金汤',
    ].join('\n'));
  });

  it('全本合并：各章按平台空行策略衔接', () => {
    const ch2 = { number: 2, title: '夜行', content: '第二章第一段。' };
    expect(formatForPublish('qimao', [ch1, ch2])).toBe(
      `${formatChapterForPublish('qimao', ch1)}\n\n第2章 夜行\n\n第二章第一段。`,
    );
    expect(formatForPublish('qidian', [ch1, ch2])).toBe(
      `${formatChapterForPublish('qidian', ch1)}\n\n\n第2章 夜行\n\n第二章第一段。`,
    );
  });
});

describe('publish-formats 章名与边界', () => {
  it('标题自带旧编号时剥掉，避免「第2章 第2章」', () => {
    expect(publishChapterTitle(2, '第2章 夜行')).toBe('第2章 夜行');
    expect(publishChapterTitle(3, '第三章 破晓')).toBe('第3章 破晓');
    expect(publishChapterTitle(4, '')).toBe('第4章');
    expect(publishChapterTitle(5, null)).toBe('第5章');
  });

  it('正文首行与章名重复时只保留生成的章名行', () => {
    const ch = { number: 1, title: '起风', content: '# 第1章 起风\n\n正文第一段。' };
    expect(formatChapterForPublish('qidian', ch)).toBe('第1章 起风\n\n正文第一段。');
  });

  it('空章：只有章名行；缺失章：占位说明', () => {
    const empty = { number: 9, title: '空章', content: '' };
    expect(formatChapterForPublish('qidian', empty)).toBe('第9章 空章\n\n');
    const missing = { number: 10, title: '缺失', content: null };
    expect(formatChapterForPublish('qidian', missing)).toBe('第10章 缺失\n\n（本章正文文件缺失，导出时未包含）');
  });

  it('正文中的正常武侠用语与 markdown 相邻星号不受剥离影响', () => {
    const ch = { number: 1, title: '', content: '他一剑**刺出**，剑光如*流星*。\n3. 有序列表项\n——破折线开头不受列表剥离影响' };
    expect(formatChapterForPublish('qimao', ch)).toBe(
      '第1章\n\n他一剑刺出，剑光如流星。\n有序列表项\n——破折线开头不受列表剥离影响',
    );
  });
});
