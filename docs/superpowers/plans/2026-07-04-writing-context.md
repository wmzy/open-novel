# 写作定向上下文注入与角色体系增强 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让写作阶段 prompt 自动注入本章大纲块与出场角色档案（分级），打通"人物冰山→水面"的管道，消除扁平化的技术根源。

**Architecture:** 在 `prompt-composer.ts` 的写作上下文层里新增两层（大纲块 + 出场角色），新增独立模块 `chapter-context.ts` 承载大纲块提取、出场角色识别、分级注入三块逻辑；`context-manager.ts` 增补角色名解析能力（支持表格索引格式）；声口库作为可选资产接入 L1 注入；清理死代码 `compose.ts` 并对齐 docs。

**Tech Stack:** TypeScript, Hono, Vitest, Node fs

**Spec:** `docs/superpowers/specs/2026-07-04-writing-context-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/agent/chapter-context.ts` | 新模块：大纲块提取 + 出场角色识别（三级回退）+ 分级注入 | Create |
| `src/agent/prompt-composer.ts` | 在 `buildWritingContextLayers` 接入新两层 | Modify |
| `src/agent/context-manager.ts` | 改进 `readCharacterNames` 支持表格索引；导出 `readCharacterNames` | Modify |
| `src/prompts/compose.ts` | 死代码清理 | Delete |
| `docs/工具使用指南.md` | 文档对齐四层→六层 | Modify |
| `tests/unit/agent/chapter-context.test.ts` | 新模块单测 | Create |
| `tests/unit/agent/prompt-composer.test.ts` | 补充写作阶段两层注入的测试 | Modify |
| `tests/unit/agent/context-manager.test.ts` | 补充表格索引角色名解析测试 | Modify |

---

## Task 1: 大纲块提取（`extractChapterOutline`）

**Files:**
- Create: `src/agent/chapter-context.ts`
- Create: `tests/unit/agent/chapter-context.test.ts`

- [ ] **Step 1: 写失败测试——单章提取**

```typescript
// tests/unit/agent/chapter-context.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractChapterOutline } from '../../../src/agent/chapter-context';

describe('extractChapterOutline', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-cc-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function writeOutline(content: string) {
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    await fs.writeFile(path.join(dir, '.novel', 'outline-detailed.md'), content, 'utf-8');
  }

  it('extracts a single chapter block by anchor', async () => {
    await writeOutline(`# 卷一

#### 第1章：启程前夜
| POV | 武松 |
| 核心事件 | 磨剑 |

#### 第2章：下山
| POV | 武松 |
| 核心事件 | 下山 |`);
    const block = await extractChapterOutline(dir, 1);
    expect(block).toContain('第1章');
    expect(block).toContain('磨剑');
    expect(block).not.toContain('下山');
  });

  it('matches range chapters (第16-17章)', async () => {
    await writeOutline(`#### 第16-17章：江湖初涉
| POV | 武松 |
| 核心事件 | 接触江湖 |`);
    expect(await extractChapterOutline(dir, 16)).toContain('江湖初涉');
    expect(await extractChapterOutline(dir, 17)).toContain('江湖初涉');
  });

  it('matches wider range (第27-30章)', async () => {
    await writeOutline(`#### 第27-30章：棋局
| POV | 世子 |`);
    expect(await extractChapterOutline(dir, 29)).toContain('棋局');
  });

  it('returns placeholder when chapter not found', async () => {
    await writeOutline(`#### 第1章：a\n| POV | x |`);
    const block = await extractChapterOutline(dir, 99);
    expect(block).toContain('未在 outline-detailed.md 中规划');
  });

  it('returns empty string when outline file missing', async () => {
    const block = await extractChapterOutline(dir, 1);
    expect(block).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/agent/chapter-context.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 `extractChapterOutline`**

```typescript
// src/agent/chapter-context.ts
import fs from 'node:fs/promises';
import path from 'node:path';

const NOVEL_DIR = '.novel';
const OUTLINE_FILE = 'outline-detailed.md';

/** 读取 .novel/ 下文本文件，失败返回空串。 */
async function readNovelFile(projectDir: string, rel: string): Promise<string> {
  try {
    return (await fs.readFile(path.join(projectDir, NOVEL_DIR, rel), 'utf-8')).trim();
  } catch {
    return '';
  }
}

/** 判断章号 N 是否落在范围锚点（如"第16-17章"/"第27-30章"）内。 */
function chapterInRange(anchorNums: number[], target: number): boolean {
  if (anchorNums.length === 1) return anchorNums[0] === target;
  return target >= anchorNums[0] && target <= anchorNums[anchorNums.length - 1];
}

/** 从大纲全文提取第 N 章块。 */
export async function extractChapterOutline(
  projectDir: string,
  chapter: number,
): Promise<string> {
  const raw = await readNovelFile(projectDir, OUTLINE_FILE);
  if (!raw) return '';

  const lines = raw.split('\n');
  const anchorRe = /^####\s+第([\d]+(?:-[\d]+)*)章/;
  let startIdx = -1;
  let matchedRange: number[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(anchorRe);
    if (!m) continue;
    const nums = m[1].split('-').map((n) => parseInt(n, 10));
    if (chapterInRange(nums, chapter)) {
      startIdx = i;
      matchedRange = nums;
      break;
    }
  }

  if (startIdx === -1) {
    return `> [第${chapter}章未在 outline-detailed.md 中规划]`;
  }

  // 截取到下一个 #### 或 ### 之前
  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^#{3,4}\s/.test(lines[j])) {
      endIdx = j;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join('\n').trim();
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/agent/chapter-context.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
git add src/agent/chapter-context.ts tests/unit/agent/chapter-context.test.ts
git commit -m "feat: extractChapterOutline 大纲块提取"
```

---

## Task 2: 角色名解析改进（支持表格索引）

**Files:**
- Modify: `src/agent/context-manager.ts:128-141`（`readCharacterNames`）
- Modify: `tests/unit/agent/context-manager.test.ts`

**背景**：现有 `readCharacterNames` 只匹配 `- 姓名：xxx` 字段格式。示例项目 的 profiles.md 是表格索引（`| 角色 | 文件 |`），现有实现返回空数组——第 3 级回退会失效。

- [ ] **Step 1: 写失败测试——表格索引解析**

在 `tests/unit/agent/context-manager.test.ts` 末尾追加：

```typescript
describe('readCharacterNames (table index)', () => {
  it('parses names from table-style profiles.md', async () => {
    const profiles = `# 角色档案索引

## 核心角色

| 角色 | 文件 | 定位 |
|------|------|------|
| 🗡️ 武松 | [武松.md](profiles/武松.md) | 主角 |
| 👴 武大郎 | [武大郎.md](profiles/武大郎.md) | 祖父 |`;
    await fs.mkdir(path.join(tempDir, '.novel', 'characters'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.novel', 'characters', 'profiles.md'), profiles);

    const names = await readCharacterNames(tempDir);
    expect(names).toContain('武松');
    expect(names).toContain('武大郎');
    expect(names.length).toBe(2);
  });

  it('still parses legacy field format', async () => {
    const profiles = `- 姓名：林冲\n- 姓名：孙二娘`;
    await fs.mkdir(path.join(tempDir, '.novel', 'characters'), { recursive: true });
    await fs.writeFile(path.join(tempDir, '.novel', 'characters', 'profiles.md'), profiles);

    const names = await readCharacterNames(tempDir);
    expect(names).toContain('林冲');
    expect(names).toContain('孙二娘');
  });
});
```

> 注：需在测试文件顶部 import 区补 `readCharacterNames`，并在 `tempDir` 的 beforeEach 中确保 `.novel/characters` 已创建（或测试内自行 mkdir）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/unit/agent/context-manager.test.ts -t "table index"`
Expected: FAIL — `readCharacterNames` 未导出 / 表格格式返回空

- [ ] **Step 3: 改进 `readCharacterNames` 并导出**

修改 `src/agent/context-manager.ts`：

```typescript
/** 从角色档案（characters/profiles.md）解析角色名列表。
 *  支持两种格式：字段式（`- 姓名：xxx`）与表格索引式（`| 角色 | 文件 |`）。 */
export async function readCharacterNames(projectDir: string): Promise<string[]> {
  const raw = await readNovelFile(projectDir, PROFILES_FILE);
  if (!raw) return [];
  const names: string[] = [];
  const seen = new Set<string>();

  // 1. 字段式：- 姓名：xxx / * 姓名: xxx
  const fieldRe = /^[-*]\s*姓名\s*[:：]\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(raw)) !== null) {
    const name = m[1].trim();
    if (name && !seen.has(name)) { seen.add(name); names.push(name); }
  }

  // 2. 表格索引式：| 角色 | 文件 |  ——  取第一列，去掉 emoji 前缀与链接
  const tableRe = /^\|\s*([^[|]+?)\s*\|\s*\[.+?\]\([^)]+\)\s*\|/gm;
  while ((m = tableRe.exec(raw)) !== null) {
    // 去掉行首 emoji（如 🗡️ ）与空白
    const name = m[1].replace(/^[\p{Emoji}\s]+/u, '').trim();
    if (name && name !== '角色' && !seen.has(name)) { seen.add(name); names.push(name); }
  }

  return names;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/agent/context-manager.test.ts -t "table index"`
Expected: PASS

- [ ] **Step 5: 运行全量 context-manager 测试防止回归**

Run: `pnpm vitest run tests/unit/agent/context-manager.test.ts`
Expected: PASS (all)

- [ ] **Step 6: 提交**

```bash
git add src/agent/context-manager.ts tests/unit/agent/context-manager.test.ts
git commit -m "feat: readCharacterNames 支持表格索引格式并导出"
```

---

## Task 3: 出场角色识别（三级回退 `identifyCast`）

**Files:**
- Modify: `src/agent/chapter-context.ts`
- Modify: `tests/unit/agent/chapter-context.test.ts`

- [ ] **Step 1: 写失败测试**

在 `chapter-context.test.ts` 追加：

```typescript
import { identifyCast } from '../../../src/agent/chapter-context';

describe('identifyCast', () => {
  it('level 1: uses outline-meta.json pov', async () => {
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'outline-meta.json'),
      JSON.stringify({ actBreaks: [5, 15], chapters: [{ chapter: 1, pov: '武松' }] }),
    );
    const cast = await identifyCast(dir, 1, '');
    expect(cast.pov).toBe('武松');
    expect(cast.full).toContain('武松');
  });

  it('level 2: parses 出场角色 row from outline block', async () => {
    const block = `#### 第11章：鲁智深
| POV | 武松 |
| 出场角色 | 武松、鲁智深 |`;
    const cast = await identifyCast(dir, 11, block);
    expect(cast.pov).toBe('武松');
    expect(cast.full).toContain('武松');
    expect(cast.full).toContain('鲁智深');
  });

  it('level 3: name-matches against character names', async () => {
    const block = `#### 第5章：第一剑
武松在渡口遇到老船工和恶霸。`;
    const names = ['武松', '鲁智深', '西门庆'];
    const cast = await identifyCast(dir, 5, block, names);
    expect(cast.full).toContain('武松');
    expect(cast.brief).not.toContain('武松'); // 武松 是 full 不在 brief
    // 鲁智深/西门庆 未在 block 出现，不在 cast
    expect(cast.full).not.toContain('鲁智深');
  });

  it('level 3 fallback: matches names mentioned in block', async () => {
    const block = `#### 第12章
武松和鲁智深谈话，提到西门庆。`;
    const names = ['武松', '鲁智深', '西门庆'];
    const cast = await identifyCast(dir, 12, block, names);
    expect(cast.full).toContain('武松');
    expect(cast.full).toContain('鲁智深');
    expect(cast.brief).toContain('西门庆'); // 仅被提及，非显式出场
  });

  it('all-fail: returns empty cast', async () => {
    const cast = await identifyCast(dir, 1, '');
    expect(cast.pov).toBe('');
    expect(cast.full).toEqual([]);
    expect(cast.brief).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/unit/agent/chapter-context.test.ts -t identifyCast`
Expected: FAIL — `identifyCast` not exported

- [ ] **Step 3: 实现 `identifyCast`**

在 `src/agent/chapter-context.ts` 追加：

```typescript
import { readNovelFile as _rnf } from './context-manager'; // 复用读取
import { parseOutlineMeta } from '../shared/outline-meta';

export interface Cast {
  pov: string;
  /** L1 完整注入角色名 */
  full: string[];
  /** L2 速查角色名 */
  brief: string[];
}

const META_FILE = 'outline-meta.json';

/** 从大纲块表格解析 POV 与出场角色。 */
function parseCastFromBlock(block: string): { pov: string; cast: string[] } {
  if (!block) return { pov: '', cast: [] };
  const lines = block.split('\n');
  let pov = '';
  const cast: string[] = [];
  for (const line of lines) {
    const povM = line.match(/^\|\s*POV\s*\|\s*(.+?)\s*\|/);
    if (povM) {
      pov = povM[1].replace(/（.*?）/g, '').trim();
      continue;
    }
    const castM = line.match(/^\|\s*出场角色\s*\|\s*(.+?)\s*\|/);
    if (castM) {
      const cleaned = castM[1].replace(/（.*?）/g, '');
      for (const part of cleaned.split(/[、，,]/)) {
        const n = part.trim();
        if (n && n !== '（路人）' && n !== '群像') cast.push(n);
      }
    }
  }
  return { pov, cast };
}

/** 第 N 章出场角色识别（三级回退）。 */
export async function identifyCast(
  projectDir: string,
  chapter: number,
  outlineBlock: string,
  knownNames: string[] = [],
): Promise<Cast> {
  // Level 1: outline-meta.json pov
  const metaRaw = await readNovelFile(projectDir, META_FILE);
  if (metaRaw) {
    const meta = parseOutlineMeta(JSON.parse(metaRaw));
    if (meta) {
      const entry = meta.chapters.find((c) => c.chapter === chapter);
      if (entry && entry.pov) {
        return { pov: entry.pov, full: [entry.pov], brief: [] };
      }
    }
  }

  // Level 2: outline block 表格
  const { pov, cast } = parseCastFromBlock(outlineBlock);
  if (pov || cast.length > 0) {
    const fullSet = new Set<string>([pov, ...cast].filter(Boolean));
    return { pov, full: [...fullSet], brief: [] };
  }

  // Level 3: name matching against known names
  if (knownNames.length === 0 || !outlineBlock) {
    return { pov: '', full: [], brief: [] };
  }
  const mentioned: string[] = [];
  for (const name of knownNames) {
    if (outlineBlock.includes(name)) mentioned.push(name);
  }
  if (mentioned.length === 0) return { pov: '', full: [], brief: [] };
  // 第一个匹配视为 POV/full，其余为 brief（保守策略）
  return { pov: mentioned[0], full: [mentioned[0]], brief: mentioned.slice(1) };
}
```

> 注：`readNovelFile` 在 context-manager 是私有的。chapter-context.ts 内已有自己的 `readNovelFile`（Task 1 定义），复用本模块的即可。删去上面 `import { readNovelFile as _rnf }` 这行（误加），保留 `import { parseOutlineMeta }`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/agent/chapter-context.test.ts -t identifyCast`
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
git add src/agent/chapter-context.ts tests/unit/agent/chapter-context.test.ts
git commit -m "feat: identifyCast 出场角色三级回退识别"
```

---

## Task 4: 分级注入（`buildCastLayer`）

**Files:**
- Modify: `src/agent/chapter-context.ts`
- Modify: `tests/unit/agent/chapter-context.test.ts`

- [ ] **Step 1: 写失败测试**

追加：

```typescript
import { buildCastLayer } from '../../../src/agent/chapter-context';

describe('buildCastLayer', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, '.novel', 'characters', 'profiles'), { recursive: true });
  });

  it('L1: injects key sections of POV profile, skips verbose sections', async () => {
    const profile = `# 武松

## 基本信息
- 姓名：武松

## 出身与经历
幼年家族优渥，七岁家道中落。

## 驱动力三角
- 外在目标：复仇
- 核心缺陷：太窄

## 性格
沉默寡言，右手虚握。

## 成长弧线
（此处 5000 字弧线详情，不应注入）`;
    await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles', '武松.md'), profile);

    const layer = await buildCastLayer(dir, { pov: '武松', full: ['武松'], brief: [] });
    expect(layer).toContain('武松');
    expect(layer).toContain('出身与经历');
    expect(layer).toContain('驱动力三角');
    expect(layer).toContain('太窄');
    expect(layer).not.toContain('5000 字弧线详情');
  });

  it('L1: truncates profile over 6KB budget', async () => {
    const longSection = 'A'.repeat(7000);
    const profile = `# 西门庆\n\n## 出身与经历\n${longSection}`;
    await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles', '西门庆.md'), profile);
    const layer = await buildCastLayer(dir, { pov: '', full: ['西门庆'], brief: [] });
    expect(layer.length).toBeLessThan(7000);
    expect(layer).toContain('完整档案见');
  });

  it('L2: brief card for minor characters', async () => {
    const profile = `# 鲁智深\n城镇药铺掌柜，门派二师叔。温和本性。`;
    await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles', '鲁智深.md'), profile);
    const layer = await buildCastLayer(dir, { pov: '武松', full: ['武松'], brief: ['鲁智深'] });
    expect(layer).toContain('鲁智深');
    // L2 只取首段，不含完整 profile 全文（此处 profile 短，但应标注为速查）
    expect(layer).toContain('速查');
  });

  it('total budget: degrades to L2 when exceeding 20KB', async () => {
    // 4 个角色，每个 profile 6KB → 总 24KB，应降级最后一个为 L2
    const big = 'B'.repeat(5900);
    for (const name of ['武松', '西门庆', '世子', '顾琪']) {
      await fs.writeFile(
        path.join(dir, '.novel', 'characters', 'profiles', `${name}.md`),
        `# ${name}\n\n## 出身与经历\n${big}`,
      );
    }
    const layer = await buildCastLayer(dir, {
      pov: '武松',
      full: ['武松', '西门庆', '世子', '顾琪'],
      brief: [],
    });
    // 第四个角色应降级为速查
    expect(layer).toContain('速查');
  });

  it('skips missing profile files gracefully', async () => {
    const layer = await buildCastLayer(dir, { pov: '不存在', full: ['不存在'], brief: [] });
    expect(layer).not.toContain('不存在.md');
    // 不应报错，层可为空或仅含说明
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/unit/agent/chapter-context.test.ts -t buildCastLayer`
Expected: FAIL — `buildCastLayer` not exported

- [ ] **Step 3: 实现 `buildCastLayer`**

在 `src/agent/chapter-context.ts` 追加：

```typescript
const PROFILES_DIR = path.join('characters', 'profiles');
const L1_BUDGET_PER_CHAR = 6 * 1024; // 6KB
const LAYER_TOTAL_BUDGET = 20 * 1024; // 20KB

/** L1 关键段优先级（高→低），其余段截断跳过。 */
const KEY_SECTIONS = ['出身与经历', '驱动力三角', '性格', '语言', '基本信息', '外貌'];

/** 按 ## 标题切片，提取关键段。 */
function extractKeySections(profile: string): string {
  const sections = profile.split(/\n(?=##\s)/);
  const picked: string[] = [];
  let size = 0;
  // 先按优先级取关键段
  for (const key of KEY_SECTIONS) {
    const sec = sections.find((s) => new RegExp(`^##\\s.*${key}`).test(s));
    if (sec) {
      picked.push(sec);
      size += sec.length;
      if (size > L1_BUDGET_PER_CHAR) break;
    }
  }
  if (picked.length === 0) {
    // 标题结构不清晰，退化为前 2KB
    return profile.slice(0, 2 * 1024) + `\n\n[完整档案见 …]`;
  }
  let result = picked.join('\n\n');
  if (result.length > L1_BUDGET_PER_CHAR) {
    result = result.slice(0, L1_BUDGET_PER_CHAR) + `\n\n[完整档案见 …]`;
  }
  return result;
}

/** L2 速查卡：首段 + 标志细节。 */
function buildBriefCard(name: string, profile: string): string {
  const firstPara = profile.split(/\n(?=##\s)/)[0].replace(/^#\s.*\n/, '').trim();
  return `- **${name}**（速查）：${firstPara.slice(0, 150)}`;
}

/** 构建出场角色层。 */
export async function buildCastLayer(projectDir: string, cast: Cast): Promise<string> {
  const { pov, full, brief } = cast;
  if (!pov && full.length === 0 && brief.length === 0) return '';

  const sections: string[] = ['### 本章出场角色层'];
  let totalSize = 0;

  // L1: full 列表（POV 优先）
  for (const name of full) {
    const profilePath = path.join(projectDir, NOVEL_DIR, PROFILES_DIR, `${name}.md`);
    let profile: string;
    try {
      profile = (await fs.readFile(profilePath, 'utf-8')).trim();
    } catch {
      continue; // 文件缺失，跳过
    }
    if (totalSize + profile.length > LAYER_TOTAL_BUDGET) {
      // 降级为 L2
      sections.push(buildBriefCard(name, profile));
      totalSize += 200;
      continue;
    }
    const extracted = extractKeySections(profile);
    const label = name === pov ? '（POV）' : '';
    sections.push(`#### ${name}${label}\n${extracted}`);
    totalSize += extracted.length;
  }

  // L2: brief 列表
  for (const name of brief) {
    const profilePath = path.join(projectDir, NOVEL_DIR, PROFILES_DIR, `${name}.md`);
    let profile: string;
    try {
      profile = (await fs.readFile(profilePath, 'utf-8')).trim();
    } catch {
      continue;
    }
    sections.push(buildBriefCard(name, profile));
  }

  return sections.join('\n\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/agent/chapter-context.test.ts -t buildCastLayer`
Expected: PASS (5 tests)

- [ ] **Step 5: 提交**

```bash
git add src/agent/chapter-context.ts tests/unit/agent/chapter-context.test.ts
git commit -m "feat: buildCastLayer 分级注入与 token 预算控制"
```

---

## Task 5: 接入 prompt-composer（写作阶段两层注入）

**Files:**
- Modify: `src/agent/prompt-composer.ts`（`buildWritingContextLayers` 与 import）
- Modify: `tests/unit/agent/prompt-composer.test.ts`

- [ ] **Step 1: 写失败测试——写作阶段注入大纲块与角色层**

在 `prompt-composer.test.ts` 的写作阶段相关 describe（或新增 `describe('writing context layers', ...)`）中追加：

```typescript
it('injects chapter outline block in writing stage', async () => {
  mockLimit.mockResolvedValue([makeProject({ currentStage: 'writing', chapterCount: 10, targetWords: 30000 })]);
  await fs.mkdir(path.join(tempDir, '.novel'), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, '.novel', 'outline-detailed.md'),
    '#### 第1章：启程前夜\n| POV | 武松 |\n| 核心事件 | 磨剑 |',
  );

  const prompt = await composePrompt({
    message: '写第1章',
    projectId: 'p',
    stage: 'writing',
    projectDir: tempDir,
  });
  expect(prompt).toContain('本章大纲（第1章）');
  expect(prompt).toContain('磨剑');
});

it('injects cast layer with POV profile in writing stage', async () => {
  mockLimit.mockResolvedValue([makeProject({ currentStage: 'writing', chapterCount: 10, targetWords: 30000 })]);
  await fs.mkdir(path.join(tempDir, '.novel', 'characters', 'profiles'), { recursive: true });
  await fs.writeFile(
    path.join(tempDir, '.novel', 'outline-detailed.md'),
    '#### 第1章：启程前夜\n| POV | 武松 |\n| 出场角色 | 武松 |',
  );
  await fs.writeFile(
    path.join(tempDir, '.novel', 'characters', 'profiles', '武松.md'),
    '# 武松\n\n## 出身与经历\n复仇少年。\n\n## 驱动力三角\n核心缺陷：太窄',
  );

  const prompt = await composePrompt({
    message: '写第1章',
    projectId: 'p',
    stage: 'writing',
    projectDir: tempDir,
  });
  expect(prompt).toContain('本章出场角色层');
  expect(prompt).toContain('武松');
  expect(prompt).toContain('太窄');
});

it('outline block precedes cast layer', async () => {
  mockLimit.mockResolvedValue([makeProject({ currentStage: 'writing', chapterCount: 10, targetWords: 30000 })]);
  await fs.mkdir(path.join(tempDir, '.novel', 'characters', 'profiles'), { recursive: true });
  await fs.writeFile(path.join(tempDir, '.novel', 'outline-detailed.md'), '#### 第1章\n| POV | 武松 |');
  await fs.writeFile(path.join(tempDir, '.novel', 'characters', 'profiles', '武松.md'), '# 武松\n## 出身\nx');

  const prompt = await composePrompt({
    message: '写第1章', projectId: 'p', stage: 'writing', projectDir: tempDir,
  });
  const outlineIdx = prompt.indexOf('本章大纲');
  const castIdx = prompt.indexOf('本章出场角色层');
  expect(outlineIdx).toBeGreaterThan(-1);
  expect(castIdx).toBeGreaterThan(outlineIdx);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/unit/agent/prompt-composer.test.ts -t "writing context"`
Expected: FAIL — prompt 不含"本章大纲"

- [ ] **Step 3: 修改 `buildWritingContextLayers`**

在 `src/agent/prompt-composer.ts`：

顶部 import 区追加：
```typescript
import { extractChapterOutline, identifyCast, buildCastLayer } from './chapter-context';
import { readCharacterNames } from './context-manager';
```

修改 `buildWritingContextLayers`（约 prompt-composer.ts:340-356）：

```typescript
async function buildWritingContextLayers(
  projectDir: string,
  currentChapter: number,
): Promise<string> {
  const sections: string[] = [];

  const core = await buildCoreSettingsLayer(projectDir);
  if (core) sections.push(core);

  const stateLayer = await buildStateLayer(projectDir);
  if (stateLayer) sections.push(stateLayer);

  // ★ 新增：本章大纲块
  const outlineBlock = await extractChapterOutline(projectDir, currentChapter);
  if (outlineBlock) {
    sections.push(`### 本章大纲（第${currentChapter}章）\n${outlineBlock}\n\n> 严格按大纲推进。若需偏离（增删事件、调整节奏），在回复里说明原因。`);
  }

  // ★ 新增：本章出场角色层
  const knownNames = await readCharacterNames(projectDir);
  const cast = await identifyCast(projectDir, currentChapter, outlineBlock, knownNames);
  const castLayer = await buildCastLayer(projectDir, cast);
  if (castLayer) sections.push(castLayer);

  const rolling = await buildRollingSummaryContext(projectDir);
  if (rolling) {
    sections.push(`### 滚动摘要层（最近 3 章详摘，更早章节简摘）\n${rolling}`);
  } else {
    sections.push(
      '### 滚动摘要层\n（暂无章节摘要。每写完一章请在 `.novel/chapters/第N章.summary.md` 生成 200 字摘要。）',
    );
  }

  const foreshadow = await buildForeshadowLayer(projectDir, currentChapter);
  if (foreshadow) sections.push(foreshadow);

  return `## Novel Context Layers\n\n${sections.join('\n\n')}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: PASS (含新测试)

- [ ] **Step 5: 运行全量 agent 测试防止回归**

Run: `pnpm vitest run tests/unit/agent/`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/agent/prompt-composer.ts tests/unit/agent/prompt-composer.test.ts
git commit -m "feat: 写作阶段注入本章大纲块与出场角色层"
```

---

## Task 6: writing 阶段指令修订

**Files:**
- Modify: `src/agent/prompt-composer.ts`（`STAGE_INSTRUCTIONS.writing`，约 :60-72）
- Modify: `tests/unit/agent/prompt-composer.test.ts`（STAGE_FEATURES.writing 断言）

- [ ] **Step 1: 更新测试特征文本**

在 `prompt-composer.test.ts` 的 `STAGE_FEATURES` 中，将 writing 的特征改为新指令首句：

```typescript
writing: '本章大纲与出场角色档案已注入上方上下文',
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/unit/agent/prompt-composer.test.ts -t "injects writing"`
Expected: FAIL — 仍含旧特征

- [ ] **Step 3: 修改 `STAGE_INSTRUCTIONS.writing`**

在 `src/agent/prompt-composer.ts` 的 `writing` 指令字符串开头追加（在"为小说撰写真正的散文正文"之前）：

```typescript
writing: `**写章前**：本章大纲与出场角色档案已注入上方上下文。无需再 Read 这些文件——直接基于注入内容写作。仅在需要查阅未注入细节（如某角色完整弧线、某武学体系全貌）时才 Read。

为小说撰写真正的散文正文。聚焦叙事流畅度、对话、描写与节奏，产出打磨过的草稿正文。将章节保存到 .novel/chapters/ 目录。
（… 后续维持原文 …）`,
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/agent/prompt-composer.test.ts -t "stage instruction"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/prompt-composer.ts tests/unit/agent/prompt-composer.test.ts
git commit -m "feat: writing 指令增'写章前档案已注入'指引"
```

---

## Task 7: 声口库注入（可选资产）

**Files:**
- Modify: `src/agent/chapter-context.ts`（`buildCastLayer` 追加声口附录）
- Modify: `tests/unit/agent/chapter-context.test.ts`

- [ ] **Step 1: 写失败测试**

追加：

```typescript
describe('buildCastLayer voice samples', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, '.novel', 'characters', 'profiles'), { recursive: true });
    await fs.mkdir(path.join(dir, '.novel', 'characters', 'voices'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'characters', 'profiles', '武松.md'),
      '# 武松\n\n## 出身与经历\n复仇少年。',
    );
  });

  it('appends voice samples when voices file exists', async () => {
    await fs.writeFile(
      path.join(dir, '.novel', 'characters', 'voices', '武松.md'),
      '## 独白\n剑在手，心不静。\n\n## 对话\n"让开。"',
    );
    const layer = await buildCastLayer(dir, { pov: '武松', full: ['武松'], brief: [] });
    expect(layer).toContain('声口样本');
    expect(layer).toContain('剑在手，心不静');
  });

  it('skips voice when no voices file', async () => {
    const layer = await buildCastLayer(dir, { pov: '武松', full: ['武松'], brief: [] });
    expect(layer).not.toContain('声口样本');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/unit/agent/chapter-context.test.ts -t "voice samples"`
Expected: FAIL — 不含"声口样本"

- [ ] **Step 3: 修改 `buildCastLayer` 追加声口**

在 `src/agent/chapter-context.ts` 的 `buildCastLayer` 中，L1 注入 profile 后、追加到 sections 前，插入声口读取：

```typescript
// 在 sections.push(`#### ${name}${label}\n${extracted}`) 之前，改为：
const voicesPath = path.join(projectDir, NOVEL_DIR, 'characters', 'voices', `${name}.md`);
let voiceBlock = '';
try {
  const voices = (await fs.readFile(voicesPath, 'utf-8')).trim();
  if (voices) voiceBlock = `\n\n**声口样本**\n${voices}`;
} catch { /* 可选资产，缺失即跳过 */ }

const block = `${extracted}${voiceBlock}`;
sections.push(`#### ${name}${label}\n${block}`);
totalSize += block.length;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/agent/chapter-context.test.ts -t "voice samples"`
Expected: PASS (2 tests)

- [ ] **Step 5: 提交**

```bash
git add src/agent/chapter-context.ts tests/unit/agent/chapter-context.test.ts
git commit -m "feat: 声口库可选注入（L1 角色）"
```

---

## Task 8: 删除死代码 compose.ts

**Files:**
- Delete: `src/prompts/compose.ts`

- [ ] **Step 1: 确认零引用**

Run: `grep -rn "prompts/compose" src/ tests/ --include="*.ts"` 
Expected: 无输出（零引用）

- [ ] **Step 2: 删除文件**

Run: `rm src/prompts/compose.ts`

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `pnpm vitest run`
Expected: PASS (全部)

- [ ] **Step 4: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git rm src/prompts/compose.ts
git commit -m "chore: 删除死代码 compose.ts（零调用点）"
```

---

## Task 9: docs 对齐

**Files:**
- Modify: `docs/工具使用指南.md`（第 4.2 节）

- [ ] **Step 1: 更新分层表格**

将第 4.2 节"上下文分层"表格从四层改为六层，新增两行：

```markdown
| 层 | 来源 | 作用 | 注入条件 |
|---|---|---|---|
| 核心设定 | concept.md + world-building.md | 恒定世界观锚点 | 写作阶段 |
| 状态 | state.json | 角色位置/情绪/已知/关系 | 文件存在时 |
| **本章大纲** | **outline-detailed.md 第N章块** | **本章发生什么** | **写作阶段（新）** |
| **本章出场角色** | **profiles/{角色}.md 分级注入** | **角色是谁、声口、驱动力** | **写作阶段（新）** |
| 滚动摘要 | 第N-K章的 .summary.md | 前文回顾 | buildRollingSummaryContext() |
| 活跃伏笔 | foreshadow.json | 待兑现的伏笔提醒 | status=pending/planted |
```

- [ ] **Step 2: 更新批量写作示例**

移除"用户每章手打'先读 outline、读 scenes、读 state'"的说明，替换为：

```markdown
### 单章触发（推荐）

逐章触发，大纲块与出场角色档案已自动注入：

curl -X POST http://localhost:3006/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "proj_xxx",
    "agentId": "claude",
    "stage": "writing",
    "skillId": "wuxia",
    "message": "请写第N章正文。"
  }'
```

- [ ] **Step 3: 提交**

```bash
git add docs/工具使用指南.md
git commit -m "docs: 上下文分层四层→六层，移除手动 Read 说明"
```

---

## 自审

**1. Spec 覆盖**：
- §3.1 三级回退 → Task 3 ✓
- §3.2 分级注入 + 20KB 预算 → Task 4 ✓
- §3.2 L1 段优先级（出身/驱动力优先） → Task 4 `KEY_SECTIONS` ✓
- §3.3 大纲块提取 + 连读范围 → Task 1 ✓
- §3.3 偏离需说明约束 → Task 5 prompt 文本 ✓
- §3.4 声口库可选 → Task 7 ✓
- §3.5 删 compose.ts + docs 对齐 → Task 8/9 ✓
- §3.6 writing 指令修订 → Task 6 ✓
- §4 非目标（无愚公模板）→ 计划中无对应任务 ✓（正确）

**2. Placeholder 扫描**：无 TBD/TODO；每个 Step 含完整代码或确切命令。

**3. 类型一致性**：
- `Cast` 接口在 Task 3 定义，Task 4/5/7 使用一致（`{ pov, full, brief }`）
- `extractChapterOutline` / `identifyCast` / `buildCastLayer` 签名跨任务一致
- `readCharacterNames` Task 2 改为 export，Task 5 import 使用 ✓
