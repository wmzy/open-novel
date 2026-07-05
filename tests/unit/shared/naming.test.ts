import { describe, it, expect } from 'vitest';
import {
  charToPinyin,
  nameToPinyin,
  nameToPinyinString,
  isAllSameTone,
} from '../../../src/shared/naming/pinyin';
import {
  checkHomophone,
  checkCollision,
  checkPhonetics,
  checkSimilarity,
  checkRarity,
  checkName,
  editDistance,
} from '../../../src/shared/naming/name-checker';
import {
  generatePersonNames,
} from '../../../src/shared/naming/name-generator';
import {
  getSurnamesByRegion,
  matchImagery,
  getRegions,
  getNamingCustoms,
} from '../../../src/shared/naming/imagery-store';

describe('pinyin', () => {
  it('charToPinyin 返回正确的拼音和声调', () => {
    const info = charToPinyin('沈');
    expect(info).not.toBeNull();
    expect(info!.pinyin).toBe('shěn');
    expect(info!.base).toBe('shen');
    expect(info!.tone).toBe(3);
  });

  it('charToPinyin 对非汉字返回 null', () => {
    expect(charToPinyin('a')).toBeNull();
    expect(charToPinyin('1')).toBeNull();
  });

  it('nameToPinyin 解析多字名字', () => {
    const infos = nameToPinyin('林冲');
    expect(infos).toHaveLength(2);
    expect(infos[0]!.pinyin).toBe('lín');
    expect(infos[1]!.pinyin).toBe('chōng');
  });

  it('nameToPinyinString 返回空格分隔的拼音', () => {
    expect(nameToPinyinString('林冲')).toBe('lín chōng');
  });

  it('isAllSameTone 检测全组同声调', () => {
    // 寂(jì,4) 寒(hán,2) → 不同
    expect(isAllSameTone('寂寒')).toBe(false);
    // 用全四声字测试
    expect(isAllSameTone('墨寂')).toBe(true); // mò(4) jì(4)
  });

  it('isAllSameTone 对单字返回 false', () => {
    expect(isAllSameTone('萧')).toBe(false);
  });
});

describe('name-checker', () => {
  describe('checkHomophone', () => {
    it('检测尴尬谐音', () => {
      // 史 shǐ → 屎
      const result = checkHomophone('史珍');
      expect(result.hit).toBe(true);
    });

    it('正常名字不触发', () => {
      const result = checkHomophone('林冲');
      expect(result.hit).toBe(false);
    });
  });

  describe('checkCollision', () => {
    it('检测完全重名', () => {
      const result = checkCollision('林冲', ['林冲', '孙二娘']);
      expect(result.hit).toBe(true);
      expect(result.target).toBe('林冲');
    });

    it('不重名时不触发', () => {
      const result = checkCollision('宋江', ['林冲', '孙二娘']);
      expect(result.hit).toBe(false);
    });
  });

  describe('checkPhonetics', () => {
    it('全组同声调触发', () => {
      // 墨(mò,4) 寂(jì,4) → 全四声
      const result = checkPhonetics('墨寂');
      expect(result.hit).toBe(true);
    });

    it('声调不同不触发', () => {
      const result = checkPhonetics('林冲');
      expect(result.hit).toBe(false);
    });
  });

  describe('checkSimilarity', () => {
    it('编辑距离≤1判定相似', () => {
      // 林言 vs 林冲 → 只差一个字
      const result = checkSimilarity('林言', ['林冲']);
      expect(result.hit).toBe(true);
      expect(result.target).toBe('林冲');
    });

    it('编辑距离>1不触发', () => {
      const result = checkSimilarity('宋江', ['林冲']);
      expect(result.hit).toBe(false);
    });
  });

  describe('checkRarity', () => {
    it('常用字不触发', () => {
      const result = checkRarity('林冲');
      expect(result.hit).toBe(false);
    });
  });

  describe('checkName（组合检查）', () => {
    it('谐音命中标记 reject', () => {
      const result = checkName('史珍', []);
      expect(result.reject).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('正常名字 reject=false', () => {
      const result = checkName('林冲', ['孙二娘']);
      expect(result.reject).toBe(false);
    });

    it('撞名标记 reject', () => {
      const result = checkName('林冲', ['林冲', '孙二娘']);
      expect(result.reject).toBe(true);
    });
  });

  describe('editDistance', () => {
    it('相同字符串距离为 0', () => {
      expect(editDistance('林冲', '林冲')).toBe(0);
    });

    it('差一个字距离为 1', () => {
      expect(editDistance('林冲', '林言')).toBe(1);
    });

    it('完全不同距离为长度', () => {
      expect(editDistance('萧', '宋江')).toBe(2);
    });
  });
});

describe('imagery-store', () => {
  it('getRegions 返回所有区域', () => {
    const regions = getRegions();
    expect(regions.length).toBeGreaterThanOrEqual(8);
    expect(regions).toContain('江南');
    expect(regions).toContain('塞北');
  });

  it('getSurnamesByRegion 返回区域姓氏并按 tier 排序', () => {
    const surnames = getSurnamesByRegion('江南');
    expect(surnames.length).toBeGreaterThan(5);
    expect(surnames[0]!.tier).toBeLessThanOrEqual(surnames[surnames.length - 1]!.tier);
  });

  it('未知区域回退到江淮默认姓氏', () => {
    const surnames = getSurnamesByRegion('不存在的地方');
    expect(surnames.length).toBeGreaterThan(0);
    expect(surnames.some((s) => s.surname === '王')).toBe(true);
  });

  it('matchImagery 按关键词返回意象字', () => {
    const entries = matchImagery(['深沉']);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.char === '渊')).toBe(true);
    expect(entries.some((e) => e.char === '墨')).toBe(true);
  });

  it('matchImagery 按性别过滤', () => {
    const male = matchImagery(['华美'], { gender: 'male' });
    // "锦" 是 female 倾向，male 过滤应排除
    expect(male.some((e) => e.char === '锦')).toBe(false);
  });

  it('getNamingCustoms 返回时代习俗', () => {
    const customs = getNamingCustoms('先秦');
    expect(customs.nameLength).toBe('single');
  });

  it('getNamingCustoms 未知时代返回模糊古代', () => {
    const customs = getNamingCustoms('未来时代');
    expect(customs.nameLength).toBe('any');
  });
});

describe('name-generator', () => {
  it('generatePersonNames 返回候选列表', () => {
    const candidates = generatePersonNames({
      imageryKeywords: ['深沉', '远方'],
      region: '江南',
      count: 5,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(5);
  });

  it('候选包含名字、拼音、出处', () => {
    const candidates = generatePersonNames({
      imageryKeywords: ['深沉'],
      region: '江南',
      count: 3,
    });
    for (const c of candidates) {
      expect(c.name.length).toBeGreaterThanOrEqual(2);
      expect(c.pinyin).toBeTruthy();
      expect(c.surname).toBeTruthy();
      expect(c.source).not.toBeNull();
      expect(c.imageryTags.length).toBeGreaterThan(0);
    }
  });

  it('surnameConstraint 约束姓氏', () => {
    const candidates = generatePersonNames({
      imageryKeywords: ['深沉'],
      surnameConstraint: '萧',
      count: 5,
    });
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.surname).toBe('萧');
    }
  });

  it('existingNames 过滤撞名候选', () => {
    const candidates = generatePersonNames({
      imageryKeywords: ['深沉'],
      region: '江南',
      existingNames: ['沈渊'], // 精确撞名
      count: 20,
    });
    // 沈渊不应出现在候选中（reject 被过滤）
    expect(candidates.find((c) => c.name === '沈渊')).toBeUndefined();
  });

  it('gender 过滤生效', () => {
    const male = generatePersonNames({
      imageryKeywords: ['华美'],
      gender: 'male',
      region: '江南',
      count: 10,
    });
    // 锦是 female 倾向，male 模式下不应出现含"锦"的名字
    for (const c of male) {
      expect(c.givenName).not.toContain('锦');
    }
  });

  it('空关键词返回空数组', () => {
    const candidates = generatePersonNames({
      imageryKeywords: [],
      count: 5,
    });
    expect(candidates).toEqual([]);
  });

  it('模糊古代区域回退到默认姓氏', () => {
    const candidates = generatePersonNames({
      imageryKeywords: ['深沉'],
      region: '模糊古代',
      count: 5,
    });
    expect(candidates.length).toBeGreaterThan(0);
  });
});
