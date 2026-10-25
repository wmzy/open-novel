import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SENSITIVE_WORDS,
  parseSensitiveWordsFile,
  scanSensitiveWords,
} from '../../../src/shared/sensitive-words';

describe('sensitive-words 词表', () => {
  it('默认词表规模在约定区间且无重复', () => {
    expect(DEFAULT_SENSITIVE_WORDS.length).toBeGreaterThanOrEqual(60);
    expect(DEFAULT_SENSITIVE_WORDS.length).toBeLessThanOrEqual(100);
    expect(new Set(DEFAULT_SENSITIVE_WORDS).size).toBe(DEFAULT_SENSITIVE_WORDS.length);
  });

  it('词表文件解析：每行一词，# 注释与空行忽略，去重去空白', () => {
    expect(parseSensitiveWordsFile('# 项目级词表\n\n  玄铁重剑  \n灵气紊乱\n玄铁重剑\n')).toEqual([
      '玄铁重剑',
      '灵气紊乱',
    ]);
    expect(parseSensitiveWordsFile('')).toEqual([]);
  });
});

describe('sensitive-words 扫描', () => {
  it('命中默认词表：计数正确、按命中数降序', () => {
    const text = '城东新开了一家赌场，赌场里人声鼎沸。有人偷偷带着冰毒进门。';
    const hits = scanSensitiveWords(text);
    expect(hits.map((h) => h.word)).toEqual(['赌场', '冰毒']);
    expect(hits[0].count).toBe(2);
    expect(hits[1].count).toBe(1);
  });

  it('样本：最多 3 处，含 ±20 字上下文与准确下标', () => {
    const prefix = '前'.repeat(30);
    const word = '赌场';
    const suffix = '后'.repeat(30);
    const text = `${prefix}${word}${suffix}${'x'.repeat(5)}${word}再次${word}三现${word}四现`;
    const hits = scanSensitiveWords(text);
    expect(hits[0].count).toBe(4);
    expect(hits[0].samples).toHaveLength(3); // 样本封顶 3 处
    const first = hits[0].samples[0];
    expect(first.index).toBe(30);
    // ±20 字上下文：slice(10, 52)
    expect(first.context).toBe(text.slice(30 - 20, 30 + word.length + 20));
    expect(first.context.startsWith('前'.repeat(20))).toBe(true);
    expect(first.context.endsWith('后'.repeat(20))).toBe(true);
  });

  it('chapter 参数写入样本，缺省为 null', () => {
    const hit = scanSensitiveWords('去了赌场', [], 7)[0];
    expect(hit.samples[0].chapter).toBe(7);
    expect(scanSensitiveWords('去了赌场')[0].samples[0].chapter).toBeNull();
  });

  it('自定义词表与默认合并（含大小写不敏感），去重不重复计数', () => {
    const text = '他体内的灵气紊乱起来，顺手掏出K粉。';
    const hits = scanSensitiveWords(text, ['灵气紊乱', '  灵气紊乱  ', 'K粉']);
    // K粉 与默认表重复（默认已有），合并后只算一个词；匹配不区分 ASCII 大小写。
    // 计数并列，断言用码点排序避免 localeCompare 环境差异。
    expect(hits.map((h) => h.word).sort()).toEqual(['K粉', '灵气紊乱'].sort());
    expect(hits[0].count).toBe(1);
    expect(hits[1].count).toBe(1);
  });

  it('干净文本零命中；正常武侠用语不入表', () => {
    const text = '他杀出重围，一剑灭门之仇得报，凌迟处死的刑罚在王朝早已废止。';
    expect(scanSensitiveWords(text)).toEqual([]);
  });
});
