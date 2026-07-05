/**
 * 文本切片纯函数测试。
 * 归并建议：未来若有文本匹配相关单测可合并到本文件。
 */
import { describe, it, expect } from 'vitest';
import { splitTextByEntities } from '../../../src/shared/entity-linker';
import type { EntityRef } from '../../../src/shared/entity-dict';

function makeRef(name: string, type: EntityRef['type'] = 'character'): EntityRef {
  return { name, type, file: 'f.md', sectionTitle: name, sectionRaw: `## ${name}` };
}

describe('splitTextByEntities', () => {
  it('空词典返回整段文本', () => {
    const segs = splitTextByEntities('林冲出马', new Map());
    expect(segs).toEqual([{ text: '林冲出马' }]);
  });

  it('空文本返回空数组', () => {
    const segs = splitTextByEntities('', new Map([['林冲', makeRef('林冲')]]));
    expect(segs).toEqual([]);
  });

  it('单个实体匹配（汉字不限边界）', () => {
    const dict = new Map([['林冲', makeRef('林冲')]]);
    expect(splitTextByEntities('林冲道', dict)).toEqual([
      { ref: makeRef('林冲') },
      { text: '道' },
    ]);
  });

  it('实体在句尾', () => {
    const dict = new Map([['林冲', makeRef('林冲')]]);
    expect(splitTextByEntities('来了林冲', dict)).toEqual([
      { text: '来了' },
      { ref: makeRef('林冲') },
    ]);
  });

  it('实体在句中', () => {
    const dict = new Map([['林冲', makeRef('林冲')]]);
    expect(splitTextByEntities('只见林冲大笑', dict)).toEqual([
      { text: '只见' },
      { ref: makeRef('林冲') },
      { text: '大笑' },
    ]);
  });

  it('最长优先：林冲 vs 林冲之', () => {
    const dict = new Map([
      ['林冲', makeRef('林冲')],
      ['林冲之', makeRef('林冲之')],
    ]);
    expect(splitTextByEntities('林冲之道', dict)).toEqual([
      { ref: makeRef('林冲之') },
      { text: '道' },
    ]);
  });

  it('最长优先：正文是「林冲道」时匹配短的「林冲」', () => {
    const dict = new Map([
      ['林冲', makeRef('林冲')],
      ['林冲之', makeRef('林冲之')],
    ]);
    expect(splitTextByEntities('林冲道', dict)).toEqual([
      { ref: makeRef('林冲') },
      { text: '道' },
    ]);
  });

  it('多个实体密集', () => {
    const dict = new Map([
      ['林冲', makeRef('林冲')],
      ['宋江', makeRef('宋江')],
    ]);
    expect(splitTextByEntities('林冲与宋江', dict)).toEqual([
      { ref: makeRef('林冲') },
      { text: '与' },
      { ref: makeRef('宋江') },
    ]);
  });

  it('英文实体名做边界检查：Lin 不匹配 Linear', () => {
    const dict = new Map([['Lin', makeRef('Lin')]]);
    expect(splitTextByEntities('Linear algebra', dict)).toEqual([
      { text: 'Linear algebra' },
    ]);
  });

  it('英文实体名：a Lin b 匹配（前后是空格）', () => {
    const dict = new Map([['Lin', makeRef('Lin')]]);
    expect(splitTextByEntities('a Lin b', dict)).toEqual([
      { text: 'a ' },
      { ref: makeRef('Lin') },
      { text: ' b' },
    ]);
  });

  it('汉字实体名前后是英文也匹配', () => {
    const dict = new Map([['林冲', makeRef('林冲')]]);
    expect(splitTextByEntities('ab林冲cd', dict)).toEqual([
      { text: 'ab' },
      { ref: makeRef('林冲') },
      { text: 'cd' },
    ]);
  });

  it('无匹配返回整段文本', () => {
    const dict = new Map([['武松', makeRef('武松')]]);
    expect(splitTextByEntities('林冲出马', dict)).toEqual([{ text: '林冲出马' }]);
  });

  it('连续实体无间隔文本', () => {
    const dict = new Map([
      ['林冲', makeRef('林冲')],
      ['宋江', makeRef('宋江')],
    ]);
    expect(splitTextByEntities('林冲宋江', dict)).toEqual([
      { ref: makeRef('林冲') },
      { ref: makeRef('宋江') },
    ]);
  });
});
