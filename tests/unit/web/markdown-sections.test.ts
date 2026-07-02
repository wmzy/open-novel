import { describe, it, expect } from 'vitest';
import { parseSections, parseField } from '../../../src/web/components/views/parseSections';

describe('parseField', () => {
  it('解析全角冒号的"标签：值"', () => {
    expect(parseField('姓名：张三')).toEqual({ key: '姓名', value: '张三' });
  });

  it('解析半角冒号的"标签:值"', () => {
    expect(parseField('age: 25')).toEqual({ key: 'age', value: '25' });
  });

  it('值包含冒号时只按第一个冒号拆分', () => {
    expect(parseField('目标：找到：真相')).toEqual({ key: '目标', value: '找到：真相' });
  });

  it('值为空时返回空值字段', () => {
    expect(parseField('姓名：')).toEqual({ key: '姓名', value: '' });
  });

  it('没有冒号时返回 null', () => {
    expect(parseField('一段没有冒号的文本')).toBeNull();
  });

  it('标签过长（>8 字）视为普通文本', () => {
    expect(parseField('这是一个非常非常长的标签：值')).toBeNull();
  });

  it('空内容返回 null', () => {
    expect(parseField('')).toBeNull();
  });
});

describe('parseSections', () => {
  it('解析文档标题（首个 #）', () => {
    const doc = parseSections('# 角色档案\n');
    expect(doc.title).toBe('角色档案');
    expect(doc.sections).toHaveLength(0);
  });

  it('角色档案：每个 ## 是一张角色卡片，字段进入 fields', () => {
    const md = `# 角色档案

## 主角
- 姓名：林川
- 年龄：28
- 性格：沉稳

## 反派
- 姓名：墨离
- 动机：复仇
`;
    const doc = parseSections(md);
    expect(doc.title).toBe('角色档案');
    expect(doc.sections).toHaveLength(2);

    const hero = doc.sections[0];
    expect(hero.title).toBe('主角');
    expect(hero.fields).toEqual([
      { key: '姓名', value: '林川' },
      { key: '年龄', value: '28' },
      { key: '性格', value: '沉稳' },
    ]);
    expect(hero.subsections).toHaveLength(0);

    const villain = doc.sections[1];
    expect(villain.title).toBe('反派');
    expect(villain.fields[0]).toEqual({ key: '姓名', value: '墨离' });
    expect(villain.fields[1]).toEqual({ key: '动机', value: '复仇' });
  });

  it('空字段值被保留（用于展示占位）', () => {
    const md = `## 主角
- 姓名：
- 年龄：
`;
    const doc = parseSections(md);
    expect(doc.sections[0].fields).toEqual([
      { key: '姓名', value: '' },
      { key: '年龄', value: '' },
    ]);
  });

  it('概念文件：自由段落进入 body，有序列表进入 ordered', () => {
    const md = `# 故事概念

## 一句话梗概
一个关于勇气的故事。

## 五句话简介
1. 背景设定
2. 主角介绍
3. 核心冲突

## 核心冲突
人与命运的对抗。
`;
    const doc = parseSections(md);
    expect(doc.sections).toHaveLength(3);

    const logline = doc.sections[0];
    expect(logline.title).toBe('一句话梗概');
    expect(logline.body).toEqual(['一个关于勇气的故事。']);
    expect(logline.fields).toHaveLength(0);

    const synopsis = doc.sections[1];
    expect(synopsis.ordered).toEqual(['背景设定', '主角介绍', '核心冲突']);

    const conflict = doc.sections[2];
    expect(conflict.body).toEqual(['人与命运的对抗。']);
  });

  it('场景文件：### 子场景归入对应分组的 subsections', () => {
    const md = `# 场景设计

## 第1章场景

### 场景1：主动场景
- 目标：夺回信物
- 冲突：守卫阻拦

### 场景2：被动场景
- 反应：震惊
- 决定：隐忍
`;
    const doc = parseSections(md);
    expect(doc.sections).toHaveLength(1);
    const ch1 = doc.sections[0];
    expect(ch1.title).toBe('第1章场景');
    expect(ch1.subsections).toHaveLength(2);

    const active = ch1.subsections[0];
    expect(active.title).toBe('场景1：主动场景');
    expect(active.fields).toEqual([
      { key: '目标', value: '夺回信物' },
      { key: '冲突', value: '守卫阻拦' },
    ]);

    const passive = ch1.subsections[1];
    expect(passive.title).toBe('场景2：被动场景');
    expect(passive.fields[1]).toEqual({ key: '决定', value: '隐忍' });
  });

  it('子分组字段不会泄漏到父分组', () => {
    const md = `## 第1章场景
- 标题：开端

### 场景1：主动场景
- 目标：出发
`;
    const doc = parseSections(md);
    const ch = doc.sections[0];
    // "标题" 在 ### 之前，归入父分组
    expect(ch.fields).toEqual([{ key: '标题', value: '开端' }]);
    // "目标" 在 ### 之后，归入子分组
    expect(ch.subsections[0].fields).toEqual([{ key: '目标', value: '出发' }]);
  });

  it('连续多行段落合并为一段，空行分隔多段', () => {
    const md = `## 地理环境
第一行
第二行

第二段文字
`;
    const doc = parseSections(md);
    expect(doc.sections[0].body).toEqual(['第一行 第二行', '第二段文字']);
  });

  it('无冒号或冒号前过长的列表项归入 items', () => {
    const md = `## 备注
- 普通要点一
- 这是一个非常非常长的说明：带冒号也算普通项
`;
    const doc = parseSections(md);
    expect(doc.sections[0].items).toHaveLength(2);
    expect(doc.sections[0].fields).toHaveLength(0);
  });

  it('半角 ) 与中文 、 也能识别为有序列表', () => {
    const md = `## 列表
1) 第一
2、第二
`;
    const doc = parseSections(md);
    expect(doc.sections[0].ordered).toEqual(['第一', '第二']);
  });

  it('多个 h1 仅取首个作为文档标题', () => {
    const doc = parseSections('# 标题一\n# 标题二\n');
    expect(doc.title).toBe('标题一');
  });

  it('### 出现在 ## 之前时隐式建一个分组', () => {
    const md = `### 孤儿子场景
- 字段：值
`;
    const doc = parseSections(md);
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].subsections).toHaveLength(1);
    expect(doc.sections[0].subsections[0].fields[0]).toEqual({ key: '字段', value: '值' });
  });

  it('CRLF 行结尾被规范化处理', () => {
    const md = '# 标题\r\n## 分组\r\n- 字段：值\r\n';
    const doc = parseSections(md);
    expect(doc.title).toBe('标题');
    expect(doc.sections[0].fields).toEqual([{ key: '字段', value: '值' }]);
  });

  it('空字符串与纯空白输入返回空结构', () => {
    expect(parseSections('')).toEqual({ title: '', sections: [] });
    expect(parseSections('\n\n  \n')).toEqual({ title: '', sections: [] });
  });

  it('ATX 闭合 # 被从标题中去除', () => {
    const doc = parseSections('## 分组 ###\n');
    expect(doc.sections[0].title).toBe('分组');
  });
});
