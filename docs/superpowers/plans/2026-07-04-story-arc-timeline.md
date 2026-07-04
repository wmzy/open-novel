# 故事脉络时间线视图 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「故事脉络」视图——主图 timeline 展示全书脉络（卷为 section、章为节点），展开章节看 sequenceDiagram 角色交互；交互数据由 AI 批量预填、可在视图内修正。

**Architecture:** 三层分离——纯函数层（`diagram-builders.ts` 解析大纲生成 mermaid 源码）、数据层（`timeline-filler.ts` AI 批量预填 + `timeline.ts` 路由 + `projects.ts` 加通用写文件端点）、视图层（`StoryArcView.tsx`）。sequenceDiagram 源码在前端按需生成，便于修正后即时重渲染。

**Tech Stack:** TypeScript, Hono (API), React + @linaria/core (前端), @tanstack/react-query (数据), mermaid 11.16 (图表), Vitest (测试)。

**Spec:** `docs/superpowers/specs/2026-07-04-story-arc-timeline-design.md`

---

## 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/agent/timeline-filler.ts` | AI 批量预填：遍历章节→AI 生成「角色交互」字段→写回大纲 md。幂等。 |
| `src/api/routes/timeline.ts` | `GET /:project/timeline`、`POST .../fill`（SSE）、`PUT .../interaction` |
| `src/web/components/views/StoryArcView.tsx` | 故事脉络视图 |
| `tests/unit/shared/diagram-builders-timeline.test.ts` | 纯函数测试（timeline + sequenceDiagram + 字段解析） |
| `tests/unit/agent/timeline-filler.test.ts` | AI 预填测试（mock AI） |
| `tests/unit/api/timeline.test.ts` | 路由测试 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/shared/diagram-builders.ts` | 新增 `parseOutlineChapters`、`buildStoryTimeline`、`parseInteractionField`、`buildSequenceDiagram` |
| `src/api/routes/projects.ts` | 新增 `PUT /:id/files` 通用写文件端点（目前无） |
| `src/shared/stages.ts` | `ALL_VIEWS` 加 `{ id: 'story-arc', label: '故事脉络' }` |
| `src/web/pages/ProjectPage.tsx` | `ViewRouter` 加 `story-arc` 分支 |

---

## Task 1: 纯函数——章节解析 + timeline 源码

**Files:**
- Modify: `src/shared/diagram-builders.ts`（末尾追加）
- Test: `tests/unit/shared/diagram-builders-timeline.test.ts`

### 步骤

- [ ] **Step 1: 写失败的测试——parseOutlineChapters**

创建 `tests/unit/shared/diagram-builders-timeline.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { parseOutlineChapters, buildStoryTimeline } from '../../../src/shared/diagram-builders';

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

#### 第2章：远行
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
      title: '远行',
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run tests/unit/shared/diagram-builders-timeline.test.ts`
Expected: FAIL，`parseOutlineChapters is not a function`

- [ ] **Step 3: 实现 parseOutlineChapters**

在 `src/shared/diagram-builders.ts` 末尾追加：

```typescript
// ── ⑤ 故事脉络时间线 ──

export interface OutlineChapter {
  number: number;
  title: string;
  pov: string;
  /** 出场角色名（已去括号批注）；无出场角色行时为空数组 */
  cast: string[];
  /** 该章所属 section 标题（最近的 ## 标题） */
  section: string;
}

/** 清理出场角色名：去括号批注、按顿号/逗号切分、去群像词缀。 */
function parseCastList(raw: string): string[] {
  return raw
    .replace(/[（(][^)）]*[)）]/g, '') // 去括号批注
    .split(/[、，,]/)
    .map((s) => s.trim())
    .filter((s) => s && !/(群像|路人|背景)$/.test(s)); // 去掉"…群像"等非具名
}

/**
 * 解析大纲全文，提取所有章节的结构化信息。
 * 章节锚点：`#### 第N章：标题` 或 `#### 第N-M章：标题`（连读章节取首章号）。
 * section：最近的上一个 `## ` 标题。
 */
export function parseOutlineChapters(outline: string): OutlineChapter[] {
  if (!outline) return [];
  const lines = outline.split('\n');
  const chapters: OutlineChapter[] = [];
  let currentSection = '';

  const anchorRe = /^####\s+第([\d]+)(?:-[\d]+)?章[：:]?\s*(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const secMatch = lines[i].match(/^##\s+(.+)$/);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      continue;
    }
    const anchorMatch = lines[i].match(anchorRe);
    if (!anchorMatch) continue;

    const number = parseInt(anchorMatch[1], 10);
    const title = anchorMatch[2].trim();
    // 向下扫描表格行找 POV 和出场角色（到下一个 #### 或 ### 之前）
    let pov = '';
    let castRaw = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (/^#{3,4}\s/.test(lines[j])) break;
      const povMatch = lines[j].match(/^\|\s*POV\s*\|\s*(.+?)\s*\|/);
      if (povMatch) pov = povMatch[1].trim();
      const castMatch = lines[j].match(/^\|\s*出场角色\s*\|\s*(.+?)\s*\|/);
      if (castMatch) castRaw = castMatch[1].trim();
    }

    chapters.push({
      number,
      title,
      pov,
      cast: parseCastList(castRaw),
      section: currentSection,
    });
  }

  return chapters;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run tests/unit/shared/diagram-builders-timeline.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败的测试——buildStoryTimeline**

在 `tests/unit/shared/diagram-builders-timeline.test.ts` 末尾追加：

```typescript
import type { OutlineChapter } from '../../../src/shared/diagram-builders';

describe('buildStoryTimeline', () => {
  const chapters: OutlineChapter[] = [
    { number: 1, title: '启程前夜', pov: '武松', cast: ['武松'], section: '第一篇 出山' },
    { number: 2, title: '远行', pov: '武松', cast: ['武松', '小镇百姓'], section: '第一篇 出山' },
    { number: 16, title: '城镇', pov: '武松', cast: ['武松', '鲁智深'], section: '第二卷' },
  ];

  it('空数组返回 null', () => {
    expect(buildStoryTimeline([])).toBeNull();
  });

  it('生成 timeline 源码，含 title 与 section 划分', () => {
    const tl = buildStoryTimeline(chapters);
    expect(tl).not.toBeNull();
    expect(tl!).toContain('timeline');
    expect(tl!).toContain('section 第一卷');
    expect(tl!).toContain('section 第二篇 城镇');
  });

  it('每个章节节点含章号 + POV + 首个出场角色', () => {
    const tl = buildStoryTimeline(chapters);
    expect(tl!).toContain('第1章 启程前夜');
    expect(tl!).toContain('POV 武松');
  });

  it('同一 section 的章节归到同一 section 块（不重复 section 标题）', () => {
    const tl = buildStoryTimeline(chapters)!;
    const sectionCount = (tl.match(/section 第一卷/g) || []).length;
    expect(sectionCount).toBe(1);
  });
});
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `pnpm vitest run tests/unit/shared/diagram-builders-timeline.test.ts`
Expected: FAIL，`buildStoryTimeline is not a function`

- [ ] **Step 7: 实现 buildStoryTimeline**

在 `src/shared/diagram-builders.ts` 末尾追加：

```typescript
/**
 * 从解析后的章节列表生成 mermaid timeline 源码。
 * section = 章节的 section 字段；节点标注章号+标题+POV。
 * 返回 null 表示无数据。
 */
export function buildStoryTimeline(chapters: OutlineChapter[]): string | null {
  if (!chapters || chapters.length === 0) return null;

  const lines: string[] = ['timeline', '    title 故事脉络'];
  let lastSection = '';

  for (const ch of chapters) {
    if (ch.section && ch.section !== lastSection) {
      lines.push(`    section ${sanitize(ch.section, 30)}`);
      lastSection = ch.section;
    }
    const povLabel = ch.pov ? `POV ${sanitize(ch.pov, 10)}` : 'POV ?';
    lines.push(`        第${ch.number}章 ${sanitize(ch.title, 20)} : ${povLabel}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `pnpm vitest run tests/unit/shared/diagram-builders-timeline.test.ts`
Expected: PASS（全部）

- [ ] **Step 9: 提交**

```bash
git add src/shared/diagram-builders.ts tests/unit/shared/diagram-builders-timeline.test.ts
git commit -m "feat(timeline): 纯函数解析大纲章节 + 生成 timeline 源码"
```

---

## Task 2: 纯函数——交互字段解析 + sequenceDiagram 源码

**Files:**
- Modify: `src/shared/diagram-builders.ts`（末尾追加）
- Test: `tests/unit/shared/diagram-builders-timeline.test.ts`（追加）

### 步骤

- [ ] **Step 1: 写失败的测试——parseInteractionField**

在 `tests/unit/shared/diagram-builders-timeline.test.ts` 追加：

```typescript
import { parseInteractionField, buildSequenceDiagram } from '../../../src/shared/diagram-builders';

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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run tests/unit/shared/diagram-builders-timeline.test.ts`
Expected: FAIL，`parseInteractionField is not a function`

- [ ] **Step 3: 实现 parseInteractionField**

在 `src/shared/diagram-builders.ts` 末尾追加：

```typescript
/** 单条角色交互。 */
export interface CharacterInteraction {
  from: string;
  to: string;
  /** 交互类型（冲突/合作/对话/试探/对决/善意/背叛/重逢/离别，或其他自定义词） */
  type: string;
  action: string;
}

/**
 * 解析大纲「角色交互」字段为结构化交互列表。
 * 格式：`主动方→被动方[类型]：动作`，多条用 ` · ` 分隔。
 * 格式错的条目跳过，不抛异常。
 */
export function parseInteractionField(field: string): CharacterInteraction[] {
  if (!field || field.trim() === '（无）' || !field.trim()) return [];

  const items = field.split(/\s*·\s*/);
  const result: CharacterInteraction[] = [];
  // 正则：主动方→被动方[类型]：动作；容忍全角/半角箭头与冒号
  const re = /^(.+?)→(.+?)\[(.+?)\][：:]\s*(.+)$/;

  for (const item of items) {
    const m = item.trim().match(re);
    if (m) {
      result.push({
        from: m[1].trim(),
        to: m[2].trim(),
        type: m[3].trim(),
        action: m[4].trim(),
      });
    }
  }

  return result;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run tests/unit/shared/diagram-builders-timeline.test.ts`
Expected: parseInteractionField 相关测试 PASS

- [ ] **Step 5: 写失败的测试——buildSequenceDiagram**

在 `tests/unit/shared/diagram-builders-timeline.test.ts` 追加：

```typescript
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
    const interactions = [
      { from: 'A', to: 'B', type: '对决', action: 'x' },
    ];
    const sd = buildSequenceDiagram(interactions)!;
    expect(sd).toContain('Note over A,B: 对决');
  });
});
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `pnpm vitest run tests/unit/shared/diagram-builders-timeline.test.ts`
Expected: FAIL，`buildSequenceDiagram is not a function`

- [ ] **Step 7: 实现 buildSequenceDiagram**

在 `src/shared/diagram-builders.ts` 末尾追加：

```typescript
/**
 * 从交互列表生成 mermaid sequenceDiagram 源码。
 * participant 去重；每条交互生成箭头 + Note over 标注类型。
 * 返回 null 表示无交互数据。
 */
export function buildSequenceDiagram(interactions: CharacterInteraction[]): string | null {
  if (!interactions || interactions.length === 0) return null;

  // participant 去重，保持首次出现顺序
  const seen = new Set<string>();
  const participants: string[] = [];
  for (const it of interactions) {
    for (const name of [it.from, it.to]) {
      if (!seen.has(name)) {
        seen.add(name);
        participants.push(name);
      }
    }
  }

  const lines: string[] = ['sequenceDiagram'];
  for (const p of participants) {
    lines.push(`    participant ${sanitize(p, 20)}`);
  }

  for (const it of interactions) {
    lines.push(`    ${sanitize(it.from, 20)}->>${sanitize(it.to, 20)}: ${sanitize(it.action, 30)}`);
    lines.push(`    Note over ${sanitize(it.from, 20)},${sanitize(it.to, 20)}: ${sanitize(it.type, 10)}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `pnpm vitest run tests/unit/shared/diagram-builders-timeline.test.ts`
Expected: PASS（全部）

- [ ] **Step 9: 提交**

```bash
git add src/shared/diagram-builders.ts tests/unit/shared/diagram-builders-timeline.test.ts
git commit -m "feat(timeline): 纯函数解析交互字段 + 生成 sequenceDiagram 源码"
```

---

## Task 3: 路由——GET timeline + PUT files 写回

**Files:**
- Modify: `src/api/routes/projects.ts`（加 PUT 端点）
- Create: `src/api/routes/timeline.ts`
- Modify: `src/api/index.ts`（注册 timeline 路由）
- Test: `tests/unit/api/timeline.test.ts`

### 步骤

- [ ] **Step 1: 在 projects.ts 加 PUT 写文件端点**

读 `src/api/routes/projects.ts` 的 `GET /:id/files` 端点（约 290 行），在其后追加 PUT 端点。

先读该端点确认上下文：

Run (确认 GET /:id/files 端点位置): `pnpm exec grep -n "files" src/api/routes/projects.ts`

在 `GET /:id/files` 端点之后，`GET /:id/files/list` 之前，追加：

```typescript
// Write file content to project (.novel 目录下)
projectsRouter.put('/:id/files', async (c) => {
  const projectId = c.req.param('id');
  const body = await c.req.json();
  const filePath = body.path as string;
  const content = body.content as string;
  if (!filePath || typeof content !== 'string') {
    return c.json({ error: 'path and content are required' }, 400);
  }
  // 防路径穿越：只允许写 .novel/ 下的文件
  if (filePath.includes('..')) {
    return c.json({ error: 'invalid path' }, 400);
  }
  const novelDir = await resolveNovelDir(projectId);
  const fullPath = path.join(novelDir, filePath);
  // 二次校验：解析后路径必须在 .novel/ 内
  const rel = path.relative(novelDir, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return c.json({ error: 'invalid path' }, 400);
  }
  try {
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: 'write failed' }, 500);
  }
});
```

- [ ] **Step 3: 创建 timeline 路由**

创建 `src/api/routes/timeline.ts`：

```typescript
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveNovelDir } from '../../shared/project-dir';
import { parseOutlineChapters, buildStoryTimeline, type OutlineChapter } from '../../shared/diagram-builders';

const timelineRouter = new Hono();

/**
 * 返回 timeline 源码 + 各章交互字段原文。
 * sequenceDiagram 源码由前端按需生成（便于修正后即时重渲染）。
 */
timelineRouter.get('/:id/timeline', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  let outline = '';
  try {
    outline = await readFile(path.join(novelDir, 'outline-detailed.md'), 'utf-8');
  } catch {
    return c.json({ timeline: null, chapters: [] });
  }

  const chapters = parseOutlineChapters(outline);
  const timeline = buildStoryTimeline(chapters);

  // 提取每章的「角色交互」字段原文（用于前端生成 sequenceDiagram）
  const chapterInteractions = chapters.map((ch) => {
    const block = extractChapterInteractionField(outline, ch.number);
    return { number: ch.number, title: ch.title, interaction: block };
  });

  return c.json({ timeline, chapters: chapterInteractions });
});

/** 从大纲全文提取第 N 章的「角色交互」字段值，无则返回空串。 */
function extractChapterInteractionField(outline: string, chapter: number): string {
  const lines = outline.split('\n');
  const anchorRe = /^####\s+第([\d]+)(?:-[\d]+)?章/;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(anchorRe);
    if (m && parseInt(m[1], 10) === chapter) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return '';
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^#{3,4}\s/.test(lines[j])) break;
    const m = lines[j].match(/^\|\s*角色交互\s*\|\s*(.+?)\s*\|/);
    if (m) return m[1].trim();
  }
  return '';
}

export default timelineRouter;
```

- [ ] **Step 4: 注册 timeline 路由**

读 `src/api/index.ts` 找路由注册处：

Run: `pnpm exec grep -n "import.*routes\|app.route" src/api/index.ts`

在 `src/api/index.ts` 的 import 区追加：
```typescript
import timelineRouter from './routes/timeline';
```
在路由注册区追加（与其他 `app.route` 一起）。

**确认前缀**：timeline 路由用 `/:id/timeline`，需挂在 `/api/projects` 下 → 最终路径 `/api/projects/:id/timeline`。注册语句：
```typescript
app.route('/api/projects', timelineRouter);
```
核对与其他 projects 子路由（同样挂在 `/api/projects` 下的 projectsRouter）不冲突——projectsRouter 用 `/` 子路径，timelineRouter 用 `/:id/timeline`，不冲突。

- [ ] **Step 5: 类型检查 + 现有测试不回归**

Run: `pnpm tsc --noEmit`
Expected: 无错误

Run: `pnpm vitest run`
Expected: 全部 PASS（新文件无有效测试，不回归即可）

- [ ] **Step 6: 提交**

```bash
git add src/api/routes/timeline.ts src/api/routes/projects.ts src/api/index.ts
git commit -m "feat(timeline): GET timeline 路由 + PUT files 通用写文件端点"
```

---

## Task 4: PUT interaction（修正单章交互）

**Files:**
- Modify: `src/api/routes/timeline.ts`（加 PUT 端点）

### 步骤

- [ ] **Step 1: 加 PUT /:id/interaction 端点**

在 `src/api/routes/timeline.ts` 追加：

```typescript
import { writeFile } from 'node:fs/promises';

/**
 * 修正单章「角色交互」字段，写回大纲 md。
 * - 该章表格已有「角色交互」行 → 替换该行内容
 * - 无该行 → 在「出场角色」行后插入新行（若无出场角色行则追加到表格末尾）
 */
timelineRouter.put('/:id/interaction', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  const body = await c.req.json();
  const { chapter, interaction } = body as { chapter: number; interaction: string };
  if (typeof chapter !== 'number' || typeof interaction !== 'string') {
    return c.json({ error: 'chapter and interaction are required' }, 400);
  }

  const outlinePath = path.join(novelDir, 'outline-detailed.md');
  let outline: string;
  try {
    outline = await readFile(outlinePath, 'utf-8');
  } catch {
    return c.json({ error: 'outline-detailed.md not found' }, 404);
  }

  const updated = replaceChapterInteraction(outline, chapter, interaction);
  if (updated === null) {
    return c.json({ error: `第${chapter}章未在大纲中找到` }, 404);
  }

  await writeFile(outlinePath, updated, 'utf-8');
  return c.json({ ok: true });
});

/**
 * 替换或插入第 N 章的「角色交互」行。
 * 返回更新后的全文；章号不存在返回 null。
 */
export function replaceChapterInteraction(
  outline: string,
  chapter: number,
  interaction: string,
): string | null {
  const lines = outline.split('\n');
  const anchorRe = /^####\s+第([\d]+)(?:-[\d]+)?章/;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(anchorRe);
    if (m && parseInt(m[1], 10) === chapter) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) return null;

  // 找该章表格范围（到下一个 #### 或 ###）
  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^#{3,4}\s/.test(lines[j])) {
      endIdx = j;
      break;
    }
  }

  // 在范围内找已有「角色交互」行
  let interactionLineIdx = -1;
  let castLineIdx = -1;
  let lastTableRowIdx = -1;
  for (let j = startIdx + 1; j < endIdx; j++) {
    if (/^\|/.test(lines[j])) {
      lastTableRowIdx = j;
      if (/^\|\s*角色交互\s*\|/.test(lines[j])) interactionLineIdx = j;
      if (/^\|\s*出场角色\s*\|/.test(lines[j])) castLineIdx = j;
    }
  }

  const newLine = `| 角色交互 | ${interaction} |`;

  if (interactionLineIdx >= 0) {
    // 替换已有行
    lines[interactionLineIdx] = newLine;
  } else if (castLineIdx >= 0) {
    // 在出场角色行后插入
    lines.splice(castLineIdx + 1, 0, newLine);
  } else if (lastTableRowIdx >= 0) {
    // 追加到表格末尾
    lines.splice(lastTableRowIdx + 1, 0, newLine);
  } else {
    // 无表格——返回 null 表示无法插入（理论上不会发生）
    return null;
  }

  return lines.join('\n');
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 手动验证（e2e 在 Task 6 覆盖）**

纯函数 `replaceChapterInteraction` 加单测——创建 `tests/unit/api/timeline.test.ts`：

```typescript
import { replaceChapterInteraction } from '../../../src/api/routes/timeline';

describe('replaceChapterInteraction', () => {
  const OUTLINE = `#### 第1章：测试
| 项目 | 内容 |
|------|------|
| POV | 武松 |
| 出场角色 | 武松、何九叔 |
| 核心事件 | test |`;

  it('已有角色交互行时替换', () => {
    const withInteraction = OUTLINE + '\n| 角色交互 | 旧的 |';
    const result = replaceChapterInteraction(withInteraction, 1, '新的交互');
    expect(result).toContain('新的交互');
    expect(result).not.toContain('旧的');
  });

  it('无角色交互行时在出场角色行后插入', () => {
    const result = replaceChapterInteraction(OUTLINE, 1, 'A→B[冲突]：x');
    expect(result).toContain('| 角色交互 | A→B[冲突]：x |');
    // 插入在出场角色行之后
    const lines = result!.split('\n');
    const castIdx = lines.findIndex((l) => l.includes('出场角色'));
    const interactionIdx = lines.findIndex((l) => l.includes('角色交互'));
    expect(interactionIdx).toBe(castIdx + 1);
  });

  it('章号不存在返回 null', () => {
    expect(replaceChapterInteraction(OUTLINE, 99, 'x')).toBeNull();
  });
});
```

Run: `pnpm vitest run tests/unit/api/timeline.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/api/routes/timeline.ts tests/unit/api/timeline.test.ts
git commit -m "feat(timeline): PUT interaction 修正单章交互字段"
```

---

## Task 5: AI 批量预填（timeline-filler）

**Files:**
- Create: `src/agent/timeline-filler.ts`
- Test: `tests/unit/agent/timeline-filler.test.ts`

### 步骤

- [ ] **Step 1: 写失败的测试**

创建 `tests/unit/agent/timeline-filler.test.ts`：

```typescript
import { describe, it, expect } from 'vitest';
import { buildFillPrompt, type FillChapterInput } from '../../../src/agent/timeline-filler';

describe('buildFillPrompt', () => {
  it('生成含 POV / 核心事件 / 出场角色的 prompt', () => {
    const input: FillChapterInput = {
      number: 3,
      title: '关卡',
      pov: '武松',
      coreEvent: '在客栈因无通行凭证被盘问',
      cast: ['武松', '何九叔'],
    };
    const prompt = buildFillPrompt(input);
    expect(prompt).toContain('武松');
    expect(prompt).toContain('何九叔');
    expect(prompt).toContain('通行凭证');
    expect(prompt).toContain('主动方→被动方[类型]：动作');
    // 列出 9 种类型
    expect(prompt).toContain('冲突');
    expect(prompt).toContain('重逢');
    expect(prompt).toContain('离别');
  });

  it('独角戏章节（cast 仅 1 人）提示返回（无）', () => {
    const input: FillChapterInput = {
      number: 1,
      title: '独角戏',
      pov: '武松',
      coreEvent: '备战',
      cast: ['武松'],
    };
    const prompt = buildFillPrompt(input);
    expect(prompt).toContain('（无）');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `pnpm vitest run tests/unit/agent/timeline-filler.test.ts`
Expected: FAIL，`buildFillPrompt is not a function`

- [ ] **Step 3: 实现 buildFillPrompt + 类型**

创建 `src/agent/timeline-filler.ts`：

```typescript
/** AI 预填的单章输入。 */
export interface FillChapterInput {
  number: number;
  title: string;
  pov: string;
  coreEvent: string;
  cast: string[];
}

const INTERACTION_TYPES = ['冲突', '合作', '对话', '试探', '对决', '善意', '背叛', '重逢', '离别'];

/**
 * 为单章构造 AI prompt，要求输出符合「角色交互」字段格式的文本。
 * 独角戏章节（cast 仅 1 人）直接返回（无），不调 AI。
 */
export function buildFillPrompt(input: FillChapterInput): string {
  const isSolo = input.cast.length <= 1;

  return `你是故事分析助手。请为以下章节生成「角色交互」字段。

## 章节信息
- 章号：第${input.number}章 ${input.title}
- POV：${input.pov}
- 核心事件：${input.coreEvent}
- 出场角色：${input.cast.join('、')}

## 输出格式
${isSolo
  ? '本章是独角戏（仅 1 个出场角色），无角色间交互。请直接输出：\n（无）'
  : `每条交互格式：主动方→被动方[类型]：动作描述
多条交互用「 · 」（中点 + 两侧空格）分隔。
类型必须取自以下枚举：${INTERACTION_TYPES.join(' / ')}

示例：
武松→何九叔[冲突]：被盘问 · 何九叔→武松[善意]：出手相助

请只输出角色交互字段内容，不要其他文字。`}`;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `pnpm vitest run tests/unit/agent/timeline-filler.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败的测试——parseAiResponse**

在 `tests/unit/agent/timeline-filler.test.ts` 追加：

```typescript
import { parseAiResponse } from '../../../src/agent/timeline-filler';

describe('parseAiResponse', () => {
  it('提取符合格式的交互行（去除 AI 啰嗦的前后文）', () => {
    const aiOutput = '好的，分析如下：\n武松→何九叔[冲突]：被盘问 · 何九叔→武松[善意]：放行\n以上是交互。';
    const parsed = parseAiResponse(aiOutput);
    expect(parsed).toBe('武松→何九叔[冲突]：被盘问 · 何九叔→武松[善意]：放行');
  });

  it('AI 返回（无）时透传', () => {
    expect(parseAiResponse('（无）')).toBe('（无）');
  });

  it('AI 返回纯文本无格式时返回空串', () => {
    expect(parseAiResponse('本章没有交互')).toBe('');
  });
});
```

- [ ] **Step 6: 运行测试，确认失败**

Run: `pnpm vitest run tests/unit/agent/timeline-filler.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现 parseAiResponse**

在 `src/agent/timeline-filler.ts` 追加：

```typescript
/**
 * 从 AI 输出中提取有效的角色交互字段。
 * 找到包含 `→` 和 `[...]` 的行；若无则检查是否为「（无）」；否则返回空串。
 */
export function parseAiResponse(aiOutput: string): string {
  const trimmed = aiOutput.trim();
  if (trimmed === '（无）') return '（无）';

  // 找包含交互格式（→...[...]：）的行
  const lines = trimmed.split('\n');
  for (const line of lines) {
    const clean = line.trim();
    if (clean.includes('→') && /\[.+?\]/.test(clean)) {
      return clean;
    }
  }
  return '';
}
```

- [ ] **Step 8: 运行测试，确认通过**

Run: `pnpm vitest run tests/unit/agent/timeline-filler.test.ts`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add src/agent/timeline-filler.ts tests/unit/agent/timeline-filler.test.ts
git commit -m "feat(timeline): AI 批量预填的 prompt 构造 + 响应解析"
```

---

## Task 6: 批量预填 SSE 端点

**Files:**
- Modify: `src/api/routes/timeline.ts`（加 POST fill 端点）

### 步骤

- [ ] **Step 1: 加 POST /:id/fill SSE 端点**

在 `src/api/routes/timeline.ts` 顶部 import 追加：

```typescript
import { stream } from 'hono/streaming';
import { composePrompt } from '../../agent/prompt-composer';
import { getAgentDef } from '../../agent/registry';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler } from '../../agent/stream-parser';
import { sanitizeStderr } from '../../shared/sanitize';
import { buildFillPrompt, parseAiResponse, type FillChapterInput } from '../../agent/timeline-filler';
```

> **确认**：`sanitizeStderr` 路径需核对（grep 确认）。`composePrompt` 的签名需核对是否支持纯文本 prompt 直接调 AI——若不支持，需走 launchAgent + stream 解析模式。先读 prompt-composer 确认调用方式：

Run: `pnpm exec grep -n "export function composePrompt\|export async function" src/agent/prompt-composer.ts | head -5`

在 `src/api/routes/timeline.ts` 追加 POST 端点：

```typescript
/**
 * SSE：批量预填所有缺「角色交互」字段的章节。
 * 逐章调 AI，每章完成后推送进度；已有字段的跳过。
 */
timelineRouter.post('/:id/fill', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  const agentId = (c.req.query('agent') || 'claude') as string;
  const def = getAgentDef(agentId);
  if (!def) return c.json({ error: `agent not found: ${agentId}` }, 400);

  let outline: string;
  try {
    outline = await readFile(path.join(novelDir, 'outline-detailed.md'), 'utf-8');
  } catch {
    return c.json({ error: 'outline-detailed.md not found' }, 404);
  }

  const chapters = parseOutlineChapters(outline);
  // 过滤出无「角色交互」字段的章节
  const toFill: OutlineChapter[] = [];
  for (const ch of chapters) {
    const existing = extractChapterInteractionField(outline, ch.number);
    if (!existing) toFill.push(ch);
  }

  return stream(c, async (streamWriter) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const filled: number[] = [];
    const skipped: number[] = [];
    const failed: Array<{ chapter: number; message: string }> = [];

    // 推送初始计划
    streamWriter.write(`data: ${JSON.stringify({ type: 'plan', total: toFill.length, skipped: chapters.length - toFill.length })}\n\n`);

    for (const ch of toFill) {
      try {
        const coreEvent = extractCoreEvent(outline, ch.number);
        const input: FillChapterInput = {
          number: ch.number,
          title: ch.title,
          pov: ch.pov,
          coreEvent,
          cast: ch.cast,
        };
        const prompt = buildFillPrompt(input);

        // 调 AI（同步等响应）
        const aiResponse = await callAgentOnce(def, prompt, novelDir);
        const interaction = parseAiResponse(aiResponse);

        if (interaction) {
          outline = replaceChapterInteraction(outline, ch.number, interaction) || outline;
          filled.push(ch.number);
          streamWriter.write(`data: ${JSON.stringify({ type: 'progress', chapter: ch.number, filled: filled.length, total: toFill.length })}\n\n`);
        } else {
          failed.push({ chapter: ch.number, message: 'AI 输出无法解析' });
        }
      } catch (e: any) {
        failed.push({ chapter: ch.number, message: e?.message || 'unknown error' });
      }
    }

    // 一次性写回大纲
    if (filled.length > 0) {
      try {
        await writeFile(path.join(novelDir, 'outline-detailed.md'), outline, 'utf-8');
      } catch (e: any) {
        failed.push({ chapter: -1, message: `写回大纲失败: ${e?.message}` });
      }
    }

    streamWriter.write(`data: ${JSON.stringify({ type: 'done', filled, skipped: skipped as number[], failed })}\n\n`);
  });
});

/** 提取第 N 章的「核心事件」字段值。 */
function extractCoreEvent(outline: string, chapter: number): string {
  const lines = outline.split('\n');
  const anchorRe = /^####\s+第([\d]+)(?:-[\d]+)?章/;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(anchorRe);
    if (m && parseInt(m[1], 10) === chapter) { startIdx = i; break; }
  }
  if (startIdx === -1) return '';
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (/^#{3,4}\s/.test(lines[j])) break;
    const m = lines[j].match(/^\|\s*核心事件\s*\|\s*(.+?)\s*\|/);
    if (m) return m[1].trim();
  }
  return '';
}

/** 单次调 AI 取文本响应（同步等完）。复用 launchAgent + stream 解析。 */
async function callAgentOnce(def: ReturnType<typeof getAgentDef>, prompt: string, cwd: string): Promise<string> {
  // 复用 runs.ts 的 launch + collect 模式
  // 实现细节需对齐现有 launchAgent 签名——此处先实现，运行时校对
  const { child } = launchAgent(def!, prompt, cwd, [], undefined);
  return new Promise((resolve, reject) => {
    let output = '';
    const handler = createClaudeStreamHandler(
      (event) => { if (event.type === 'text') output += event.text; },
      () => {},
    );
    child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
    child.stderr?.on('data', () => {});
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`agent exited ${code}`));
    });
  });
}
```

- [ ] **Step 2: 核对依赖签名**

Run: `pnpm exec grep -n "export function launchAgent\|export function createClaudeStreamHandler" src/agent/launch.ts src/agent/stream-parser.ts`

根据实际签名调整 `callAgentOnce` 中的参数。关键核对点：
- `launchAgent(def, prompt, cwd, extraDirs, model)` 的参数顺序与类型
- `createClaudeStreamHandler(emit, onComplete)` 的回调签名
- StreamEvent 的 `text` 字段是否为 `{ type: 'text', text: string }`

> **ACPs**：本端点仅支持 CLI agent（claude 等）。ACP agent（omp）需另走 `runAcpTurn`——为简化，本 Task 先只支持 CLI agent，UI 层用 claude。ACP 支持作为后续增强。

- [ ] **Step 3: 类型检查 + 现有测试不回归**

Run: `pnpm tsc --noEmit`
Expected: 无错误（有则按实际签名修正）

Run: `pnpm vitest run`
Expected: 全部 PASS

- [ ] **Step 4: 提交**

```bash
git add src/api/routes/timeline.ts
git commit -m "feat(timeline): SSE 批量预填角色交互字段"
```

---

## Task 7: 前端——StoryArcView 视图

**Files:**
- Create: `src/web/components/views/StoryArcView.tsx`
- Modify: `src/shared/stages.ts`（加视图入口）
- Modify: `src/web/pages/ProjectPage.tsx`（ViewRouter 加分支）

### 步骤

- [ ] **Step 1: 在 ALL_VIEWS 加入口**

在 `src/shared/stages.ts` 的 `ALL_VIEWS` 数组，在 `foreshadow` 后追加：

```typescript
export const ALL_VIEWS = [
  { id: 'dashboard', label: '总览' },
  ...STAGES.map((s) => ({ id: s.viewId, label: s.label })),
  { id: 'foreshadow', label: '伏笔' },
  { id: 'story-arc', label: '故事脉络' },
  { id: 'wuxia', label: '武侠' },
];
```

- [ ] **Step 2: 创建 StoryArcView**

创建 `src/web/components/views/StoryArcView.tsx`：

```typescript
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { CollapsibleDiagram } from '../MermaidDiagram';
import { parseInteractionField, buildSequenceDiagram } from '../../../shared/diagram-builders';

const container = css`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const toolbar = css`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
`;

const fillBtn = css`
  padding: 0.4rem 0.9rem;
  background: var(--haze-color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const progressText = css`
  font-size: 0.82rem;
  color: var(--haze-color-text-secondary);
`;

const chapterList = css`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const chapterItem = css`
  border: 1px solid var(--haze-color-border);
  border-radius: 6px;
  overflow: hidden;
`;

const chapterHeader = css`
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 0.875rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  &:hover { background: var(--haze-color-bg-secondary); }
`;

const chapterBody = css`
  padding: 0.75rem;
  border-top: 1px solid var(--haze-color-border);
`;

const editBtn = css`
  margin-top: 0.5rem;
  padding: 0.25rem 0.6rem;
  font-size: 0.78rem;
  background: var(--haze-color-bg-secondary);
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  cursor: pointer;
`;

const editBox = css`
  width: 100%;
  min-height: 60px;
  margin-top: 0.5rem;
  padding: 0.4rem;
  font-family: monospace;
  font-size: 0.8rem;
  border: 1px solid var(--haze-color-border);
  border-radius: 4px;
  resize: vertical;
`;

const emptyHint = css`
  font-size: 0.82rem;
  color: var(--haze-color-text-secondary);
  padding: 0.5rem 0;
`;

interface ChapterData {
  number: number;
  title: string;
  interaction: string;
}

interface TimelineResponse {
  timeline: string | null;
  chapters: ChapterData[];
}

interface Props {
  projectId: string;
}

export default function StoryArcView({ projectId }: Props) {
  const queryClient = useQueryClient();
  const [expandedCh, setExpandedCh] = useState<number | null>(null);
  const [editingCh, setEditingCh] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [filling, setFilling] = useState(false);
  const [fillProgress, setFillProgress] = useState('');

  const { data, isLoading } = useQuery<TimelineResponse>({
    queryKey: ['timeline', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/timeline`);
      if (!res.ok) return { timeline: null, chapters: [] };
      return res.json();
    },
  });

  async function handleFill() {
    setFilling(true);
    setFillProgress('启动中...');
    try {
      const res = await fetch(`/api/projects/${projectId}/fill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.body) throw new Error('no stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === 'plan') setFillProgress(`待填 ${evt.total} 章，跳过 ${evt.skipped} 章`);
            else if (evt.type === 'progress') setFillProgress(`已填 ${evt.filled}/${evt.total}（当前第${evt.chapter}章）`);
            else if (evt.type === 'done') {
              setFillProgress(`完成：填 ${evt.filled.length} 章，失败 ${evt.failed.length} 章`);
              queryClient.invalidateQueries({ queryKey: ['timeline', projectId] });
            }
          }
        }
      }
    } catch (e: any) {
      setFillProgress(`失败：${e?.message}`);
    } finally {
      setFilling(false);
    }
  }

  async function handleSaveEdit(chapter: number) {
    const res = await fetch(`/api/projects/${projectId}/interaction`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapter, interaction: editText }),
    });
    if (res.ok) {
      setEditingCh(null);
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] });
    }
  }

  if (isLoading) return <div>加载中...</div>;
  if (!data) return <div>无法加载故事脉络。</div>;

  return (
    <div className={container}>
      <h3>故事脉络</h3>
      <div className={toolbar}>
        <button className={fillBtn} onClick={handleFill} disabled={filling}>
          {filling ? '生成中...' : '✨ AI 批量生成交互'}
        </button>
        {fillProgress && <span className={progressText}>{fillProgress}</span>}
      </div>
      <CollapsibleDiagram chart={data.timeline} title="全书脉络时间线" />
      <div className={chapterList}>
        {data.chapters.map((ch) => {
          const expanded = expandedCh === ch.number;
          const interactions = parseInteractionField(ch.interaction);
          const seqDiagram = buildSequenceDiagram(interactions);
          return (
            <div key={ch.number} className={chapterItem}>
              <div className={chapterHeader} onClick={() => setExpandedCh(expanded ? null : ch.number)}>
                {expanded ? '▾' : '▸'} 第{ch.number}章 {ch.title}
              </div>
              {expanded && (
                <div className={chapterBody}>
                  {seqDiagram ? (
                    <>
                      <CollapsibleDiagram chart={seqDiagram} title="角色交互" />
                      {editingCh === ch.number ? (
                        <>
                          <textarea
                            className={editBox}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                          />
                          <div>
                            <button className={editBtn} onClick={() => handleSaveEdit(ch.number)}>保存</button>
                            <button className={editBtn} onClick={() => setEditingCh(null)}>取消</button>
                          </div>
                        </>
                      ) : (
                        <button className={editBtn} onClick={() => { setEditingCh(ch.number); setEditText(ch.interaction); }}>
                          ✏️ 编辑
                        </button>
                      )}
                    </>
                  ) : (
                    <div>
                      <div className={emptyHint}>本章无角色交互数据。点击「AI 批量生成交互」或手工编辑。</div>
                      {editingCh === ch.number ? (
                        <>
                          <textarea
                            className={editBox}
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            placeholder="主动方→被动方[类型]：动作 · ..."
                          />
                          <div>
                            <button className={editBtn} onClick={() => handleSaveEdit(ch.number)}>保存</button>
                            <button className={editBtn} onClick={() => setEditingCh(null)}>取消</button>
                          </div>
                        </>
                      ) : (
                        <button className={editBtn} onClick={() => { setEditingCh(ch.number); setEditText(ch.interaction); }}>
                          ✏️ 手工编辑
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 在 ViewRouter 加分支**

在 `src/web/pages/ProjectPage.tsx` 的 import 区追加：

```typescript
import StoryArcView from '@/web/components/views/StoryArcView';
```

在 `ViewRouter` 函数体内，`foreshadow` 分支后追加：

```typescript
  if (activeView === 'story-arc') return <StoryArcView projectId={projectId} />;
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `pnpm tsc --noEmit`
Expected: 无错误

Run: `pnpm vite build`
Expected: 构建成功

- [ ] **Step 5: 提交**

```bash
git add src/web/components/views/StoryArcView.tsx src/shared/stages.ts src/web/pages/ProjectPage.tsx
git commit -m "feat(timeline): 故事脉络视图（timeline + 章节交互 + 编辑）"
```

---

## Task 8: 全量验证

**Files:** 无（验证任务）

### 步骤

- [ ] **Step 1: 全量类型检查**

Run: `pnpm tsc --noEmit`
Expected: 无错误

- [ ] **Step 2: 全量测试**

Run: `pnpm vitest run`
Expected: 全部 PASS

- [ ] **Step 3: 构建**

Run: `pnpm vite build && npm run build:server`
Expected: 成功

- [ ] **Step 4: e2e 手动验证**

启动服务，在浏览器打开示例项目，点「故事脉络」tab：
1. timeline 主图渲染（卷为 section，章为节点）
2. 展开某章，无交互字段时显示提示
3. 点击「AI 批量生成交互」，观察 SSE 进度
4. 生成后章节展开显示 sequenceDiagram
5. 编辑某章交互，保存后刷新

- [ ] **Step 5: 文档更新（可选）**

若 `docs/工具使用指南.md` 有视图清单，追加「故事脉络」视图说明。

- [ ] **Step 6: 最终提交（如有文档改动）**

```bash
git add docs/工具使用指南.md
git commit -m "docs: 故事脉络视图使用说明"
```

---

## 自检清单（实施前核对）

- [ ] Task 1-2 的纯函数（`parseOutlineChapters` / `buildStoryTimeline` / `parseInteractionField` / `buildSequenceDiagram`）已加入 `diagram-builders.ts`，与现有 builder 风格一致
- [ ] Task 3 的 GET timeline 路由返回前端所需全部数据（timeline 源码 + 各章交互字段原文）
- [ ] Task 4 的 PUT interaction 用 `replaceChapterInteraction` 纯函数，已单测
- [ ] Task 5 的 `buildFillPrompt` / `parseAiResponse` 纯函数已单测
- [ ] Task 6 的 SSE 端点 `callAgentOnce` 需核对 `launchAgent` / `createClaudeStreamHandler` 实际签名
- [ ] Task 7 视图正确消费 GET timeline 响应、SSE 事件、PUT interaction
- [ ] stages.ts 的 `ALL_VIEWS` 加了 `story-arc` 入口
- [ ] ProjectPage 的 ViewRouter 加了分支
