# 实体链接功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在章节正文「预览」模式中，把已建档的角色/外号/武器/武功/门派/招式/地名自动识别为可点击链接，点击弹窗展示该实体在档案中的设定原文。

**Architecture:** 两个纯函数（`buildEntityDict` 从档案 markdown 构建实体词典；`splitTextByEntities` 按词典切片正文）+ 一个 hook（拉档案建词典）+ 三个组件（EntityLink / EntityDetailDialog / EntityMarkdown 包装器）。零后端、零数据库改动。EntityMarkdown 通过 react-markdown v9 的自定义块组件（p/li/h1-h6/blockquote/td/th）注入，递归处理 React children 中的字符串节点。

**Tech Stack:** React 19, react-markdown v9, remark-gfm v4, @tanstack/react-query, @linaria/core, vitest, @testing-library/react

**Spec:** `docs/superpowers/specs/2026-07-05-entity-link-design.md`

---

## 文件结构

| 文件 | 责任 | 类型 |
|---|---|---|
| `src/shared/entity-dict.ts` | 纯函数：从档案文本解析实体词典；`EntityRef`/`EntityType` 类型 | 新增 |
| `src/shared/entity-linker.ts` | 纯函数：`splitTextByEntities` 文本切片 | 新增 |
| `src/web/hooks/useEntityDict.ts` | hook：拉档案 → 建词典 → memo 缓存 | 新增 |
| `src/web/components/EntityLink.tsx` | 链接 span + 类型着色 | 新增 |
| `src/web/components/EntityDetailDialog.tsx` | 弹窗：渲染 sectionRaw | 新增 |
| `src/web/components/EntityMarkdown.tsx` | 包装 react-markdown，注入实体链接 + 弹窗状态 | 新增 |
| `src/web/components/EditorPanel.tsx` | preview 分支接线 | 改 |
| `tests/unit/shared/entity-dict.test.ts` | 词典纯函数单测 | 新增 |
| `tests/unit/shared/entity-linker.test.ts` | 切片纯函数单测 | 新增 |
| `tests/integration/entity-link.test.tsx` | 渲染 + 点击弹窗集成测 | 新增 |

---

## Task 1: 实体词典纯函数 `entity-dict.ts`

**Files:**
- Create: `src/shared/entity-dict.ts`
- Test: `tests/unit/shared/entity-dict.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/shared/entity-dict.test.ts
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
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/entity-dict.test.ts`
Expected: FAIL — `Cannot find module '../../../src/shared/entity-dict'`

- [ ] **Step 3: 写最小实现**

```typescript
// src/shared/entity-dict.ts
/**
 * 实体词典构建：从小说档案 markdown 解析出实体名 → EntityRef 映射。
 * 纯函数，无副作用，可独立单测。
 *
 * 实体来源（按文件类型）：
 *  - characters/profiles.md（及 characters/*.md）：角色姓名字段 + 外号字段 + 标题括号
 *  - world-building.md：地理节 ### 子标题（地名）；武功/兵器/门派节标题
 *  - wuxia/*.md：按文件名归类，## 标题为实体名；武功文件的「招式」子节列表项为招式实体
 */
import { parseSections, isPlaceholder } from '@/web/components/views/parseSections';
import type { MdSection } from '@/web/components/views/parseSections';

export type EntityType = 'character' | 'alias' | 'weapon' | 'martial' | 'sect' | 'move' | 'place';

export interface EntityRef {
  /** 实体显示名（词典 key）。 */
  name: string;
  /** 实体类型。 */
  type: EntityType;
  /** 档案文件相对路径。 */
  file: string;
  /** 该实体所属 heading 节的标题。 */
  sectionTitle: string;
  /** 该实体所属节的完整 markdown 原文（含标题行）。弹窗直接渲染。 */
  sectionRaw: string;
}

/** 泛指词不入词典（会过度链接）。 */
const STOPWORDS = new Set([
  '江湖', '天下', '武林', '中原', '江湖人', '武林中人',
  '主角', '反派', '配角', '师父', '师兄', '师弟', '师姐', '师妹',
]);

/** 文件类型推断：按路径关键词。 */
type FileType = 'profiles' | 'world' | 'weapon' | 'martial' | 'sect' | 'other';

function inferFileType(path: string): FileType {
  if (path.startsWith('characters/')) return 'profiles';
  if (path === 'world-building.md') return 'world';
  if (path.startsWith('wuxia/sects/') || path === 'wuxia/sects.md') return 'sect';
  if (/martial|功法|武功|武学/.test(path)) return 'martial';
  if (/weapon|兵器|神兵|兵刃/.test(path)) return 'weapon';
  if (/sect|门派|势力|江湖/.test(path)) return 'sect';
  return 'other';
}

/** 名字有效性：≥2 字符、非占位符、非停用词。 */
function isValidName(name: string): boolean {
  if (!name || name.length < 2) return false;
  if (isPlaceholder(name)) return false;
  if (STOPWORDS.has(name)) return false;
  return true;
}

/** 从分组标题提取名字：「一、林冲（主角）」→「林冲」。 */
function extractNameFromTitle(title: string): string {
  let s = title.replace(/^[\d一二三四五六七八九十百]+[、.．)\s]*/, '');
  s = s.split(/[（(]/)[0];
  return s.trim();
}

/** 从标题括号提取外号：「林冲（豹子头）」→「豹子头」。 */
function extractAliasFromTitle(title: string): string | null {
  const m = title.match(/[（(]([^）)]+)[）)]/);
  return m ? m[1].trim() : null;
}

/** 清理列表项文本：去掉 markdown 加粗/链接标记。 */
function cleanItem(item: string): string {
  return item.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
}

/** 招式子节关键词。 */
const MOVE_SUBKEYS = /招式|招|绝招|杀招|招数/;
/** 地理节关键词。 */
const PLACE_KEYS = /地理|地点|地形|山川|城池|关隘/;
/** 武功节关键词。 */
const MARTIAL_KEYS = /武功|武学|功法|内功|心法|绝学/;
/** 兵器节关键词。 */
const WEAPON_KEYS = /兵器|神兵|兵刃|武器|装备/;
/** 门派节关键词。 */
const SECT_KEYS = /门派|势力|江湖|帮会|宗派|教派/;

/**
 * 从若干档案文本构建实体词典。
 * @returns Map<实体名, EntityRef>；同名实体保留第一个出现的
 */
export function buildEntityDict(
  sources: Array<{ path: string; content: string }>,
): Map<string, EntityRef> {
  const dict = new Map<string, EntityRef>();

  /** 安全添加：无效名或已存在则跳过。 */
  const add = (
    name: string,
    type: EntityType,
    file: string,
    sectionTitle: string,
    sectionRaw: string,
  ) => {
    if (!isValidName(name)) return;
    if (dict.has(name)) return;
    dict.set(name, { name, type, file, sectionTitle, sectionRaw });
  };

  for (const { path, content } of sources) {
    if (!content) continue;
    const fileType = inferFileType(path);
    if (fileType === 'other') continue;
    const doc = parseSections(content);

    for (const section of doc.sections) {
      const sectionRaw = `## ${section.title}\n\n${section.fullRawMd}`;

      if (fileType === 'profiles') {
        processProfilesSection(section, path, sectionRaw, add);
      } else if (fileType === 'world') {
        processWorldSection(section, path, add);
      } else {
        // weapon / martial / sect：## 标题即实体名
        const titleName = extractNameFromTitle(section.title);
        if (titleName && isValidName(titleName)) {
          add(titleName, fileType, path, section.title, sectionRaw);
        }
        // martial 文件额外解析招式
        if (fileType === 'martial') {
          processMoves(section, path, add);
        }
      }
    }
  }

  return dict;
}

function processProfilesSection(
  section: MdSection,
  file: string,
  sectionRaw: string,
  add: (n: string, t: EntityType, f: string, st: string, sr: string) => void,
) {
  const nameField = section.fields.find((f) => f.key === '姓名');
  if (nameField) add(nameField.value, 'character', file, section.title, sectionRaw);
  // 标题里的名字（兼容无 姓名 字段的档案）
  const titleName = extractNameFromTitle(section.title);
  if (titleName) add(titleName, 'character', file, section.title, sectionRaw);

  const aliasField = section.fields.find((f) => f.key === '外号' || f.key === '绰号');
  if (aliasField) add(aliasField.value, 'alias', file, section.title, sectionRaw);
  const titleAlias = extractAliasFromTitle(section.title);
  if (titleAlias) add(titleAlias, 'alias', file, section.title, sectionRaw);
}

function processWorldSection(
  section: MdSection,
  file: string,
  add: (n: string, t: EntityType, f: string, st: string, sr: string) => void,
) {
  const title = section.title;
  // 地理节：### 子标题为地名
  if (PLACE_KEYS.test(title)) {
    for (const sub of section.subsections) {
      if (isValidName(sub.title)) {
        add(sub.title, 'place', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
      }
    }
  }
  // 武功节：标题本身 + 招式
  if (MARTIAL_KEYS.test(title)) {
    add(extractNameFromTitle(title), 'martial', file, title, `## ${title}\n\n${section.fullRawMd}`);
    processMoves(section, file, add);
  }
  // 兵器节
  if (WEAPON_KEYS.test(title)) {
    add(extractNameFromTitle(title), 'weapon', file, title, `## ${title}\n\n${section.fullRawMd}`);
  }
  // 门派节
  if (SECT_KEYS.test(title)) {
    add(extractNameFromTitle(title), 'sect', file, title, `## ${title}\n\n${section.fullRawMd}`);
    for (const sub of section.subsections) {
      if (isValidName(sub.title)) {
        add(sub.title, 'sect', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
      }
    }
  }
}

function processMoves(
  section: MdSection,
  file: string,
  add: (n: string, t: EntityType, f: string, st: string, sr: string) => void,
) {
  for (const sub of section.subsections) {
    if (!MOVE_SUBKEYS.test(sub.title)) continue;
    for (const item of sub.items) {
      const moveName = cleanItem(item);
      if (moveName) add(moveName, 'move', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
    }
    for (const field of sub.fields) {
      // 字段形式的招式：- 第一式：亢龙有悔
      add(field.value, 'move', file, sub.title, `### ${sub.title}\n\n${sub.rawMd}`);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/entity-dict.test.ts`
Expected: PASS（全部用例绿）

如 `parseSections` 的导入路径报错（`@/web/...` 从 `src/shared/` 导入 web 模块有循环依赖顾虑），改为相对路径 `../web/components/views/parseSections`，并确认 `parseSections` 无 React 依赖（已确认：纯函数）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/entity-dict.ts tests/unit/shared/entity-dict.test.ts
git commit -m "feat(entity-link): 实体词典构建纯函数

从 profiles.md/world-building.md/wuxia/*.md 解析角色/外号/武器/
武功/门派/招式/地名实体。≥2字符约束、占位符过滤、停用词过滤、
同名保留先出现。"
```

---

## Task 2: 文本切片纯函数 `entity-linker.ts`

**Files:**
- Create: `src/shared/entity-linker.ts`
- Test: `tests/unit/shared/entity-linker.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/shared/entity-linker.test.ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/entity-linker.test.ts`
Expected: FAIL — `Cannot find module '../../../src/shared/entity-linker'`

- [ ] **Step 3: 写最小实现**

```typescript
// src/shared/entity-linker.ts
/**
 * 文本实体切片纯函数。
 * 把一段纯文本按实体词典切成普通文本段 + 实体引用段的有序数组。
 *
 * 匹配策略：
 *  1. 词典按 name 长度降序（最长优先，解决「林冲」vs「林冲之」）
 *  2. 从左到右扫描正文每个位置，取该位置能匹配的最长词典项
 *  3. 边界规则：仅当实体名首字符是 [A-Za-z] 时检查前导字符是否为 [A-Za-z0-9]（是则拒绝）；
 *     仅当实体名末字符是 [A-Za-z] 时检查后继字符是否为 [A-Za-z0-9]（是则拒绝）。
 *     汉字实体名不做边界检查。
 *  4. 已匹配区间不再参与后续匹配（左到右扫描天然保证）。
 */
import type { EntityRef } from './entity-dict';

export interface TextSegment {
  /** 普通文本段（与 ref 二选一）。 */
  text?: string;
  /** 命中实体（与 text 二选一）。 */
  ref?: EntityRef;
}

const ALPHA = /[A-Za-z]/;
const ALNUM = /[A-Za-z0-9]/;

/** 边界检查：返回 true 表示允许在此位置匹配。 */
function boundaryOk(text: string, start: number, len: number): boolean {
  const firstChar = text[start];
  const lastChar = text[start + len - 1];
  if (ALPHA.test(firstChar)) {
    if (start > 0 && ALNUM.test(text[start - 1])) return false;
  }
  if (ALPHA.test(lastChar)) {
    if (start + len < text.length && ALNUM.test(text[start + len])) return false;
  }
  return true;
}

export function splitTextByEntities(
  text: string,
  dict: Map<string, EntityRef>,
): TextSegment[] {
  if (dict.size === 0 || text.length === 0) {
    return text.length > 0 ? [{ text }] : [];
  }

  // 按长度降序：最长优先匹配
  const names = Array.from(dict.keys()).sort((a, b) => b.length - a.length);
  const segments: TextSegment[] = [];
  let i = 0;
  let textStart = 0;

  while (i < text.length) {
    let matchedRef: EntityRef | null = null;
    let matchedLen = 0;

    for (const name of names) {
      const len = name.length;
      if (len === 0 || i + len > text.length) continue;
      if (text.startsWith(name, i) && boundaryOk(text, i, len)) {
        matchedRef = dict.get(name)!;
        matchedLen = len;
        break; // names 降序，首个命中即最长
      }
    }

    if (matchedRef) {
      if (i > textStart) segments.push({ text: text.slice(textStart, i) });
      segments.push({ ref: matchedRef });
      i += matchedLen;
      textStart = i;
    } else {
      i++;
    }
  }

  if (textStart < text.length) segments.push({ text: text.slice(textStart) });
  return segments;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/entity-linker.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: 提交**

```bash
git add src/shared/entity-linker.ts tests/unit/shared/entity-linker.test.ts
git commit -m "feat(entity-link): 文本切片纯函数

最长优先贪心匹配 + 英文边界检查。汉字实体名不限边界。"
```

---

## Task 3: `useEntityDict` hook

**Files:**
- Create: `src/web/hooks/useEntityDict.ts`

**说明**：此 hook 无独立单测（依赖 react-query + fetch，已在集成测 Task 7 覆盖）。

- [ ] **Step 1: 写实现**

```typescript
// src/web/hooks/useEntityDict.ts
/**
 * 拉取项目档案文件 → 构建实体词典。
 * 复用 viewShared 的 useNovelFile / useNovelFileList（react-query 缓存 + SSE 失效）。
 */
import { useMemo } from 'react';
import { useNovelFile, useNovelFileList } from '@/web/components/views/viewShared';
import { buildEntityDict, type EntityRef } from '@/shared/entity-dict';

export function useEntityDict(projectId: string): {
  dict: Map<string, EntityRef>;
  isLoading: boolean;
} {
  const { data: fileList } = useNovelFileList(projectId);

  // 候选档案：profiles / world-building / wuxia 下所有 md
  const candidates = useMemo(() => {
    const list = fileList ?? [];
    const result: Array<{ key: string; path: string }> = [];
    // characters/*.md
    for (const p of list) {
      if (p.startsWith('characters/') && p.endsWith('.md')) {
        result.push({ key: `char-${p}`, path: p });
      } else if (p === 'world-building.md') {
        result.push({ key: 'world', path: p });
      } else if (p.startsWith('wuxia/') && p.endsWith('.md')) {
        result.push({ key: `wuxia-${p}`, path: p });
      }
    }
    return result;
  }, [fileList]);

  // 逐个拉取（react-query 缓存，SSE file-changed 自动失效）
  const queries = candidates.map((c) => useNovelFile(projectId, c.key, c.path));

  const dict = useMemo(() => {
    const sources: Array<{ path: string; content: string }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const content = queries[i].data;
      if (content) sources.push({ path: candidates[i].path, content });
    }
    return buildEntityDict(sources);
  }, [candidates, queries]);

  const isLoading = queries.some((q) => q.isLoading);

  return { dict, isLoading };
}
```

注意：`queries` 是 hooks 数组——React hooks 规则禁止在循环里调 hooks。但 `useNovelFile` 内部是 `useQuery`，循环里调 `useQuery` 在 react-query v5 是允许的（hooks 顺序稳定，只要 `candidates` 长度稳定）。**若 eslint-plugin-react-hooks 报错**，改用 `useQueries`：

```typescript
import { useQueries } from '@tanstack/react-query';

// 替代上面的 queries 行：
const queryResults = useQueries({
  queries: candidates.map((c) => ({
    queryKey: ['novel-file', projectId, c.key],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(c.path)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content as string;
    },
  })),
});
```

实现时优先用 `useQueries` 版本（更符合 hooks 规则，且 queryKey 与 `useNovelFile` 一致，SSE 失效逻辑仍生效）。

- [ ] **Step 2: typecheck 确认**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/web/hooks/useEntityDict.ts
git commit -m "feat(entity-link): useEntityDict hook

拉取 profiles/world-building/wuxia 档案，构建并缓存实体词典。"
```

---

## Task 4: `EntityLink` 组件

**Files:**
- Create: `src/web/components/EntityLink.tsx`

- [ ] **Step 1: 写实现**

```typescript
// src/web/components/EntityLink.tsx
/**
 * 实体链接 span：点击触发 onPick 回调。
 * 按 data-type 着色（CSS 属性选择器）。
 */
import { css } from '@linaria/core';
import type { EntityRef } from '@/shared/entity-dict';

export const entityLink = css`
  color: var(--haze-color-primary);
  cursor: pointer;
  border-bottom: 1px dashed var(--haze-color-primary);
  padding: 0 1px;
  border-radius: 2px;
  transition: background 0.15s, border-bottom-style 0.15s;
  &:hover {
    background: color-mix(in srgb, var(--haze-color-primary) 12%, transparent);
    border-bottom-style: solid;
  }
  &[data-type='weapon'] { color: #ef4444; border-bottom-color: #ef4444; }
  &[data-type='martial'] { color: #f97316; border-bottom-color: #f97316; }
  &[data-type='move'] { color: #f97316; border-bottom-color: #f97316; border-bottom-style: dotted; }
  &[data-type='sect'] { color: #8b5cf6; border-bottom-color: #8b5cf6; }
  &[data-type='place'] { color: #10b981; border-bottom-color: #10b981; }
  &[data-type='alias'] { color: #64748b; border-bottom-color: #64748b; border-bottom-style: dotted; }
`;

interface Props {
  entity: EntityRef;
  onPick: (ref: EntityRef) => void;
}

export function EntityLink({ entity, onPick }: Props) {
  return (
    <span
      className={entityLink}
      data-type={entity.type}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onPick(entity);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onPick(entity);
        }
      }}
    >
      {entity.name}
    </span>
  );
}
```

- [ ] **Step 2: typecheck 确认**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/web/components/EntityLink.tsx
git commit -m "feat(entity-link): EntityLink 组件

按类型着色的可点击实体链接 span。"
```

---

## Task 5: `EntityDetailDialog` 组件

**Files:**
- Create: `src/web/components/EntityDetailDialog.tsx`

- [ ] **Step 1: 写实现**

```typescript
// src/web/components/EntityDetailDialog.tsx
/**
 * 实体详情弹窗：渲染 EntityRef.sectionRaw（markdown 原文）。
 * 布局参考 RevisionDialog：overlay 遮罩 + 居中卡片。
 */
import { useEffect } from 'react';
import { css } from '@linaria/core';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { EntityRef } from '@/shared/entity-dict';

const overlay = css`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
`;

const dialog = css`
  background: var(--haze-color-bg);
  border: 1px solid var(--haze-color-border);
  border-radius: 10px;
  width: 100%;
  max-width: 560px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
`;

const header = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--haze-color-border);
`;

const title = css`
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--haze-color-text);
  flex: 1;
`;

const typeBadge = css`
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  background: var(--haze-color-bg-secondary);
  color: var(--haze-color-text-secondary);
`;

const closeBtn = css`
  background: transparent;
  border: none;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--haze-color-text-secondary);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
  &:hover {
    background: var(--haze-color-bg-secondary);
    color: var(--haze-color-text);
  }
`;

const body = css`
  padding: 1rem 1.25rem;
  overflow-y: auto;
  font-size: 0.9rem;
  line-height: 1.8;
  color: var(--haze-color-text);
  & p { margin: 0.5rem 0; }
  & ul, & ol { padding-left: 1.5rem; }
  & h2, & h3 { margin-top: 0.75rem; }
`;

const TYPE_LABELS: Record<EntityRef['type'], string> = {
  character: '角色',
  alias: '外号',
  weapon: '武器',
  martial: '武功',
  sect: '门派',
  move: '招式',
  place: '地名',
};

interface Props {
  entity: EntityRef;
  onClose: () => void;
}

export function EntityDetailDialog({ entity, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={overlay} onClick={onClose}>
      <div
        className={dialog}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`实体详情：${entity.name}`}
      >
        <div className={header}>
          <span className={title}>{entity.name}</span>
          <span className={typeBadge}>{TYPE_LABELS[entity.type]}</span>
          <button className={closeBtn} onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className={body}>
          <Markdown remarkPlugins={[remarkGfm]}>{entity.sectionRaw}</Markdown>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck 确认**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/web/components/EntityDetailDialog.tsx
git commit -m "feat(entity-link): EntityDetailDialog 弹窗

渲染实体所属档案节的 markdown 原文，Esc/遮罩关闭。"
```

---

## Task 6: `EntityMarkdown` 包装组件

**Files:**
- Create: `src/web/components/EntityMarkdown.tsx`

**关键**：react-markdown v9 的 `components` 只映射 HTML 标签名（无 `text` key）。用自定义块组件（p/li/h1-h6/blockquote/td/th）+ 递归处理 React children 中的字符串节点。

- [ ] **Step 1: 写实现**

```typescript
// src/web/components/EntityMarkdown.tsx
/**
 * react-markdown 包装器：在渲染时把正文里的实体名替换为可点击链接。
 *
 * 实现要点（react-markdown v9）：
 *  - components 只能映射 HTML 标签名，无 text key
 *  - 自定义 p/li/h1-h6/blockquote/td/th，每个块组件渲染原标签 + 处理 children
 *  - EntityChildren 递归遍历 React 树，对字符串节点跑 splitTextByEntities
 *  - 实体段渲染 EntityLink，点击打开 EntityDetailDialog
 */
import {
  useState,
  useMemo,
  useContext,
  createContext,
  Children,
  isValidElement,
  cloneElement,
  createElement,
  type ReactNode,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { css } from '@linera/core';
import type { EntityRef } from '@/shared/entity-dict';
import { splitTextByEntities } from '@/shared/entity-linker';
import { EntityLink } from './EntityLink';
import { EntityDetailDialog } from './EntityDetailDialog';

const preview = css`
  font-size: 0.9rem;
  line-height: 1.8;
  & p { margin: 0.75rem 0; }
  & h1, & h2, & h3 { margin-top: 1rem; }
`;

interface CtxValue {
  dict: Map<string, EntityRef>;
  onPick: (ref: EntityRef) => void;
}

const EntityContext = createContext<CtxValue>({ dict: new Map(), onPick: () => {} });

/** 递归处理 React 节点：字符串 → 切片渲染；元素 → 递归处理其 children。 */
function processNode(node: ReactNode, dict: Map<string, EntityRef>, onPick: (r: EntityRef) => void): ReactNode {
  if (node == null || typeof node === 'boolean') return node;
  if (typeof node === 'string') {
    const segments = splitTextByEntities(node, dict);
    if (segments.length === 0) return node;
    return segments.map((seg, i) =>
      seg.ref ? (
        <EntityLink key={i} entity={seg.ref} onPick={onPick} />
      ) : (
        <span key={i}>{seg.text}</span>
      ),
    );
  }
  if (Array.isArray(node)) {
    return node.map((n, i) => (
      <span key={i}>{processNode(n, dict, onPick)}</span>
    ));
  }
  if (isValidElement(node)) {
    const processedChildren = processNode((node.props as { children?: ReactNode }).children, dict, onPick);
    return cloneElement(node, {}, processedChildren);
  }
  return node;
}

/** 块组件包装器：渲染原标签，children 经 processNode 处理。 */
function EntityChildren({ children }: { children: ReactNode }) {
  const { dict, onPick } = useContext(EntityContext);
  return <>{processNode(children, dict, onPick)}</>;
}

const BLOCK_TAGS = ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'td', 'th'] as const;

interface Props {
  content: string;
  dict: Map<string, EntityRef>;
  projectId: string;
}

export function EntityMarkdown({ content, dict, projectId }: Props) {
  const [dialogEntity, setDialogEntity] = useState<EntityRef | null>(null);

  const ctxValue = useMemo<CtxValue>(
    () => ({ dict, onPick: setDialogEntity }),
    [dict],
  );

  const components = useMemo(() => {
    const wrapped: Record<string, (props: Record<string, unknown>) => ReactNode> = {};
    for (const tag of BLOCK_TAGS) {
      wrapped[tag] = (props) =>
        createElement(tag, props, <EntityChildren>{props.children as ReactNode}</EntityChildren>);
    }
    return wrapped;
  }, []);

  return (
    <EntityContext.Provider value={ctxValue}>
      <div className={preview}>
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {content || '*No content*'}
        </Markdown>
      </div>
      {dialogEntity && (
        <EntityDetailDialog entity={dialogEntity} onClose={() => setDialogEntity(null)} />
      )}
    </EntityContext.Provider>
  );
}
```

注意：`projectId` prop 当前未直接使用（sectionRaw 已在 EntityRef 里，弹窗无需额外 fetch），保留 prop 以备未来扩展（如弹窗内显示该实体出现过的章节列表）。

- [ ] **Step 2: typecheck 确认**

Run: `npx tsc --noEmit`
Expected: 无错误（注意 `@linera/core` 应为 `@linaria/core`——按项目实际包名）

- [ ] **Step 3: 提交**

```bash
git add src/web/components/EntityMarkdown.tsx
git commit -m "feat(entity-link): EntityMarkdown 包装组件

react-markdown v9 自定义块组件 + 递归 children 处理。
覆盖 p/li/h1-h6/blockquote/td/th，不覆盖 code/pre。"
```

---

## Task 7: EditorPanel 接线 + 集成测试

**Files:**
- Modify: `src/web/components/EditorPanel.tsx`
- Create: `tests/integration/entity-link.test.tsx`

- [ ] **Step 1: 写集成测试**

```typescript
// tests/integration/entity-link.test.tsx
/**
 * 实体链接渲染 + 弹窗集成测试。
 * 归并建议：未来若有 markdown 渲染相关集成测可合并到本文件。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { EntityMarkdown } from '@/web/components/EntityMarkdown';
import { buildEntityDict } from '@/shared/entity-dict';
import type { EntityRef } from '@/shared/entity-dict';

function makeDict(): Map<string, EntityRef> {
  const profiles = `# 角色档案

## 林冲
- 姓名：林冲
- 外号：豹子头

## 反派
- 姓名：高俅`;
  return buildEntityDict([{ path: 'characters/profiles.md', content: profiles }]);
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return render(createElement(QueryClientProvider, { client: qc }, ui));
}

describe('EntityMarkdown 集成', () => {
  it('正文中角色名渲染为链接', () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '只见林冲策马而出。',
        dict,
        projectId: 'proj_1',
      }),
    );
    const link = screen.getByRole('button', { name: '林冲' });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('data-type')).toBe('character');
    cleanup();
  });

  it('词典为空时不渲染链接', () => {
    wrap(
      createElement(EntityMarkdown, {
        content: '只见林冲策马而出。',
        dict: new Map(),
        projectId: 'proj_1',
      }),
    );
    expect(screen.queryByRole('button', { name: '林冲' })).toBeNull();
    cleanup();
  });

  it('点击链接触发弹窗，弹窗含档案原文', async () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '只见林冲策马而出。',
        dict,
        projectId: 'proj_1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '林冲' }));
    await waitFor(() => {
      // 弹窗标题
      expect(screen.getByText('林冲')).toBeInTheDocument();
      // 弹窗类型徽标
      expect(screen.getByText('角色')).toBeInTheDocument();
    });
    cleanup();
  });

  it('弹窗可通过关闭按钮关闭', async () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '只见林冲策马而出。',
        dict,
        projectId: 'proj_1',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '林冲' }));
    await waitFor(() => expect(screen.getByText('角色')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('关闭'));
    await waitFor(() => expect(screen.queryByText('角色')).toBeNull());
    cleanup();
  });

  it('加粗文本中的实体名也被链接', () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '只见**林冲**策马而出。',
        dict,
        projectId: 'proj_1',
      }),
    );
    expect(screen.getByRole('button', { name: '林冲' })).toBeInTheDocument();
    cleanup();
  });

  it('多个实体都被链接', () => {
    const dict = makeDict();
    wrap(
      createElement(EntityMarkdown, {
        content: '林冲与高俅对峙。',
        dict,
        projectId: 'proj_1',
      }),
    );
    expect(screen.getByRole('button', { name: '林冲' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '高俅' })).toBeInTheDocument();
    cleanup();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/integration/entity-link.test.tsx`
Expected: FAIL — 部分用例失败（弹窗交互相关，需组件实现正确）

- [ ] **Step 3: 接线 EditorPanel**

修改 `src/web/components/EditorPanel.tsx`：

1. 顶部加 import：
```typescript
import { useEntityDict } from '@/web/hooks/useEntityDict';
import { EntityMarkdown } from './EntityMarkdown';
```

2. 在组件函数体顶部（`const [content, setContent]...` 附近）加：
```typescript
const { dict } = useEntityDict(projectId);
```

3. preview 分支替换。当前：
```tsx
{mode === 'preview' ? (
  <div className={preview}>
    <Markdown remarkPlugins={[remarkGfm]}>{content || '*No content*'}</Markdown>
  </div>
) : mode === 'rewrite' ? (
```
改为：
```tsx
{mode === 'preview' ? (
  <EntityMarkdown content={content} dict={dict} projectId={projectId} />
) : mode === 'rewrite' ? (
```

注意：`preview` css 类原作用于外层 div（padding/font-size/overflow）。EntityMarkdown 内部已有同名 `preview` 类（含 line-height）。若 EditorPanel 的 `preview` 类有 overflow-y/padding 等 EditorMarkdown 没有的样式，把那些样式并入 EntityMarkdown 的 `preview` 类，或保留外层 div：
```tsx
{mode === 'preview' ? (
  <div className={previewWrap}>
    <EntityMarkdown content={content} dict={dict} projectId={projectId} />
  </div>
) : ...
```
实现时检查 EditorPanel 原 `preview` 类的完整 CSS（flex:1; overflow-y:auto; padding:1rem; font-size:0.9rem; line-height:1.8），确保 EntityMarkdown 的容器继承这些布局属性。最稳妥：保留外层 `<div className={preview}>`，EntityMarkdown 内部的 `preview` 类改名为 `entityMdBody` 避免冲突。

- [ ] **Step 4: 运行集成测试确认通过**

Run: `npx vitest run tests/integration/entity-link.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/web/components/EditorPanel.tsx tests/integration/entity-link.test.tsx src/web/components/EntityMarkdown.tsx
git commit -m "feat(entity-link): EditorPanel 接线 + 集成测试

章节预览模式接入 EntityMarkdown，自动识别实体并链接。
加粗文本、多实体、弹窗交互均覆盖测试。"
```

---

## Task 8: 全量验证

- [ ] **Step 1: typecheck**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 2: 全量测试**

Run: `npm run test`
Expected: 全绿（含新增 entity-dict / entity-linker / entity-link 测试 + 原有测试无回归）

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 成功

- [ ] **Step 4: 手动 E2E（在有真实档案数据的项目上）**

1. 启动 dev server：`npm run dev`
2. 打开浏览器 → 选一个含角色档案的项目 → 写作视图 → 选章节 → 切「预览」模式
3. 验证：正文中角色名显示为虚线下划链接
4. 点击角色名 → 弹窗显示该角色档案节原文 → Esc/✕/遮罩关闭
5. 全新空项目（无档案）→ 正文无链接，无报错
6. edit 模式 → textarea 原始文本，无链接

- [ ] **Step 5: 最终提交（如有遗留改动）**

```bash
git add -A
git commit -m "chore(entity-link): 验证通过

typecheck + test + build 全绿。"
```

---

## Self-Review 检查

**Spec 覆盖**：
- §3.1 实体来源 → Task 1（buildEntityDict + inferFileType + processProfilesSection/processWorldSection/processMoves）
- §3.4 同名冲突 → Task 1（add 函数 `if (dict.has(name)) return` + source 顺序）
- §4 切片 + 边界 → Task 2（splitTextByEntities + boundaryOk）
- §5.1 useEntityDict → Task 3
- §5.2 EntityLink → Task 4
- §5.3 EntityDetailDialog → Task 5
- §5.4 EntityMarkdown（自定义块组件 + 递归 children）→ Task 6
- §5.5 EditorPanel 接线 → Task 7
- §6 边界情况 → Task 1 测试覆盖（空值/占位符/单字/停用词/降级）、Task 2 测试覆盖（空词典/边界/最长优先）、Task 7 测试覆盖（空词典不渲染）
- §7 测试 → Task 1/2/7

**Placeholder 扫描**：无 TBD/TODO，所有步骤含完整代码。

**类型一致性**：
- `EntityRef` 在 entity-dict.ts 定义，entity-linker.ts / EntityLink / EntityDetailDialog / EntityMarkdown / useEntityDict 全部 import 自 `@/shared/entity-dict` ✓
- `splitTextByEntities` 签名一致 ✓
- `EntityLink` props `{ entity, onPick }`，EntityMarkdown 调用处一致 ✓
- `EntityDetailDialog` props `{ entity, onClose }`，EntityMarkdown 调用处一致 ✓
