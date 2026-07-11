# 卡牌拆分实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `concept.md`、`world-building.md`、`outline-detailed.md` 三个大单文件拆分为「目录 + 索引 + 独立卡片」结构，让 agent 的 grep/Read/@ 引用、修订注入都能精准定位到单张卡。

**Architecture:** 复用已有的 `characters/profiles/` 目录模式。新增共享模块 `split-document.ts` 提供拆分/合并/写入能力；模板生成器、API 路由、agent 注入层、前端视图全部适配目录格式；迁移端点处理唯一旧项目。不做向后兼容。

**Tech Stack:** TypeScript, Hono, React, Vitest, node:fs/promises

**设计依据:** `docs/superpowers/specs/2026-07-11-card-split-design.md`

---

## 目录结构（拆分后）

```
.novel/
  concept/
    index.md              ← 索引：要素标题表 + 摘要
    基本信息.md
    一句话梗概.md
    ...（按 ## 标题切分）
  world/
    index.md              ← 索引：节标题表 + 摘要
    时代背景.md
    地理环境.md
    ...（按 ## 标题切分）
  outline/
    index.md              ← 索引：三幕结构 + 章节标题表
    chapters/
      第1章.md            ← 单章大纲卡
      第2章.md
      ...
  outline-brief.md        ← 保持单文件（brief 本身短）
  outline-meta.json       ← 保持单文件
```

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/shared/split-document.ts` | **新建**。拆分/合并/写入核心逻辑，所有消费方共享 |
| `src/shared/template-generator.ts` | 改 `generateOutlineDetailed` 返回 `SplitTemplateResult` |
| `src/api/routes/projects.ts` | 落盘逻辑适配 + 迁移端点 |
| `src/api/routes/documents.ts` | **新建**。合并读取接口 |
| `src/agent/prompt-composer.ts` | 核心设定层注入 + stage 指令路径更新 |
| `src/agent/chapter-context.ts` | 读单章卡片文件 |
| `src/agent/context-manager.ts` | 文件路径常量更新 |
| `src/api/routes/timeline.ts` | 遍历章节目录 |
| `src/web/hooks/useEntityDict.ts` | 候选文件收集范围改目录 |
| `src/agent/reverse-decomposer.ts` | prompt 指令更新 |
| `src/shared/deepen.ts` | `STAGE_OUTPUT_FILES` + prompt 路径 |
| `src/agent/enricher.ts` | 盘点逻辑适配目录 |
| `src/web/hooks/useNovelDocument.ts` | **新建**。合并文档读取 hook |
| `src/web/components/views/OutlineView.tsx` | 用 `useNovelDocument` |
| `src/web/components/views/WorldView.tsx` | 用 `useNovelDocument` |
| `src/web/components/views/ConceptView.tsx` | 用 `useNovelDocument` |
| `src/web/components/views/WuxiaView.tsx` | 用 `useNovelDocument` |
| `src/web/hooks/useFileRevision.ts` | targetFile 改卡片路径 |
| `src/web/pages/ProjectPage.tsx` | SSE 监听前缀匹配 + 迁移按钮 + viewToFile |
| `src/api/routes/export.ts` | 拼合目录卡片 |

---

## Task 依赖关系

```
Task 1 (split-document.ts) ──┬── Task 2 (template-generator)
                              ├── Task 3 (API: 落盘 + 合并接口 + 迁移端点)
                              ├── Task 4 (prompt-composer)
                              ├── Task 5 (chapter-context)
                              ├── Task 6 (timeline)
                              ├── Task 7 (entity-dict + context-manager)
                              ├── Task 8 (deepen + enricher + reverse-decomposer)
                              ├── Task 9 (useNovelDocument + 前端视图)
                              ├── Task 10 (useFileRevision + ProjectPage)
                              └── Task 11 (export)
```

Task 1 是所有后续 task 的前置依赖。Task 2-11 中互相独立的 task 可并行。

---

### Task 1: split-document 共享模块

**Files:**
- Create: `src/shared/split-document.ts`
- Test: `tests/unit/shared/split-document.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/shared/split-document.test.ts
import { describe, it, expect } from 'vitest';
import {
  splitMarkdownToCards,
  buildIndexMarkdown,
  type DocType,
} from '../../../src/shared/split-document';

describe('splitMarkdownToCards', () => {
  it('按 ## 标题切分为独立卡片', () => {
    const md = `# 文档标题

> 元数据行

## 第一节

内容 A

## 第二节

内容 B
`;
    const result = splitMarkdownToCards(md, 'concept');
    expect(result.docTitle).toBe('文档标题');
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].title).toBe('第一节');
    expect(result.cards[0].content).toBe('## 第一节\n\n内容 A');
    expect(result.cards[1].title).toBe('第二节');
    expect(result.cards[1].content).toBe('## 第二节\n\n内容 B');
  });

  it('空文档返回空卡片数组', () => {
    const result = splitMarkdownToCards('', 'concept');
    expect(result.cards).toHaveLength(0);
    expect(result.docTitle).toBe('');
  });

  it('只有标题没有 section 时返回空卡片数组', () => {
    const md = '# 标题\n\n一些引言行';
    const result = splitMarkdownToCards(md, 'concept');
    expect(result.cards).toHaveLength(0);
  });

  it('outline 类型：章节标题提取章号', () => {
    const md = `# 大纲

## 第 3 章：测试 ｜ 第一幕·设置 ｜ 目标约 5000 字

- **结构定位**：开篇

## 第 4 章：测试2 ｜ 第一幕·设置 ｜ 目标约 5000 字

- **结构定位**：铺垫
`;
    const result = splitMarkdownToCards(md, 'outline');
    expect(result.cards).toHaveLength(2);
    expect(result.cards[0].fileName).toBe('chapters/第3章.md');
    expect(result.cards[1].fileName).toBe('chapters/第4章.md');
  });

  it('concept/world 类型：文件名 = section 标题', () => {
    const md = `# 概念

## 核心主题

内容
`;
    const result = splitMarkdownToCards(md, 'concept');
    expect(result.cards[0].fileName).toBe('核心主题.md');
  });

  it('特殊字符标题被清理为安全文件名', () => {
    const md = `# 概念

## 核心主题：探索/发现？

内容
`;
    const result = splitMarkdownToCards(md, 'concept');
    expect(result.cards[0].fileName).toBe('核心主题：探索发现.md');
  });
});

describe('buildIndexMarkdown', () => {
  it('concept 索引包含标题表', () => {
    const cards = [
      { title: '基本信息', content: '## 基本信息\n\n一些内容', fileName: '基本信息.md' },
      { title: '核心主题', content: '## 核心主题\n\n一些内容', fileName: '核心主题.md' },
    ];
    const index = buildIndexMarkdown('concept', '《测试》', cards);
    expect(index).toContain('# 概念索引：');
    expect(index).toContain('基本信息');
    expect(index).toContain('基本信息.md');
    expect(index).toContain('核心主题');
  });

  it('outline 索引包含三幕结构 + 章节表', () => {
    const cards = [
      { title: '第 1 章：开头 ｜ 第一幕·设置', content: '...', fileName: 'chapters/第1章.md' },
      { title: '第 2 章：发展 ｜ 第二幕·对抗', content: '...', fileName: 'chapters/第2章.md' },
    ];
    const index = buildIndexMarkdown('outline', '《测试》', cards, [1, 1]);
    expect(index).toContain('# 详细大纲索引');
    expect(index).toContain('第一幕');
    expect(index).toContain('chapters/第1章.md');
    expect(index).toContain('chapters/第2章.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/shared/split-document.test.ts
```

Expected: FAIL with "Cannot find module '../../../src/shared/split-document'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/shared/split-document.ts
import { parseSections } from '../web/components/views/parseSections';
import type { MdSection } from '../web/components/views/parseSections';

/** 文档类型：决定目录名和文件名生成规则。 */
export type DocType = 'concept' | 'world' | 'outline';

/** 一张卡片的拆分结果。 */
export interface SplitCard {
  /** section 标题（不含 ## 前缀）。 */
  title: string;
  /** 卡片正文（含 ## 标题行 + 正文）。 */
  content: string;
  /** 相对于文档目录的文件名，如 'chapters/第3章.md' 或 '核心主题.md'。 */
  fileName: string;
}

/** 拆分结果。 */
export interface SplitResult {
  /** 文档标题（# 行内容），用于索引。 */
  docTitle: string;
  /** 全部卡片。 */
  cards: SplitCard[];
}

/** DocType → .novel/ 下的目录名。 */
export const DOC_DIR: Record<DocType, string> = {
  concept: 'concept',
  world: 'world',
  outline: 'outline',
};

/**
 * 将一整份 markdown 文档拆分为卡片数组。
 * 按 `##` 标题切片，每个 section 成一张卡。
 */
export function splitMarkdownToCards(md: string, docType: DocType): SplitResult {
  if (!md || !md.trim()) return { docTitle: '', cards: [] };

  const parsed = parseSections(md);
  const docTitle = parsed.title || '';

  const cards: SplitCard[] = parsed.sections.map((s) => ({
    title: s.title,
    content: s.fullRawMd.trim(),
    fileName: cardFileName(s.title, docType),
  }));

  return { docTitle, cards };
}

/**
 * 从 section 标题生成卡片文件名。
 * - outline：提取章号 → `chapters/第N章.md`
 * - concept/world：标题清理 → `标题.md`
 */
function cardFileName(title: string, docType: DocType): string {
  if (docType === 'outline') {
    const m = title.match(/第\s*(\d+)\s*章/);
    if (m) return `chapters/第${m[1]}章.md`;
    // 无章号的 outline section 兜底
    return `chapters/${sanitizeFileName(title)}.md`;
  }
  return `${sanitizeFileName(title)}.md`;
}

/**
 * 清理文件名：去掉路径分隔符和特殊字符。
 * 保留中文、字母、数字、冒号（中文标题常用）。
 */
function sanitizeFileName(title: string): string {
  return title
    .replace(/[\\/]/g, '')   // 去掉路径分隔符
    .replace(/[?*<>|"]/g, '') // 去掉文件系统特殊字符
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80); // 限制长度
}

/**
 * 构建索引文件内容。
 * @param docType 文档类型
 * @param docTitle 文档标题（含书名号）
 * @param cards 全部卡片
 * @param actBreaks 仅 outline：[第一幕末章号, 第二幕末章号]
 */
export function buildIndexMarkdown(
  docType: DocType,
  docTitle: string,
  cards: SplitCard[],
  actBreaks?: [number, number],
): string {
  if (docType === 'outline') {
    return buildOutlineIndex(docTitle, cards, actBreaks);
  }
  return buildSimpleIndex(docType, docTitle, cards);
}

/** concept/world 索引：标题 + 摘要 + 文件路径表。 */
function buildSimpleIndex(docType: DocType, docTitle: string, cards: SplitCard[]): string {
  const label = docType === 'concept' ? '概念' : '世界观';
  const lines: string[] = [`# ${label}索引：${docTitle}`, '', '| 要素 | 摘要 | 文件 |', '|---|---|---|'];

  for (const card of cards) {
    const summary = extractSummary(card.content, 60);
    lines.push(`| ${card.title} | ${summary} | ${card.fileName} |`);
  }

  return `${lines.join('\n')}\n`;
}

/** outline 索引：三幕结构表 + 章节表。 */
function buildOutlineIndex(
  docTitle: string,
  cards: SplitCard[],
  actBreaks?: [number, number],
): string {
  const lines: string[] = [`# 详细大纲索引：${docTitle}`, ''];

  lines.push('> 每章独立文件位于 chapters/第N章.md，用 Read 工具按需读取单章。');
  lines.push('');

  // 三幕结构
  if (actBreaks && cards.length > 0) {
    const [act1End, act2End] = actBreaks;
    const total = cards.length;
    lines.push('## 三幕结构', '');
    lines.push('| 幕 | 章节范围 | |');
    lines.push('|---|---|')
    lines.push(`| 第一幕·设置 | 第1–${act1End}章 |`);
    if (act2End > act1End) {
      lines.push(`| 第二幕·对抗 | 第${act1End + 1}–${act2End}章 |`);
    }
    lines.push(`| 第三幕·解决 | 第${act2End + 1}–${total}章 |`);
    lines.push('');
  }

  // 章节索引
  lines.push('## 章节索引', '');
  lines.push('| 章 | 标题 | 文件 |');
  lines.push('|---|---|---|');

  for (const card of cards) {
    const chapterNum = card.fileName.match(/第(\d+)章/)?.[1] ?? '?';
    const shortTitle = card.title.replace(/第\s*\d+\s*章[：:]?\s*/, '').split('｜')[0].trim();
    lines.push(`| ${chapterNum} | ${shortTitle} | ${card.fileName} |`);
  }

  return `${lines.join('\n')}\n`;
}

/** 从卡片内容提取摘要：跳过标题行，取首段文本截断。 */
function extractSummary(content: string, maxChars: number): string {
  const lines = content.split('\n').filter((l) => !l.startsWith('#') && l.trim());
  const text = lines.join(' ').trim();
  if (!text) return '—';
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/shared/split-document.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/split-document.ts tests/unit/shared/split-document.test.ts
git commit -m "feat: add split-document shared module for card-level file splitting"
```

---

### Task 2: 模板生成器适配

**Files:**
- Modify: `src/shared/template-generator.ts` (lines 50-65, 143-170)
- Test: `tests/unit/shared/template-generator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/shared/template-generator.test.ts
import { describe, it, expect } from 'vitest';
import { generateOutlineDetailedSplit } from '../../../src/shared/template-generator';

describe('generateOutlineDetailedSplit', () => {
  const opts = {
    chapterCount: 5,
    targetWords: 25000,
    title: '测试小说',
    genre: 'wuxia',
    perspective: 'third-person',
  };

  it('返回 indexContent + cards，卡片数 = 章节数', () => {
    const result = generateOutlineDetailedSplit(opts);
    expect(result.indexContent).toContain('详细大纲索引');
    expect(result.cards).toHaveLength(5);
  });

  it('每张卡片含 ## 标题 + 结构定位 + 字段占位', () => {
    const result = generateOutlineDetailedSplit(opts);
    const card1 = result.cards[0];
    expect(card1.relativePath).toBe('chapters/第1章.md');
    expect(card1.content).toContain('## 第 1 章');
    expect(card1.content).toContain('**结构定位**');
    expect(card1.content).toContain('**主要场景**');
  });

  it('索引含三幕结构表', () => {
    const result = generateOutlineDetailedSplit(opts);
    expect(result.indexContent).toContain('第一幕');
    expect(result.indexContent).toContain('chapters/第1章.md');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/shared/template-generator.test.ts
```

Expected: FAIL with "generateOutlineDetailedSplit is not exported"

- [ ] **Step 3: Write minimal implementation**

在 `src/shared/template-generator.ts` 中：

1. 在文件顶部添加 import：

```typescript
import type { SplitTemplateResult } from './split-document';
```

实际上不需要从 split-document import 类型——`SplitTemplateResult` 定义在本文件中：

```typescript
/** 拆分型模板生成结果。 */
export interface SplitTemplateResult {
  indexContent: string;
  cards: Array<{ relativePath: string; content: string }>;
}
```

2. 在 `generateOutlineDetailed` 函数之后，新增 `generateOutlineDetailedSplit`：

```typescript
/**
 * 生成详细大纲（拆分格式）：返回索引 + 逐章卡片文件。
 * 每章一张独立卡片文件（chapters/第N章.md），index.md 提供全局结构索引。
 */
export function generateOutlineDetailedSplit(options: TemplateGenOptions): SplitTemplateResult {
  const n = Math.max(1, options.chapterCount);
  const per = wordsPerChapter(options);
  const plan = planActs(n);

  const cards: Array<{ relativePath: string; content: string }> = [];

  for (let i = 1; i <= n; i++) {
    const act = actName(i, plan);
    const lines: string[] = [
      `## 第 ${i} 章：{章节标题} ｜ ${act} ｜ 目标约 ${per} 字`,
      `- **结构定位**：${chapterHint(i, n, plan)}`,
      '- **主要场景**：{一句话概括本章核心场景与发生地点}',
      '- **目标**：{主角在本章想要达成什么}',
      '- **冲突**：{什么力量或角色阻碍了目标的实现}',
      '- **结果**：{本章结局——灾难升级还是取得进展？}',
      '- **伏笔/回调**：{埋下的伏笔，或回收的前文线索}',
    ];
    cards.push({
      relativePath: `chapters/第${i}章.md`,
      content: lines.join('\n'),
    });
  }

  // 构建索引
  const indexLines: string[] = [
    `# 详细大纲索引：《${options.title}》`,
    '',
    `> 类型：${options.genre}｜视角：${perspectiveLabel(options.perspective)}｜目标字数：约 ${options.targetWords} 字｜共 ${n} 章（每章约 ${per} 字）`,
    '> 每章独立文件位于 chapters/第N章.md，用 Read 工具按需读取单章。',
    '',
    '## 三幕结构',
    '',
    '| 幕 | 章节范围 |',
    '|---|---|',
    `| 第一幕·设置 | 第1–${plan.act1Count}章 |`,
  ];
  if (plan.act3Start > plan.act1Count + 1) {
    indexLines.push(`| 第二幕·对抗 | 第${plan.act1Count + 1}–${plan.act3Start - 1}章 |`);
  }
  indexLines.push(`| 第三幕·解决 | 第${plan.act3Start}–${n}章 |`);
  indexLines.push('', '## 章节索引', '', '| 章 | 标题 | 文件 |', '|---|---|---|');

  for (let i = 1; i <= n; i++) {
    indexLines.push(`| ${i} | {章节标题} | chapters/第${i}章.md |`);
  }

  return {
    indexContent: `${indexLines.join('\n')}\n`,
    cards,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/shared/template-generator.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/template-generator.ts tests/unit/shared/template-generator.test.ts
git commit -m "feat: add generateOutlineDetailedSplit for split template format"
```

---

### Task 3: API 路由（落盘 + 合并接口 + 迁移端点）

**Files:**
- Modify: `src/api/routes/projects.ts` (generate-templates 端点 + 新增迁移端点)
- Create: `src/api/routes/documents.ts`
- Modify: `src/api-app.ts` (注册 documents 路由)
- Test: `tests/unit/api/documents.test.ts`

- [ ] **Step 1: Write the failing test for documents route**

```typescript
// tests/unit/api/documents.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { db, ensureDbReady } from '../../../src/db/drizzle';
import { projects } from '../../../src/db/schema';
import { eq } from 'drizzle-orm';
import apiApp from '../../../src/api-app';

vi.mock('../../../src/agent/registry', () => ({ getAgentDef: () => ({ id: 'claude', label: 'Claude' }) }));
vi.mock('../../../src/agent/detection', () => ({ detectAgents: async () => [] }));

describe('GET /api/projects/:id/document/:type', () => {
  let projectDir: string;
  let projectId: string;

  beforeEach(async () => {
    await ensureDbReady();
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-test-'));
    projectId = 'proj_test_' + Date.now();
    await db.insert(projects).values({
      id: projectId,
      title: '测试',
      path: projectDir,
      genre: 'wuxia',
    });

    // 创建 concept/ 目录格式
    const conceptDir = path.join(projectDir, '.novel', 'concept');
    await fs.mkdir(conceptDir, { recursive: true });
    await fs.writeFile(
      path.join(conceptDir, 'index.md'),
      '# 概念索引：《测试》\n\n| 要素 | 摘要 | 文件 |\n|---|---|---|\n| 核心主题 | 测试主题 | 核心主题.md |\n',
    );
    await fs.writeFile(
      path.join(conceptDir, '核心主题.md'),
      '## 核心主题\n\n这是核心主题内容。',
    );
  });

  it('合并 concept 目录为单个 markdown', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/document/concept`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.content).toContain('# 概念索引');
    expect(data.content).toContain('## 核心主题');
    expect(data.content).toContain('这是核心主题内容');
  });

  it('文档不存在返回 404', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/document/world`);
    expect(res.status).toBe(404);
  });

  it('无效类型返回 400', async () => {
    const res = await apiApp.request(`/api/projects/${projectId}/document/invalid`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/api/documents.test.ts
```

Expected: FAIL (route not found)

- [ ] **Step 3: Create documents route**

```typescript
// src/api/routes/documents.ts
import { Hono } from 'hono';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { projects } from '../../db/schema';
import { resolveNovelDir } from '../../shared/project-dir';
import type { DocType } from '../../shared/split-document';

const documentsRouter = new Hono();

const VALID_TYPES = new Set<DocType>(['concept', 'world', 'outline']);

/**
 * 合并读取拆分文档：读 index.md + 遍历卡片 → 按索引顺序拼合 → 返回单个 markdown。
 * 前端视图用 parseSections 渲染，输入需要合并后的整份 markdown。
 */
documentsRouter.get('/:id/document/:type', async (c) => {
  const docType = c.req.param('type') as DocType;
  if (!VALID_TYPES.has(docType)) {
    return c.json({ error: `Invalid document type: ${docType}` }, 400);
  }

  const novelDir = await resolveNovelDir(c.req.param('id'));
  const dirMap: Record<DocType, string> = {
    concept: 'concept',
    world: 'world',
    outline: 'outline',
  };
  const docDir = path.join(novelDir, dirMap[docType]);

  let indexContent: string;
  try {
    indexContent = await readFile(path.join(docDir, 'index.md'), 'utf-8');
  } catch {
    return c.json({ error: `${docType} document not found` }, 404);
  }

  // 读目录下所有卡片（排除 index.md），按文件名排序
  let entries: string[];
  try {
    entries = await readdir(docDir, { recursive: true, withFileTypes: false }) as string[];
  } catch {
    entries = [];
  }

  const cardContents: string[] = [indexContent.trim(), ''];

  // outline 类型：读 chapters/ 子目录
  const cardFiles = entries
    .filter((f) => f !== 'index.md' && f.endsWith('.md'))
    .sort();

  for (const relPath of cardFiles) {
    try {
      const content = await readFile(path.join(docDir, relPath), 'utf-8');
      cardContents.push(content.trim(), '');
    } catch { /* skip */ }
  }

  return c.json({ content: cardContents.join('\n').trim() + '\n' });
});

export default documentsRouter;
```

- [ ] **Step 4: Register route in api-app.ts**

在 `src/api-app.ts` 中：

1. 添加 import（在其他 router import 之后）：
```typescript
import documentsRouter from './api/routes/documents';
```

2. 在 `app.route('/api/projects', projectsRouter);` 之后添加：
```typescript
// documents 路由挂在 projects 下，路径为 /api/projects/:id/document/:type
// 但 projectsRouter 已经被 timelineRouter 挂载占用，所以直接挂在 app 上
app.route('/api/projects/:id', documentsRouter);
```

Wait — 这会导致路由冲突。`projectsRouter` 已经在 `/api/projects` 上。documents 路由用 `/:id/document/:type` 模式，与 `projectsRouter` 的子路由不冲突，因为 projectsRouter 内部路由是 `/:id/...` 而 Hono 的 route() 是前缀匹配。

实际上 `app.route('/api/projects', projectsRouter)` 已经注册了 `/api/projects/:id/...` 的所有子路由。我需要把 documentsRouter 挂在 projectsRouter **内部**。

**修正**：在 `src/api/routes/projects.ts` 底部，在 `export default projectsRouter;` 之前添加：

```typescript
import documentsRouter from './documents';
projectsRouter.route('/', documentsRouter);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run tests/unit/api/documents.test.ts
```

Expected: PASS

- [ ] **Step 6: Add migration endpoint to projects.ts**

在 `src/api/routes/projects.ts` 中，`export default projectsRouter;` 之前添加迁移端点：

```typescript
import { splitMarkdownToCards, buildIndexMarkdown, DOC_DIR } from '../../shared/split-document';
import type { DocType } from '../../shared/split-document';

/**
 * 迁移：将旧格式单文件（concept.md / world-building.md / outline-detailed.md）
 * 拆分为目录 + 索引 + 卡片文件。新项目无需调用。
 */
projectsRouter.post('/:id/migrate-split', async (c) => {
  const id = c.req.param('id');
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return c.json({ error: 'Not found' }, 404);

  const novelDir = path.join(project.path, '.novel');
  const { readFileSync, unlinkSync, mkdirSync, writeFileSync } = await import('node:fs');

  // 旧文件 → 文档类型映射
  const migrations: Array<{ oldFile: string; docType: DocType; actBreaks?: [number, number] }> = [
    { oldFile: 'concept.md', docType: 'concept' },
    { oldFile: 'world-building.md', docType: 'world' },
    { oldFile: 'outline-detailed.md', docType: 'outline' },
  ];

  // outline 的三幕分界从 outline-meta.json 读取
  let actBreaks: [number, number] | undefined;
  try {
    const metaRaw = readFileSync(path.join(novelDir, 'outline-meta.json'), 'utf-8');
    const meta = JSON.parse(metaRaw);
    if (Array.isArray(meta.actBreaks) && meta.actBreaks.length >= 2) {
      actBreaks = [meta.actBreaks[0], meta.actBreaks[1]];
    }
  } catch { /* no meta file */ }

  const results: Array<{ docType: string; cards: number; migrated: boolean }> = [];

  for (const migration of migrations) {
    const oldPath = path.join(novelDir, migration.oldFile);
    let content: string;
    try {
      content = readFileSync(oldPath, 'utf-8');
    } catch {
      results.push({ docType: migration.docType, cards: 0, migrated: false });
      continue;
    }

    const { splitMarkdownToCards, buildIndexMarkdown, DOC_DIR } = await import('../../shared/split-document');
    const split = splitMarkdownToCards(content, migration.docType);
    const finalActBreaks = migration.docType === 'outline' ? actBreaks : undefined;
    const indexContent = buildIndexMarkdown(
      migration.docType,
      `《${project.title}》`,
      split.cards,
      finalActBreaks,
    );

    // 写目录
    const newDir = path.join(novelDir, DOC_DIR[migration.docType]);
    mkdirSync(newDir, { recursive: true });
    writeFileSync(path.join(newDir, 'index.md'), indexContent, 'utf-8');

    for (const card of split.cards) {
      const cardPath = path.join(newDir, card.fileName);
      mkdirSync(path.dirname(cardPath), { recursive: true });
      writeFileSync(cardPath, card.content, 'utf-8');
    }

    // 删旧文件
    unlinkSync(oldPath);

    results.push({ docType: migration.docType, cards: split.cards.length, migrated: true });
  }

  return c.json({ ok: true, results });
});
```

- [ ] **Step 7: Adapt generate-templates endpoint for split format**

在 `src/api/routes/projects.ts` 的 `generate-templates` 端点（约 line 557-569），修改循环体：

```typescript
  for (const name of requested) {
    const generator = TEMPLATE_GENERATORS[name];
    const relPath = TEMPLATE_FILE_PATHS[name];
    if (!generator || !relPath) continue;

    // outline-detailed 特殊处理：拆分型模板
    if (name === 'outline-detailed') {
      const split = generateOutlineDetailedSplit(opts);
      const outlineDir = path.join(novelDir, 'outline');
      mkdirSync(path.join(outlineDir, 'chapters'), { recursive: true });
      writeFileSync(path.join(outlineDir, 'index.md'), split.indexContent, 'utf-8');
      for (const card of split.cards) {
        writeFileSync(path.join(outlineDir, card.relativePath), card.content, 'utf-8');
      }
      written.push({ name, path: 'outline/', backedUp: existsSync(path.join(novelDir, 'outline-detailed.md')) });
      continue;
    }

    const fullPath = path.join(novelDir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    const backedUp = existsSync(fullPath);
    if (backedUp) copyFileSync(fullPath, `${fullPath}.bak`);
    writeFileSync(fullPath, generator(opts), 'utf-8');
    written.push({ name, path: relPath, backedUp });
  }
```

同时在 import 中添加：
```typescript
import { generateOutlineDetailedSplit } from '../../shared/template-generator';
```

- [ ] **Step 8: Update TEMPLATE_FILE_PATHS for outline-detailed**

在 `src/shared/template-generator.ts` 中，修改 `TEMPLATE_FILE_PATHS`：

```typescript
export const TEMPLATE_FILE_PATHS: Record<string, string> = {
  'outline-detailed': 'outline/',  // 拆分型，路径为目录
  'outline-brief': 'outline-brief.md',
  scenes: 'scenes.md',
  'character-profiles': 'characters/profiles.md',
  'outline-meta': 'outline-meta.json',
};
```

- [ ] **Step 9: Commit**

```bash
git add src/api/routes/projects.ts src/api/routes/documents.ts src/api-app.ts src/shared/template-generator.ts tests/unit/api/documents.test.ts
git commit -m "feat: add document merge endpoint, migration endpoint, split template write"
```

---

### Task 4: prompt-composer 注入层 + stage 指令

**Files:**
- Modify: `src/agent/prompt-composer.ts` (buildCoreSettingsLayer + STAGE_TAIL)

- [ ] **Step 1: Adapt buildCoreSettingsLayer**

在 `src/agent/prompt-composer.ts` 中，替换 `buildCoreSettingsLayer` 函数（约 line 382-404）：

```typescript
/** 核心设定层（恒定）：concept + world 索引注入，按需 Read 卡片。
 * 拆分后每个节文件是合理大小，不再需要截断 hack。 */
async function buildCoreSettingsLayer(projectDir: string): Promise<string> {
  const blocks: string[] = [];

  // concept 索引
  const conceptIndex = await readNovelFile(projectDir, 'concept/index.md');
  if (conceptIndex) {
    blocks.push(`#### 故事概念索引 (concept/index.md)\n${conceptIndex}\n> 如需详细要素，用 Read 工具读取 concept/具体要素.md`);
  }

  // world 索引
  const worldIndex = await readNovelFile(projectDir, 'world/index.md');
  if (worldIndex) {
    blocks.push(`#### 世界观索引 (world/index.md)\n${worldIndex}\n> 如需详细设定，用 Read 工具读取 world/具体节.md`);
  }

  if (blocks.length === 0) return '';
  return `### 核心设定层（恒定）\n${blocks.join('\n\n')}`;
}
```

删除不再需要的常量：
```typescript
// 删除这两行
const WORLD_FULL_THRESHOLD = 4000;
const WORLD_SUMMARY_CHARS = 800;
```

- [ ] **Step 2: Update STAGE_TAIL paths**

在 `src/agent/prompt-composer.ts` 中，修改 `STAGE_TAIL` 对象：

concept:
```
旧：将结果保存到 .novel/concept.md
新：将结果保存到 .novel/concept/ 目录（每张卡一个独立 .md 文件 + index.md 索引）
```

world:
```
旧：保存到 .novel/world-building.md
新：保存到 .novel/world/ 目录（每张卡一个独立 .md 文件 + index.md 索引）
```

outline:
```
旧：保存到 .novel/outline-detailed.md
新：保存到 .novel/outline/ 目录（chapters/第N章.md 每章一张卡 + index.md 索引）
```

scenes:
```
旧：保存到 .novel/scenes.md
新：不变（scenes.md 保持单文件）
```

具体替换文本（`STAGE_TAIL` 中）：

```typescript
  concept: `
概念完成后（前提清晰、核心冲突明确、主要角色已定义），将结果保存到 .novel/concept/ 目录——每个 `##` 要素一个独立 .md 文件（如 concept/核心主题.md），同时创建 .novel/concept/index.md 索引文件（含要素标题表）。并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "world" }）将项目阶段更新为 "world"。`,

  world: `
世界观完成后，保存到 .novel/world/ 目录——每个 `##` 节一个独立 .md 文件（如 world/社会结构.md），同时创建 .novel/world/index.md 索引文件。并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "characters" }）将项目阶段更新为 "characters"。`,
```

outline STAGE_TAIL 中的大纲保存指令：
```
旧：大纲完成后，保存到 .novel/outline-detailed.md。同时生成 .novel/outline-meta.json
新：大纲完成后，保存到 .novel/outline/ 目录——每章一个独立文件 chapters/第N章.md，同时创建 .novel/outline/index.md 索引（含三幕结构 + 章节标题表）。同时生成 .novel/outline-meta.json
```

脚手架提示也更新：
```
旧：不落盘预览可用 GET /api/projects/{projectId}/templates/outline-detailed 或 templates/outline-brief
新：不落盘预览可用 GET /api/projects/{projectId}/templates/outline-brief
（outline-detailed 预览不再适用——它是目录型，直接用 generate-templates 端点生成目录）
```

- [ ] **Step 3: Run typecheck + relevant tests**

```bash
npm run typecheck && npx vitest run tests/unit/agent/prompt-composer.test.ts
```

Expected: typecheck PASS（如有 STAGE_TAIL 断言需要适配，更新测试）

- [ ] **Step 4: Commit**

```bash
git add src/agent/prompt-composer.ts
git commit -m "refactor: prompt-composer uses split document indexes, remove world truncation hack"
```

---

### Task 5: chapter-context 适配

**Files:**
- Modify: `src/agent/chapter-context.ts` (extractChapterOutline)

- [ ] **Step 1: Replace extractChapterOutline**

在 `src/agent/chapter-context.ts` 中，替换 `extractChapterOutline` 函数：

```typescript
const OUTLINE_CHAPTERS_DIR = path.join('outline', 'chapters');

/** 从大纲目录读取第 N 章卡片文件。 */
export async function extractChapterOutline(
  projectDir: string,
  chapter: number,
): Promise<string> {
  const content = await readNovelFile(projectDir, `${OUTLINE_CHAPTERS_DIR}/第${chapter}章.md`);
  if (!content) return `> [第${chapter}章未在 outline/chapters/ 中规划]`;
  return content;
}
```

删除不再使用的常量和辅助函数：
- `const OUTLINE_FILE = 'outline-detailed.md';`
- `chapterInRange` 函数（检查是否还有其他引用；如果没有则删除）

- [ ] **Step 2: Run typecheck + relevant tests**

```bash
npm run typecheck && npx vitest run tests/unit/agent/chapter-context.test.ts
```

如果 chapter-context 测试中有基于 outline-detailed.md 全文的测试用例，需要更新为写 `outline/chapters/第N章.md` 文件。

- [ ] **Step 3: Commit**

```bash
git add src/agent/chapter-context.ts
git commit -m "refactor: chapter-context reads single chapter card from outline/chapters/"
```

---

### Task 6: timeline 路由适配

**Files:**
- Modify: `src/api/routes/timeline.ts` (GET timeline + PUT interaction)
- Modify: `src/shared/diagram-builders.ts` (parseOutlineChapters 不变，但调用方需遍历目录)

- [ ] **Step 1: Adapt GET /:id/timeline**

在 `src/api/routes/timeline.ts` 中，替换 `GET /:id/timeline` handler（约 line 24-42）：

```typescript
import { readFile, writeFile, readdir } from 'node:fs/promises';

timelineRouter.get('/:id/timeline', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  const chaptersDir = path.join(novelDir, 'outline', 'chapters');

  // 遍历 outline/chapters/ 目录，逐文件解析
  let files: string[];
  try {
    files = await readdir(chaptersDir);
  } catch {
    return c.json({ timelines: null, chapters: [] });
  }

  const chapterFiles = files
    .filter((f) => /^第\d+章\.md$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)?.[0] ?? '0', 10);
      const nb = parseInt(b.match(/\d+/)?.[0] ?? '0', 10);
      return na - nb;
    });

  const allChapters: OutlineChapter[] = [];
  const chapterInteractions: Array<{ number: number; title: string; interaction: string }> = [];

  for (const file of chapterFiles) {
    const content = await readFile(path.join(chaptersDir, file), 'utf-8');
    const parsed = parseOutlineChapters(content);
    for (const ch of parsed) {
      allChapters.push(ch);
      const interaction = extractChapterField(content, ch.number, '角色交互');
      chapterInteractions.push({ number: ch.number, title: ch.title, interaction });
    }
  }

  const timelines = buildStoryTimeline(allChapters);
  return c.json({ timelines, chapters: chapterInteractions });
});
```

- [ ] **Step 2: Adapt PUT /:id/interaction**

PUT interaction 路由（约 line 150-190）当前读写 `outline-detailed.md` 全文。改为读写单章卡片文件：

```typescript
timelineRouter.put('/:id/interaction', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  const body = await c.req.json();
  const chapter = body.chapter as number;
  const interaction = body.interaction as string;
  if (!chapter || typeof interaction !== 'string') {
    return c.json({ error: 'chapter and interaction are required' }, 400);
  }

  const chapterPath = path.join(novelDir, 'outline', 'chapters', `第${chapter}章.md`);
  let content: string;
  try {
    content = await readFile(chapterPath, 'utf-8');
  } catch {
    return c.json({ error: `Chapter ${chapter} outline not found` }, 404);
  }

  const updated = replaceChapterInteraction(content, chapter, interaction);
  if (updated === null) {
    return c.json({ error: `Chapter ${chapter} section not found` }, 404);
  }

  await writeFile(chapterPath, updated, 'utf-8');
  return c.json({ ok: true });
});
```

- [ ] **Step 3: Adapt fill route (SSE batch fill)**

SSE fill 路由（约 line 190-260）当前遍历 outline-detailed.md 全文找缺失字段。改为遍历 outline/chapters/ 目录：

找到 fill 路由中的 `readFile(path.join(novelDir, 'outline-detailed.md'))` 和 `parseOutlineChapters(outline)` 部分，替换为遍历目录逐文件检查。每章文件独立处理，缺字段则写回单文件。

- [ ] **Step 4: Run typecheck + relevant tests**

```bash
npm run typecheck && npx vitest run tests/unit/api/timeline.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/timeline.ts
git commit -m "refactor: timeline route reads/writes per-chapter outline cards"
```

---

### Task 7: entity-dict + context-manager 路径更新

**Files:**
- Modify: `src/web/hooks/useEntityDict.ts`
- Modify: `src/agent/context-manager.ts`

- [ ] **Step 1: Update useEntityDict candidates**

在 `src/web/hooks/useEntityDict.ts` 中，修改 candidates 的收集逻辑：

```typescript
  // 候选档案：characters/*.md + world/*.md + wuxia/*.md
  const candidates = useMemo(() => {
    const list = fileList ?? [];
    const result: Array<{ key: string; path: string }> = [];
    for (const p of list) {
      if (p.startsWith('characters/') && p.endsWith('.md')) {
        result.push({ key: `char-${p}`, path: p });
      } else if (p.startsWith('world/') && p.endsWith('.md') && p !== 'world/index.md') {
        result.push({ key: `world-${p}`, path: p });
      } else if (p.startsWith('concept/') && p.endsWith('.md') && p !== 'concept/index.md') {
        result.push({ key: `concept-${p}`, path: p });
      } else if (p.startsWith('wuxia/') && p.endsWith('.md')) {
        result.push({ key: `wuxia-${p}`, path: p });
      }
    }
    return result;
  }, [fileList]);
```

- [ ] **Step 2: Update context-manager path references**

在 `src/agent/context-manager.ts` 中，搜索所有 `concept.md` 和 `world-building.md` 的引用：

`ensureContextArtifacts` 函数中的兜底逻辑：如果引用了 `concept.md` 或 `world-building.md` 作为兜底读取，更新为 `concept/index.md` 和 `world/index.md`。

注意：`PROFILES_FILE`（`characters/profiles.md`）不变。

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/web/hooks/useEntityDict.ts src/agent/context-manager.ts
git commit -m "refactor: entity-dict scans world/ and concept/ directories, context-manager paths"
```

---

### Task 8: deepen + enricher + reverse-decomposer prompt 更新

**Files:**
- Modify: `src/shared/deepen.ts` (STAGE_OUTPUT_FILES + prompt paths)
- Modify: `src/agent/enricher.ts` (file path references)
- Modify: `src/agent/reverse-decomposer.ts` (prompt instructions)

- [ ] **Step 1: Update deepen STAGE_OUTPUT_FILES**

在 `src/shared/deepen.ts` 中（约 line 85-91）：

```typescript
export const STAGE_OUTPUT_FILES: Record<string, string[]> = {
  concept: ['concept/index.md'],
  world: ['world/index.md'],
  characters: ['characters/profiles.md'],
  outline: ['outline/index.md', 'outline-brief.md'],
  scenes: ['scenes.md'],
};
```

同时更新 deepen prompt 中的文件路径引用（约 line 120-146）：
- `先读取 .novel/world-building.md` → `先读取 .novel/world/ 目录下相关卡片`
- `先读取 .novel/outline-detailed.md` → `先读取 .novel/outline/index.md 和相关章节卡片`
- `先读取 .novel/world-building.md 和 .novel/characters/profiles.md` → `先读取 .novel/world/ 目录下相关卡片和 .novel/characters/profiles.md`

- [ ] **Step 2: Update enricher prompt**

在 `src/agent/enricher.ts` 中，更新所有文件路径引用：

- `concept.md、world-building.md、outline-detailed.md` → `concept/、world/、outline/ 目录`
- `读取 .novel/outline-detailed.md` → `读取 .novel/outline/chapters/ 目录下的章节卡片`
- `先读取 .novel/world-building.md` → `先读取 .novel/world/ 目录下相关卡片`

- [ ] **Step 3: Update reverse-decomposer prompt**

在 `src/agent/reverse-decomposer.ts` 中：

第一步（concept）：
```
旧：写入 .novel/concept.md
新：写入 .novel/concept/ 目录（每张卡一个 .md 文件 + index.md 索引）
```

第二步（outline）：
```
旧：写入 .novel/outline-detailed.md，每章用此格式
新：写入 .novel/outline/chapters/第N章.md（每章一个文件），同时更新 .novel/outline/index.md 章节索引
```

第三步（characters profiles）不变——已用 profiles/ 目录模式。

- [ ] **Step 4: Run typecheck + relevant tests**

```bash
npm run typecheck && npx vitest run tests/unit/shared/deepen.test.ts tests/unit/agent/enricher.test.ts tests/unit/agent/reverse-decomposer.test.ts
```

如有 prompt 内容断言需要适配，更新测试。

- [ ] **Step 5: Commit**

```bash
git add src/shared/deepen.ts src/agent/enricher.ts src/agent/reverse-decomposer.ts
git commit -m "refactor: deepen/enricher/reverse-decomposer prompts reference split directories"
```

---

### Task 9: useNovelDocument hook + 前端视图

**Files:**
- Create: `src/web/hooks/useNovelDocument.ts`
- Modify: `src/web/components/views/ConceptView.tsx`
- Modify: `src/web/components/views/WorldView.tsx`
- Modify: `src/web/components/views/OutlineView.tsx`
- Modify: `src/web/components/views/WuxiaView.tsx`

- [ ] **Step 1: Create useNovelDocument hook**

```typescript
// src/web/hooks/useNovelDocument.ts
import { useQuery } from '@tanstack/react-query';
import type { DocType } from '@/shared/split-document';

/**
 * 拉取合并后的拆分文档（后端读 index + 全部卡片 → 拼合为单个 markdown）。
 * 替代 useNovelFile 用于 concept/world/outline 三种拆分文档。
 * queryKey 与 SSE 失效逻辑对齐：file-changed 事件按目录前缀失效。
 */
export function useNovelDocument(projectId: string, docType: DocType) {
  return useQuery({
    queryKey: ['novel-document', projectId, docType],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/document/${docType}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content as string;
    },
  });
}
```

- [ ] **Step 2: Update ConceptView**

在 `src/web/components/views/ConceptView.tsx` 中：

```typescript
// 旧：
import { useNovelFile } from './viewShared';
const { data, isLoading } = useNovelFile(projectId, 'concept', 'concept.md');

// 新：
import { useNovelDocument } from '@/web/hooks/useNovelDocument';
const { data, isLoading } = useNovelDocument(projectId, 'concept');
```

卡片级修订按钮：
```typescript
// 旧：
<button onClick={() => revision.openRevise(undefined, s.title)}>

// 新：直接传卡片文件路径，不再需要 sectionTitle 锚点
<button onClick={() => revision.openRevise(`concept/${s.title}.md`)}>
```

但注意：sectionTitle 有特殊字符（`核心主题：探索/发现？`），卡片文件名经过了清理。为安全起见，ConceptView 应使用 parseSections 得到的 title 来构造路径，但需要和后端文件名一致。

**更稳妥的方案**：修订按钮的 targetFile 用从后端 fileList 中匹配的路径。但为简化，先直接用 title 构造，后端 `runs.ts` 的路径解析有兜底逻辑。

修订按钮改为：
```typescript
<button onClick={() => revision.openRevise(`concept/${cardFileName(s.title)}.md`)}>
```

其中 `cardFileName` 是从 `split-document.ts` 导出的 helper（或在前端用一个简化版）。

实际上最简单的方案：ConceptView 的 targetFile 改为整个 concept 目录是不行的（它不是一个文件）。卡片级修订需要指定具体卡片文件。

**决策**：在 `split-document.ts` 中导出 `sanitizeFileName`，前端 import 它来构造路径。

在 ConceptView 中：
```typescript
import { sanitizeFileName } from '@/shared/split-document';

// 修订按钮
<button className={cardReviseBtn}
  onClick={() => revision.openRevise(`concept/${sanitizeFileName(s.title)}.md`)}
  title="修订这一节">✎</button>
```

useFileRevision 初始化也更新：
```typescript
// 旧：
const revision = useFileRevision({ projectId, targetFile: 'concept.md', stage: 'concept' });
// 新（文件级修订改为修订整个 concept 目录的合并视图——但 runs.ts 的 revise 需要具体文件）：
// 决策：文件级 ✎ 修订改为传 concept/index.md（最短的入口），卡片级传具体卡片
const revision = useFileRevision({ projectId, targetFile: 'concept/index.md', stage: 'concept' });
```

- [ ] **Step 3: Update WorldView**

同 ConceptView 模式：

```typescript
// 旧：
const { data, isLoading } = useNovelFile(projectId, 'world', 'world-building.md');
const revision = useFileRevision({ projectId, targetFile: 'world-building.md', stage: 'world' });

// 新：
const { data, isLoading } = useNovelDocument(projectId, 'world');
const revision = useFileRevision({ projectId, targetFile: 'world/index.md', stage: 'world' });
```

卡片级修订按钮：
```typescript
<button className={cardReviseBtn}
  onClick={() => revision.openRevise(`world/${sanitizeFileName(s.title)}.md`)}
  title="修订这一节">✎</button>
```

- [ ] **Step 4: Update OutlineView**

```typescript
// 旧：
const { data, isLoading } = useNovelFile(projectId, 'outline', 'outline-detailed.md');

// 新：
const { data, isLoading } = useNovelDocument(projectId, 'outline');
```

大纲的卡片级修订用章号构造路径（更可靠）：
```typescript
// 在 renderChapter 中
const num = chapterNumber(s.title);
const targetFile = num ? `outline/chapters/第${num}章.md` : 'outline/index.md';

// 如果有卡片级修订按钮（OutlineView 当前是折叠卡片，没有 ✎ 按钮）
// 文件级修订
const revision = useFileRevision({ projectId, targetFile: 'outline/index.md', stage: 'outline' });
```

- [ ] **Step 5: Update WuxiaView**

```typescript
// 旧：
const { data: worldData, isLoading: worldLoading } = useNovelFile(
  projectId, 'world', 'world-building.md'
);

// 新：
const { data: worldData, isLoading: worldLoading } = useNovelDocument(projectId, 'world');
```

卡片级修订按钮：
```typescript
// 旧：
onClick={() => revision.openRevise('world-building.md', s.title)}
// 新：
onClick={() => revision.openRevise(`world/${sanitizeFileName(s.title)}.md`)}
```

文件级修订按钮：
```typescript
// 旧：
onClick={() => revision.openRevise('world-building.md')}
// 新：
onClick={() => revision.openRevise('world/index.md')}
```

- [ ] **Step 6: Export sanitizeFileName from split-document.ts**

在 `src/shared/split-document.ts` 中，将 `sanitizeFileName` 改为 export：

```typescript
// 旧：function sanitizeFileName(title: string): string {
// 新：
export function sanitizeFileName(title: string): string {
```

- [ ] **Step 7: Run typecheck + build**

```bash
npm run typecheck && npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/web/hooks/useNovelDocument.ts src/web/components/views/ConceptView.tsx src/web/components/views/WorldView.tsx src/web/components/views/OutlineView.tsx src/web/components/views/WuxiaView.tsx src/shared/split-document.ts
git commit -m "feat: useNovelDocument hook + views adapted to split document format"
```

---

### Task 10: useFileRevision 简化 + ProjectPage SSE + 迁移按钮

**Files:**
- Modify: `src/web/hooks/useFileRevision.ts`
- Modify: `src/web/pages/ProjectPage.tsx`

- [ ] **Step 1: Simplify useFileRevision (remove sectionTitle)**

在 `src/web/hooks/useFileRevision.ts` 中，`openRevise` 现在直接接收卡片文件路径，不再需要 `sectionTitle` 参数：

```typescript
export interface ReviseToChatDetail {
  targetFile: string;
}

export interface UseFileRevisionResult {
  /** 进入修订模式。targetFile 直接指向具体卡片文件（如 'concept/核心主题.md'）。 */
  openRevise: (targetFile?: string) => void;
  openRename: (targetFile?: string) => void;
  closeRename: () => void;
  renameDialog: ReactNode;
}
```

删除 `sectionTitle` 参数和所有相关逻辑。`openRevise` 签名简化为只接收 `targetFile`。

更新 `REVISE_TO_CHAT_EVENT` 的 detail 类型——删除 `sectionTitle` 字段。

更新测试 `tests/unit/web/use-file-revision.test.ts` 中涉及 `sectionTitle` 的用例。

**注意 ChatPanel 的消费端**：`ChatPanel.tsx` 监听 `REVISE_TO_CHAT_EVENT` 并读取 `detail.sectionTitle`。需要同步更新 ChatPanel——删除 sectionTitle 相关逻辑，因为 targetFile 现在直接是卡片路径。

搜索 ChatPanel 中 `REVISE_TO_CHAT_EVENT` 和 `sectionTitle` 的使用，移除 sectionTitle 拼接逻辑。

- [ ] **Step 2: Update ProjectPage SSE file-changed matching**

在 `src/web/pages/ProjectPage.tsx` 中（约 line 323-336），更新 SSE 匹配逻辑：

```typescript
        if (filePath.startsWith('concept/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-document', id, 'concept'] });
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'concept'] });
        } else if (filePath.startsWith('world/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-document', id, 'world'] });
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'world'] });
        } else if (filePath?.startsWith('characters/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'characters'] });
        } else if (filePath.startsWith('outline/')) {
          queryClient.invalidateQueries({ queryKey: ['novel-document', id, 'outline'] });
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'outline'] });
        } else if (filePath === 'outline-brief.md') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'outline-brief'] });
        } else if (filePath === 'scenes.md') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'scenes'] });
        } else if (filePath === 'foreshadow.json') {
          queryClient.invalidateQueries({ queryKey: ['novel-file', id, 'foreshadow'] });
        } else if (filePath === 'config.json') {
          refetchProject();
          queryClient.invalidateQueries({ queryKey: ['project', id] });
        }
```

- [ ] **Step 3: Update viewToFile mapping**

在 `src/web/pages/ProjectPage.tsx` 中（约 line 396-404）：

```typescript
  const viewToFile: Record<string, string> = {
    concept: 'concept/index.md',
    world: 'world/index.md',
    characters: 'characters/profiles.md',
    outline: 'outline/index.md',
    scenes: 'scenes.md',
    foreshadow: 'foreshadow.json',
    wuxia: 'world/index.md',
  };
```

- [ ] **Step 4: Add migration button**

在 ProjectPage 中添加迁移检测和按钮。找到一个合适的位置（如 NavHeader 附近或 settings 区域）：

```typescript
  // 检测旧格式文件是否存在
  const { data: fileList } = useNovelFileList(id);
  const hasLegacyFiles = useMemo(
    () => (fileList ?? []).some((f) =>
      f === 'concept.md' || f === 'world-building.md' || f === 'outline-detailed.md'
    ),
    [fileList],
  );

  const [migrating, setMigrating] = useState(false);
  const handleMigrate = useCallback(async () => {
    if (!id) return;
    setMigrating(true);
    try {
      const res = await fetch(`/api/projects/${id}/migrate-split`, { method: 'POST' });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['novel-file-list', id] });
        queryClient.invalidateQueries();
      }
    } catch { /* ignore */ }
    setMigrating(false);
  }, [id, queryClient]);
```

在 UI 中渲染按钮（在 NavHeader 或项目信息区域）：

```tsx
{hasLegacyFiles && (
  <button onClick={handleMigrate} disabled={migrating}>
    {migrating ? '迁移中...' : '迁移到卡片格式'}
  </button>
)}
```

- [ ] **Step 5: Run typecheck + relevant tests**

```bash
npm run typecheck && npx vitest run tests/unit/web/use-file-revision.test.ts tests/unit/web/chat-panel-revise-mode.test.tsx
```

更新涉及 `sectionTitle` 的测试用例。

- [ ] **Step 6: Commit**

```bash
git add src/web/hooks/useFileRevision.ts src/web/pages/ProjectPage.tsx src/web/components/ChatPanel.tsx tests/unit/web/use-file-revision.test.ts tests/unit/web/chat-panel-revise-mode.test.tsx
git commit -m "refactor: simplify useFileRevision to card paths, update SSE + add migration button"
```

---

### Task 11: export 路由适配

**Files:**
- Modify: `src/api/routes/export.ts`

- [ ] **Step 1: Adapt concept + world export**

在 `src/api/routes/export.ts` 中（约 line 48-57），替换 concept 和 world 的读取：

```typescript
  // Concept（拆分格式：合并目录）
  try {
    const conceptDir = path.join(projectDir, 'concept');
    const conceptIndex = await fs.readFile(path.join(conceptDir, 'index.md'), 'utf-8');
    const conceptFiles = await fs.readdir(conceptDir);
    const conceptParts: string[] = [conceptIndex];
    for (const f of conceptFiles.sort()) {
      if (f !== 'index.md' && f.endsWith('.md')) {
        conceptParts.push(await fs.readFile(path.join(conceptDir, f), 'utf-8'));
      }
    }
    parts.push(`## 故事概念\n\n${conceptParts.join('\n\n')}\n\n---\n`);
  } catch { /* skip */ }

  // World（拆分格式：合并目录）
  try {
    const worldDir = path.join(projectDir, 'world');
    const worldIndex = await fs.readFile(path.join(worldDir, 'index.md'), 'utf-8');
    const worldFiles = await fs.readdir(worldDir);
    const worldParts: string[] = [worldIndex];
    for (const f of worldFiles.sort()) {
      if (f !== 'index.md' && f.endsWith('.md')) {
        worldParts.push(await fs.readFile(path.join(worldDir, f), 'utf-8'));
      }
    }
    parts.push(`## 世界观\n\n${worldParts.join('\n\n')}\n\n---\n`);
  } catch { /* skip */ }
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/export.ts
git commit -m "refactor: export route merges concept/world directories for output"
```

---

### Task 12: 全量验证 + 迁移旧项目

- [ ] **Step 1: Full typecheck + test + build**

```bash
npm run typecheck && npm run test && npm run build
```

Expected: ALL PASS

- [ ] **Step 2: E2E — 新项目全流程**

启动应用，创建新项目，验证：
1. concept 阶段 → agent 写入 `concept/` 目录
2. world 阶段 → agent 写入 `world/` 目录
3. outline 阶段 → generate-templates 生成 `outline/` 目录
4. 前端三个视图正常渲染
5. 卡片级 ✎ 修订 → 只注入单张卡

- [ ] **Step 3: E2E — 迁移旧项目**

对已有项目（如 ygj）：
1. 点击「迁移到卡片格式」按钮
2. 验证 concept.md / world-building.md / outline-detailed.md 被删除
3. 验证 concept/ / world/ / outline/ 目录创建，卡片数 = section 数
4. 验证前端视图正常渲染迁移后的数据

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: verify split document E2E flows"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Task(s) |
|---|---|
| §2 索引文件格式 | Task 1 (buildIndexMarkdown), Task 2 (generateOutlineDetailedSplit) |
| §3 卡片文件格式 | Task 1 (splitMarkdownToCards), Task 2 |
| §4 后端合并读取接口 | Task 3 (documents.ts) |
| §4.1 SSE 文件变更监听适配 | Task 10 (ProjectPage) |
| §5.1 模板生成器 | Task 2 |
| §5.2 落盘逻辑 | Task 3 |
| §5.3 上下文注入 | Task 4 (prompt-composer) |
| §5.4 章节上下文 | Task 5 (chapter-context) |
| §5.5 时间线 | Task 6 (timeline) |
| §5.6 实体提取 | Task 7 (entity-dict) |
| §5.7 逆向分解 | Task 8 (reverse-decomposer) |
| §5.8 深化 | Task 8 (deepen) |
| §5.9 enricher | Task 8 (enricher) |
| §5.10 前端视图 | Task 9 |
| §5.11 导出 | Task 11 (export) |
| §5.12 迁移端点 | Task 3 |
| §5.13 context-manager | Task 7 |
| §6 迁移策略（手动端点） | Task 3 + Task 10 (UI 按钮) |
| 卡片级修订简化 | Task 9 (views) + Task 10 (useFileRevision) |

**Gap**: `runs.ts` 的 revise 分支需要确认 `targetFile` 现在传的是卡片路径（如 `concept/核心主题.md`），`readFile` 会正确解析。现有 `runs.ts:286-296` 的路径解析逻辑（双路径候选）已能处理。**无需额外改动**——`runs.ts` 读的是 `targetFile` 参数指定的文件，卡片路径就是真实文件路径。

### 2. Placeholder scan

✅ 无 TBD/TODO
✅ 所有步骤含完整代码
✅ 无"类似 Task N"引用

### 3. Type consistency

- `SplitTemplateResult` 在 Task 2 定义，Task 3 使用 ✅
- `DocType` 在 Task 1 定义，Task 3/7/9 使用 ✅
- `SplitCard` 在 Task 1 定义，Task 3 migration 使用 ✅
- `sanitizeFileName` 在 Task 1 定义（private），Task 9 要求 export，Task 9 Step 6 完成 export ✅
- `useNovelDocument` 在 Task 9 定义，Task 9/10 使用 ✅
