/**
 * 实体词典构建纯函数测试。
 * 归并建议：未来若有其他档案解析相关单测可合并到本文件。
 */
import { describe, it, expect } from 'vitest';
import { buildEntityDict } from '../../../src/shared/entity-dict';

describe('buildEntityDict', () => {
  it('从 profiles.md 解析角色姓名字段', () => {
    const profiles = `# 角色档案

## 一、林冲（主角）
- 姓名：林冲
- 外号：豹子头
- 年龄：三十五岁

## 反派
- 姓名：高俅
- 动机：报复`;
    const dict = buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
    expect(dict.get('林冲')?.type).toBe('character');
    expect(dict.get('林冲')?.file).toBe('characters/profiles.md');
    expect(dict.get('高俅')?.type).toBe('character');
  });

  it('从 profiles.md 解析外号字段', () => {
    const profiles = `# 角色档案

## 林冲
- 姓名：林冲
- 外号：豹子头`;
    const dict = buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
    expect(dict.get('豹子头')?.type).toBe('alias');
  });

  it('从角色分组标题括号解析外号', () => {
    const profiles = `# 角色档案

## 林冲（豹子头）
- 姓名：林冲`;
    const dict = buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
    expect(dict.get('豹子头')?.type).toBe('alias');
  });

  it('过滤空值姓名字段', () => {
    const profiles = `# 角色档案

## 主角
- 姓名：
- 年龄：`;
    const dict = buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
    expect(dict.size).toBe(0);
  });

  it('过滤模板占位符', () => {
    const profiles = `# 角色档案

## 主角
- 姓名：{姓名}
- 外号：{江湖人称}`;
    const dict = buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
    expect(dict.size).toBe(0);
  });

  it('过滤单字实体名（<2 字符）', () => {
    const profiles = `# 角色档案

## 主角
- 姓名：剑`;
    const dict = buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
    expect(dict.size).toBe(0);
  });

  it('过滤停用词（江湖/天下/武林）', () => {
    const weapon = `# 兵器谱

## 江湖
普通兵器。

## 倚天剑
削铁如泥。`;
    const dict = buildEntityDict([{ path: 'wuxia/weapon.md', content: weapon }]);
    expect(dict.has('江湖')).toBe(false);
    expect(dict.get('倚天剑')?.type).toBe('weapon');
  });

  it('从 wuxia/weapon.md 解析武器（## 标题为实体名）', () => {
    const weapon = `# 兵器谱

## 倚天剑
削铁如泥。

## 屠龙刀
无坚不摧。`;
    const dict = buildEntityDict([{ path: 'wuxia/weapon.md', content: weapon }]);
    expect(dict.get('倚天剑')?.type).toBe('weapon');
    expect(dict.get('屠龙刀')?.type).toBe('weapon');
  });

  it('从 wuxia/martial.md 解析武功与招式', () => {
    const martial = `# 武功谱

## 降龙十八掌
至刚至阳。

### 招式
- 亢龙有悔
- 飞龙在天`;
    const dict = buildEntityDict([{ path: 'wuxia/martial.md', content: martial }]);
    expect(dict.get('降龙十八掌')?.type).toBe('martial');
    expect(dict.get('亢龙有悔')?.type).toBe('move');
    expect(dict.get('飞龙在天')?.type).toBe('move');
  });

  it('从 wuxia/sects.md 解析门派', () => {
    const sects = `# 门派

## 少林寺
天下武功出少林。

## 武当派
以柔克刚。`;
    const dict = buildEntityDict([{ path: 'wuxia/sects.md', content: sects }]);
    expect(dict.get('少林寺')?.type).toBe('sect');
    expect(dict.get('武当派')?.type).toBe('sect');
  });

  it('从 world-building.md 地理节解析地名（### 子标题）', () => {
    const world = `# 世界观

## 地理环境

### 长安城
繁华古都。

### 泰山
五岳之首。

## 力量体系
普通设定。`;
    const dict = buildEntityDict([{ path: 'world-building.md', content: world }]);
    expect(dict.get('长安城')?.type).toBe('place');
    expect(dict.get('泰山')?.type).toBe('place');
  });

  it('非武侠项目降级：无 wuxia 文件只识别角色', () => {
    const profiles = `# 角色档案

## 主角
- 姓名：林冲`;
    const world = `# 世界观

## 地理环境
普通文本。`;
    const dict = buildEntityDict([
      { path: 'characters/profiles.md', content: profiles },
      { path: 'world-building.md', content: world },
    ]);
    expect(dict.get('林冲')?.type).toBe('character');
    expect(dict.has('地理环境')).toBe(false); // 不是 ### 子标题，不入词典
  });

  it('同名冲突保留先出现的（角色优先于其他）', () => {
    const profiles = `# 角色档案

## 林冲
- 姓名：林冲`;
    const weapon = `# 兵器

## 林冲
一把以人名命名的剑。`;
    const dict = buildEntityDict([
      { path: 'characters/profiles.md', content: profiles },
      { path: 'wuxia/weapon.md', content: weapon },
    ]);
    expect(dict.get('林冲')?.type).toBe('character'); // 角色优先
  });

  it('支持加粗字段名 **姓名**：剑平', () => {
    const profiles = `# 主角：剑平

## 基本信息

- **姓名**：剑平，字试锋
- **年龄**：18岁`;
    const dict = buildEntityDict([{ path: 'characters/profiles/剑平.md', content: profiles }]);
    expect(dict.get('剑平')?.type).toBe('character');
  });

  it('从文档标题 # 主角：剑平 提取名字', () => {
    const profiles = `# 主角：剑平

## 基本信息

剑平是主角。`;
    const dict = buildEntityDict([{ path: 'characters/profiles/剑平.md', content: profiles }]);
    expect(dict.get('剑平')?.type).toBe('character');
  });

  it('EntityRef.sectionRaw 含 ## 标题行', () => {
    const profiles = `# 角色档案

## 林冲
- 姓名：林冲
- 年龄：三十五`;
    const dict = buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
    const ref = dict.get('林冲')!;
    expect(ref.sectionRaw).toContain('## 林冲');
    expect(ref.sectionRaw).toContain('- 姓名：林冲');
  });

  it('空档案返回空词典', () => {
    const dict = buildEntityDict([{ path: 'characters/profiles.md', content: '' }]);
    expect(dict.size).toBe(0);
  });

  it('无 sources 返回空词典', () => {
    const dict = buildEntityDict([]);
    expect(dict.size).toBe(0);
  });

  it('分类标题（基本信息/时间线/性格特征）不进词典', () => {
    const profiles = `# 主角：剑平

## 基本信息

- **姓名**：剑平，字试锋

## 时间线

剑平出山。

## 性格特征

沉默寡言。`;
    const dict = buildEntityDict([{ path: 'characters/profiles/剑平.md', content: profiles }]);
    expect(dict.has('基本信息')).toBe(false);
    expect(dict.has('时间线')).toBe(false);
    expect(dict.has('性格特征')).toBe(false);
    expect(dict.has('剑平')).toBe(true);
  });

  it('嵌套列表字段（祖父/父亲）不被误识为别名', () => {
    const profiles = `# 主角：剑平

## 基本信息

- **姓名**：剑平
- **家族**：
  - 祖父：剑臣
  - 父亲：剑城`;
    const dict = buildEntityDict([{ path: 'characters/profiles/剑平.md', content: profiles }]);
    expect(dict.has('祖父')).toBe(false);
    expect(dict.has('父亲')).toBe(false);
  });

  it('文档标题括号里的定位说明（父亲/重要角色）不入 alias', () => {
    const profiles = `# 重要背景角色：剑城（父亲）

## 基本信息

- **姓名**：剑城，字万楼`;
    const dict = buildEntityDict([{ path: 'characters/profiles/剑城.md', content: profiles }]);
    expect(dict.has('父亲')).toBe(false);
    expect(dict.get('剑城')?.type).toBe('character');
  });

  it('world 描述性子标题（含冒号/破折号）不进词典', () => {
    const world = `# 世界观

## 地理环境

### 《愚公移山》的定位
寓言。

### 故事舞台：真实的明初天下
明朝。

### 主要地点及其故事功能
详述。

### 长安城
繁华古都。`;
    const dict = buildEntityDict([{ path: 'world-building.md', content: world }]);
    expect(dict.has('《愚公移山》的定位')).toBe(false);
    expect(dict.has('故事舞台：真实的明初天下')).toBe(false);
    expect(dict.has('主要地点及其故事功能')).toBe(false);
    expect(dict.get('长安城')?.type).toBe('place');
  });
});
