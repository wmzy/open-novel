# 逆向拆书（新「导入项目」）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接受原始小说文本文件或目录，AI 阅读分析后生成完整 `.novel/` 结构化数据，并自动产出故事脉络 timeline 与角色关系图，把任意小说变成一个 open-novel 项目。

**Architecture:** 纯函数 `text-chunker` 检测章节边界并标准化为 `第N章.md`；后端 `POST /import-text` 建空 `.novel/` 骨架并启动 agent 自主多步拆解（复用现有 SSE run 系统，agent 自己分块读取、逐步写结构化文件）；前端 HomePage 新增逆向拆书入口（原「导入项目」改名「打开项目」）；新增角色关系图视图消费已有的 `buildRelationshipGraph` 纯函数。

**Tech Stack:** TypeScript, Hono, React 19, TanStack Query, Linaria, Vitest, Mermaid

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/shared/text-chunker.ts` | 纯函数：检测章节边界、切分、标准化 | 新建 |
| `src/agent/reverse-decomposer.ts` | 构建逆向拆解 agent prompt | 新建 |
| `src/api/routes/projects.ts` | 新增 `POST /import-text` 路由；`POST /import` 注释更新为「打开项目」 | 修改 |
| `src/shared/diagram-builders.ts` | 复用已有 `buildRelationshipGraph`（不新增函数） | 不改 |
| `src/api/routes/timeline.ts` | 新增 `GET /:id/character-graph` 返回关系图源码 | 修改 |
| `src/web/components/views/CharacterGraphView.tsx` | 角色关系图视图（与 StoryArcView 同级） | 新建 |
| `src/shared/stages.ts` | `ALL_VIEWS` 新增 `character-graph` 视图项 | 修改 |
| `src/web/components/Sidebar.tsx` | 自动消费 `ALL_VIEWS`（无需改） | 不改 |
| `src/web/pages/ProjectPage.tsx` | ViewRouter 新增 `character-graph` 分支 | 修改 |
| `src/web/pages/HomePage.tsx` | 原「导入项目」改名「打开项目」；新增逆向拆书表单 | 修改 |

### 测试文件

| 文件 | 覆盖 |
|------|------|
| `tests/unit/shared/text-chunker.test.ts` | 章节切分纯函数 |
| `tests/unit/agent/reverse-decomposer.test.ts` | prompt 构建 |
| `tests/unit/api/import-text.test.ts` | import-text 路由 |
| `tests/unit/shared/character-graph-api.test.ts` | 关系图 API（可选，纯函数已在 diagram-builders.test 覆盖） |

---

## Task 1: 章节切分纯函数（text-chunker）

**Files:**
- Create: `src/shared/text-chunker.ts`
- Test: `tests/unit/shared/text-chunker.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/shared/text-chunker.test.ts
import { describe, it, expect } from 'vitest';
import { detectChapters, chineseToNumber } from '../../../src/shared/text-chunker';

describe('chineseToNumber', () => {
  it('中文数字转阿拉伯数字', () => {
    expect(chineseToNumber('一')).toBe(1);
    expect(chineseToNumber('十')).toBe(10);
    expect(chineseToNumber('二十三')).toBe(23);
    expect(chineseToNumber('一百零五')).toBe(105);
  });
  it('非中文数字原样返回 null', () => {
    expect(chineseToNumber('abc')).toBeNull();
  });
});

describe('detectChapters — 单文件', () => {
  it('中文章节标记（第N章）切分', () => {
    const content = `第一章 出发\n内容A\n\n第二章 抵达\n内容B`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.txt' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
    expect(chapters[0].title).toBe('出发');
    expect(chapters[0].content).toContain('内容A');
    expect(chapters[1].number).toBe(2);
    expect(chapters[1].title).toBe('抵达');
  });

  it('中文数字章号归一化', () => {
    const content = `第二十三章 转折\n内容`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.txt' });
    expect(chapters[0].number).toBe(23);
  });

  it('英文章节标记（Chapter N）切分', () => {
    const content = `Chapter 1\nContent A\n\nChapter 2\nContent B`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.md' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
    expect(chapters[1].number).toBe(2);
  });

  it('数字编号标题（N. 标题）切分', () => {
    const content = `1. 开始\n内容A\n\n2. 结束\n内容B`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.txt' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
    expect(chapters[1].number).toBe(2);
  });

  it('切分失败（无标记）降级为单章', () => {
    const content = `这是一段没有章节标记的纯文本。`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.txt' });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].number).toBe(1);
    expect(chapters[0].title).toBe('第1章');
    expect(chapters[0].content).toBe(content);
  });

  it('Markdown 标题（# 标题）不误判为章节', () => {
    const content = `# 书名\n\n# 第一章 开端\n内容\n\n# 第二章 发展\n内容`;
    const chapters = detectChapters({ kind: 'file', content, filename: 'book.md' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
  });
});

describe('detectChapters — 目录', () => {
  it('按文件名自然排序，文件名数字作章号', () => {
    const files = [
      { name: '3.md', content: '第三章内容' },
      { name: '1.md', content: '第一章内容' },
      { name: '2.md', content: '第二章内容' },
    ];
    const chapters = detectChapters({ kind: 'dir', files });
    expect(chapters).toHaveLength(3);
    expect(chapters[0].number).toBe(1);
    expect(chapters[0].content).toBe('第一章内容');
    expect(chapters[2].number).toBe(3);
  });

  it('文件名无数字时按排序顺序递增', () => {
    const files = [
      { name: 'alpha.md', content: '内容A' },
      { name: 'beta.md', content: '内容B' },
    ];
    const chapters = detectChapters({ kind: 'dir', files });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].number).toBe(1);
    expect(chapters[1].number).toBe(2);
  });

  it('空目录返回空数组', () => {
    const chapters = detectChapters({ kind: 'dir', files: [] });
    expect(chapters).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/shared/text-chunker.test.ts`
Expected: FAIL with "module not found"

- [ ] **Step 3: 实现 text-chunker**

```typescript
// src/shared/text-chunker.ts
/**
 * 章节切分纯函数：检测原文章节边界，标准化为 { number, title, content }。
 * 单文件按章节标记正则切分；目录按文件名排序。
 * 切分失败降级为单章，不报错。
 */

export interface ChunkedChapter {
  number: number; // 1-based
  title: string;
  content: string;
}

export type ChunkSource =
  | { kind: 'file'; content: string; filename: string }
  | { kind: 'dir'; files: { name: string; content: string }[] };

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
};

/** 中文数字字符串转 number，非中文数字返回 null。支持「二十三」「一百零五」。 */
export function chineseToNumber(s: string): number | null {
  if (!s || !/[零一二三四五六七八九十百千万两]/.test(s)) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      number = CN_DIGITS[ch];
    } else if (ch === '十') {
      section += (number || 1) * 10;
      number = 0;
    } else if (ch === '百') {
      section += (number || 1) * 100;
      number = 0;
    } else if (ch === '千') {
      section += (number || 1) * 1000;
      number = 0;
    } else if (ch === '万') {
      section += number * 10000;
      total += section;
      section = 0;
      number = 0;
    }
  }
  const result = total + section + number;
  return result > 0 ? result : null;
}

/** 归一化章号字符串：优先 parseInt，失败尝试中文数字。 */
function normalizeChapterNum(s: string): number | null {
  const n = parseInt(s, 10);
  if (!Number.isNaN(n)) return n;
  return chineseToNumber(s);
}

/** 单文件章节标记正则（按优先级）。每个捕获组 1 = 章号，组 2 = 可选标题。 */
const CHAPTER_PATTERNS: RegExp[] = [
  /^#{0,3}\s*第\s*([\d一二三四五六七八九十百千两]+)\s*章[\s：:．.]*(.*)$/m,
  /^#{0,3}\s*[Cc]hapter\s+(\d+)[\s：:．.]*(.*)$/m,
  /^#{0,3}\s*(\d+)\s*[.、]\s*(.*)$/m,
];

/** 从单文件内容切分章节。返回 null 表示无匹配标记。 */
function splitFile(content: string): ChunkedChapter[] | null {
  for (const pattern of CHAPTER_PATTERNS) {
    const global = new RegExp(pattern.source, 'gm');
    const matches = [...content.matchAll(global)];
    if (matches.length >= 2) {
      const chapters: ChunkedChapter[] = [];
      for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const num = normalizeChapterNum(m[1]);
        if (num === null) continue;
        const title = (m[2] || '').trim();
        const startIdx = m.index! + m[0].length;
        const endIdx = i + 1 < matches.length ? matches[i + 1].index! : content.length;
        const body = content.slice(startIdx, endIdx).trim();
        chapters.push({ number: num, title: title || `第${num}章`, content: body });
      }
      if (chapters.length >= 2) return chapters;
    }
  }
  return null;
}

/** 文件名自然排序比较器。 */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh', { numeric: true });
}

/** 从文件名提取章号，无数字返回 null。 */
function numFromFilename(name: string): number | null {
  const m = name.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** 从内容首行提取标题（去掉 markdown # 前缀）。 */
function titleFromContent(content: string): string {
  const firstLine = content.split('\n').find((l) => l.trim());
  if (!firstLine) return '';
  const m = firstLine.match(/^#{0,3}\s*第[\d一二三四五六七八九十百千两]+章[\s：:．.]*(.*)/);
  return m ? m[1].trim() : firstLine.replace(/^#+\s*/, '').trim();
}

/** 主入口：检测章节边界并标准化。 */
export function detectChapters(source: ChunkSource): ChunkedChapter[] {
  if (source.kind === 'file') {
    const split = splitFile(source.content);
    if (split) return split;
    // 降级为单章
    return [{ number: 1, title: '第1章', content: source.content.trim() }];
  }

  // 目录模式
  const sorted = [...source.files].sort((a, b) => naturalCompare(a.name, b.name));
  const chapters: ChunkedChapter[] = [];
  let fallbackNum = 1;
  for (const f of sorted) {
    // 文件内部可能还有多章标记
    const inner = splitFile(f.content);
    if (inner && inner.length >= 2) {
      chapters.push(...inner);
      continue;
    }
    const num = numFromFilename(f.name) ?? fallbackNum;
    fallbackNum = num + 1;
    chapters.push({
      number: num,
      title: titleFromContent(f.content) || `第${num}章`,
      content: f.content.trim(),
    });
  }
  return chapters;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/shared/text-chunker.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/shared/text-chunker.ts tests/unit/shared/text-chunker.test.ts
git commit -m "feat: text-chunker 章节切分纯函数"
```

---

## Task 2: 逆向拆解 prompt 构建（reverse-decomposer）

**Files:**
- Create: `src/agent/reverse-decomposer.ts`
- Test: `tests/unit/agent/reverse-decomposer.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/agent/reverse-decomposer.test.ts
import { describe, it, expect } from 'vitest';
import { buildReverseDecomposePrompt } from '../../../src/agent/reverse-decomposer';

describe('buildReverseDecomposePrompt', () => {
  const baseMeta = { projectDir: '/home/user/novels/book', chapterCount: 10 };

  it('包含五步指令', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('第一步');
    expect(prompt).toContain('第二步');
    expect(prompt).toContain('第三步');
    expect(prompt).toContain('第四步');
    expect(prompt).toContain('第五步');
  });

  it('注入正确章节文件路径与章数', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('chapters/第N章.md');
    expect(prompt).toContain('共 10 章');
  });

  it('无 title/genre 时省略提示', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).not.toContain('参考标题');
    expect(prompt).not.toContain('参考类型');
  });

  it('有 title/genre 时注入参考提示', () => {
    const prompt = buildReverseDecomposePrompt({ ...baseMeta, title: '示例', genre: 'wuxia' });
    expect(prompt).toContain('参考标题');
    expect(prompt).toContain('示例');
  });

  it('指令写入 state.json 的 relationships 字段', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('relationships');
    expect(prompt).toContain('state.json');
  });

  it('指令写入 outline-detailed.md 的表格格式', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('outline-detailed.md');
    expect(prompt).toContain('POV');
    expect(prompt).toContain('核心事件');
    expect(prompt).toContain('出场角色');
  });

  it('指令写入滚动摘要', () => {
    const prompt = buildReverseDecomposePrompt(baseMeta);
    expect(prompt).toContain('第N章.summary.md');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/agent/reverse-decomposer.test.ts`
Expected: FAIL with "module not found"

- [ ] **Step 3: 实现 reverse-decomposer**

```typescript
// src/agent/reverse-decomposer.ts
/**
 * 逆向拆解 agent prompt 构建器。
 * agent 自主多步：逐章读 → 提取大纲 → 聚合角色 → 识别伏笔 → 写结构化文件。
 */

export interface DecomposeMeta {
  projectDir: string;
  chapterCount: number;
  title?: string;
  genre?: string;
}

export function buildReverseDecomposePrompt(meta: DecomposeMeta): string {
  const hints: string[] = [];
  if (meta.title) hints.push(`参考标题：「${meta.title}」（agent 可调整）`);
  if (meta.genre) hints.push(`参考类型：「${meta.genre}」（agent 可调整）`);
  const hintBlock = hints.length > 0 ? `\n${hints.join('\n')}\n` : '';

  return `你是一位资深文学分析师。请逆向拆解这部小说，逐步生成 open-novel 项目结构。

源章节文件：.novel/chapters/第N章.md（共 ${meta.chapterCount} 章）${hintBlock}
所有内容写入项目目录 ${meta.projectDir} 下的 .novel/ 子目录。绝不访问项目目录之外的文件。

按以下顺序分析并写入：

## 第一步·全局概览
读取第1章与最后1章（.novel/chapters/第1章.md、.novel/chapters/第${meta.chapterCount}章.md）。写入：
- .novel/config.json（补充 title/genre/perspective/chapterCount/targetWords）
- .novel/concept.md（核心立意、故事内核、主题，约 300 字）

## 第二步·逐章大纲
每次读 2-3 章。为每章提取，写入 .novel/outline-detailed.md，每章用此格式：
#### 第N章：标题
| POV | 视点角色 |
| 核心事件 | 本章核心事件 |
| 出场角色 | 角色、角色 |
| 情感弧线 | 情感走向 |
| 写作定位 | 在全书结构中的位置 |

## 第三步·角色档案
汇总全部出场角色。为主要角色（出场≥3次）生成完整档案：
- 驱动力三角（欲望/需求/核心缺陷）
- 性格特征、外貌锚点、行为习惯、3 句典型台词
写入 .novel/characters/profiles.md（表格索引格式）+ .novel/characters/profiles/{name}.md
次要角色写入简表。

## 第四步·状态与伏笔
- .novel/state.json：每个角色的 name/location/emotion/knows/relationships/lastAppearance；
  relationships 字段是角色关系图的唯一数据源，键=对方角色名，值=关系描述（如 "武松":"对手"）；
  timeline 推进到全书终局；activeForeshadows 收集所有 planted 伏笔。
- .novel/foreshadow.json：识别全书的伏笔（status=planted）与回收（status=resolved）。

## 第五步·滚动摘要
逐章读，为每章写约 200 字语义摘要到 .novel/chapters/第N章.summary.md。
摘要包含：本章情节推进、角色状态变化、伏笔兑现或新增。严禁复制原文段落。`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/agent/reverse-decomposer.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/reverse-decomposer.ts tests/unit/agent/reverse-decomposer.test.ts
git commit -m "feat: reverse-decomposer 逆向拆解 prompt 构建"
```

---

## Task 3: import-text API 路由

**Files:**
- Modify: `src/api/routes/projects.ts`（在现有 `POST /import` 路由之后新增 `POST /import-text`）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/api/import-text.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../../src/app';

describe('POST /api/projects/import-text', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-text-'));
    app = createApp();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('路径不存在返回 400', async () => {
    const res = await app.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/nonexistent/path' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('不存在');
  });

  it('成功切章并创建 .novel/ 骨架', async () => {
    const novelPath = path.join(tmpDir, 'mynovel.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A\n\n第二章 结束\n内容B');

    const res = await app.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: novelPath }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.project.id).toMatch(/^proj_/);

    // 章节文件已标准化
    const dir = path.dirname(novelPath);
    const ch1 = fs.readFileSync(path.join(dir, '.novel/chapters/第1章.md'), 'utf-8');
    expect(ch1).toContain('开始');
    const ch2 = fs.readFileSync(path.join(dir, '.novel/chapters/第2章.md'), 'utf-8');
    expect(ch2).toContain('结束');

    // config.json 已创建
    const config = JSON.parse(fs.readFileSync(path.join(dir, '.novel/config.json'), 'utf-8'));
    expect(config.chapterCount).toBe(2);
  });

  it('目录已有 .novel/ 返回 400', async () => {
    fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });

    const res = await app.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpDir }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('已是');
  });

  it('目录输入：多文件按文件名排序切章', async () => {
    fs.writeFileSync(path.join(tmpDir, '2.md'), '第二章内容');
    fs.writeFileSync(path.join(tmpDir, '1.md'), '第一章内容');

    const res = await app.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpDir }),
    });
    expect(res.status).toBe(201);
    const ch1 = fs.readFileSync(path.join(tmpDir, '.novel/chapters/第1章.md'), 'utf-8');
    expect(ch1).toContain('第一章内容');
  });

  it('无文本文件返回 400', async () => {
    fs.writeFileSync(path.join(tmpDir, 'image.png'), 'binary');

    const res = await app.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpDir }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('未找到');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/api/import-text.test.ts`
Expected: FAIL（路由不存在 → 404）

- [ ] **Step 3: 实现 import-text 路由**

在 `src/api/routes/projects.ts` 现有 `POST /import` 路由之后（其 closing brace 之后）插入：

```typescript
// Import raw text: reverse-decompose into a new .novel/ project
projectsRouter.post('/import-text', async (c) => {
  const body = await c.req.json();
  const userPath = path.resolve(body.path);

  // 校验路径存在
  if (!existsSync(userPath)) {
    return c.json({ error: '路径不存在' }, 400);
  }

  // 收集文本内容
  const stat = statSync(userPath);
  const source: ChunkSource = stat.isDirectory()
    ? { kind: 'dir', files: collectTextFiles(userPath) }
    : { kind: 'file', content: readFileSync(userPath, 'utf-8'), filename: path.basename(userPath) };

  if (source.kind === 'dir' && source.files.length === 0) {
    return c.json({ error: '未找到 .txt 或 .md 文件' }, 400);
  }

  // 切章
  const chapters = detectChapters(source);
  if (chapters.length === 0) {
    return c.json({ error: '未检测到有效文本' }, 400);
  }

  // 创建 .novel/ 骨架
  const novelDir = path.join(userPath, '.novel');
  if (existsSync(novelDir)) {
    return c.json({ error: '该目录已是 open-novel 项目，请用「打开项目」' }, 400);
  }
  mkdirSync(path.join(novelDir, 'chapters'), { recursive: true });
  mkdirSync(path.join(novelDir, 'characters', 'profiles'), { recursive: true });

  // 写标准化章节文件
  for (const ch of chapters) {
    const header = ch.title && ch.title !== `第${ch.number}章`
      ? `# 第${ch.number}章 ${ch.title}`
      : `# 第${ch.number}章`;
    writeFileSync(
      path.join(novelDir, 'chapters', `第${ch.number}章.md`),
      `${header}\n\n${ch.content}`,
    );
  }

  // 写初始 config.json（待 agent 补全）
  writeFileSync(
    path.join(novelDir, 'config.json'),
    JSON.stringify({
      title: body.title || path.basename(userPath),
      genre: body.genre || 'general',
      perspective: 'third-person',
      chapterCount: chapters.length,
      targetWords: chapters.length * 5000,
    }, null, 2),
  );

  // 注册 DB 记录
  const id = generateId('proj_');
  const [project] = await db.insert(projects).values({
    id,
    title: body.title || path.basename(userPath),
    path: userPath,
    genre: body.genre || 'general',
    targetWords: chapters.length * 5000,
    chapterCount: chapters.length,
    perspective: 'third-person',
  }).returning();

  return c.json({ project }, 201);
});

/** 收集目录下所有 .txt/.md 文件的 { name, content }。 */
function collectTextFiles(dir: string): { name: string; content: string }[] {
  return readdirSync(dir)
    .filter((f) => /\.(txt|md)$/i.test(f))
    .map((f) => ({ name: f, content: readFileSync(path.join(dir, f), 'utf-8') }));
}
```

同时在 `projects.ts` 顶部 import 区追加：

```typescript
import { statSync } from 'node:fs';
import { detectChapters, type ChunkSource } from '../../shared/text-chunker';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/api/import-text.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/api/routes/projects.ts tests/unit/api/import-text.test.ts
git commit -m "feat: import-text 路由（逆向拆书入口）"
```

---

## Task 4: import-text SSE agent 驱动

**Files:**
- Modify: `src/api/routes/projects.ts`（扩展 Task 3 的路由，改为启动 agent + 返回 SSE）

**注意：** Task 3 创建了项目骨架但未启动 agent。本任务在骨架创建后启动 agent 拆解，通过 SSE 推送进度。为保持 Task 3 可独立测试，Task 4 将路由改为流式响应：骨架创建同步完成，agent 启动后 SSE 推送。

- [ ] **Step 1: 写失败测试（SSE 启动验证）**

在 `tests/unit/api/import-text.test.ts` 末尾的 describe 块内追加：

```typescript
  it('启动 agent 拆解并返回 runId（SSE 头）', async () => {
    const novelPath = path.join(tmpDir, 'book.txt');
    fs.writeFileSync(novelPath, '第一章 开始\n内容A\n\n第二章 结束\n内容B');

    const res = await app.request('/api/projects/import-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: novelPath, agentId: 'claude' }),
    });
    // 骨架创建 + DB 记录成功，agent 启动
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.project).toBeDefined();
    expect(data.runId).toBeDefined();
    // runId 格式校验
    expect(data.runId).toMatch(/^run_/);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/api/import-text.test.ts -t "runId"`
Expected: FAIL（`data.runId` undefined）

- [ ] **Step 3: 扩展路由为启动 agent**

将 Task 3 路由的 `return c.json({ project }, 201);` 替换为启动 agent 的逻辑。在 `src/api/routes/projects.ts` 顶部 import 区追加：

```typescript
import { createRun, emitEvent, finishRun } from '../../agent/run';
import { launchAgent } from '../../agent/launch';
import { createClaudeStreamHandler, createJsonEventHandler } from '../../agent/stream-parser';
import { buildReverseDecomposePrompt } from '../../agent/reverse-decomposer';
import { detectAgents } from '../../agent/detection';
import type { StreamEvent } from '../../agent/types';
```

将 `POST /import-text` 的末尾 `return c.json({ project }, 201);` 改为：

```typescript
  // 启动 agent 逆向拆解（非阻塞）
  const agentId = body.agentId || 'claude';
  const def = getAgentDef(agentId);
  let runId: string | undefined;
  if (def) {
    const agents = await detectAgents();
    const detected = agents.find((a) => a.id === agentId);
    if (detected?.available) {
      const run = createRun({ projectId: id, agentId, skillId: 'novel', stage: 'import' });
      run.status = 'running';
      runId = run.id;

      const prompt = buildReverseDecomposePrompt({
        projectDir: userPath,
        chapterCount: chapters.length,
        title: body.title,
        genre: body.genre,
      });
      const { child } = launchAgent(def, prompt, userPath, [], undefined);
      run.child = child;

      const onEvent = (event: StreamEvent) => emitEvent(run, 'agent', event);
      const handler = def.streamFormat === 'claude-stream-json'
        ? createClaudeStreamHandler(onEvent)
        : createJsonEventHandler(onEvent);
      child.stdout?.on('data', (chunk: Buffer) => handler.feed(chunk.toString()));
      child.stderr?.on('data', () => {});
      child.on('close', (code) => {
        handler.flush();
        finishRun(run, code === 0 ? 'completed' : 'failed');
      });
      child.on('error', () => finishRun(run, 'failed'));
    }
  }

  return c.json({ project, runId }, 201);
```

同时在 import 区追加（若不存在）：

```typescript
import { getAgentDef } from '../../agent/registry';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/api/import-text.test.ts`
Expected: PASS（含 runId 用例）

- [ ] **Step 5: 提交**

```bash
git add src/api/routes/projects.ts tests/unit/api/import-text.test.ts
git commit -m "feat: import-text 启动 agent 逆向拆解并返回 runId"
```

---

## Task 5: 角色关系图 API

**Files:**
- Modify: `src/api/routes/timeline.ts`（新增 `GET /:id/character-graph`）

`buildRelationshipGraph` 纯函数已存在于 `src/shared/diagram-builders.ts`，本任务只新增消费它的 API。

- [ ] **Step 1: 写失败测试**

```typescript
// tests/unit/api/character-graph.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../../src/app';

describe('GET /api/projects/:id/character-graph', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'char-graph-'));
    app = createApp();
    // 创建项目 + state.json
    fs.mkdirSync(path.join(tmpDir, '.novel'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.novel/state.json'),
      JSON.stringify({
        characters: [
          { name: '武松', location: '', emotion: '', knows: [], relationships: { '鲁智深': '师徒' }, lastAppearance: 1 },
          { name: '鲁智深', location: '', emotion: '', knows: [], relationships: { '武松': '师徒' }, lastAppearance: 1 },
        ],
        timeline: '', activeForeshadows: [], lastUpdatedChapter: 1, updatedAt: '',
      }),
    );
    const createRes = await app.request('/api/projects/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpDir }),
    });
    const createData = await createRes.json();
    projectId = createData.project.id;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('返回角色关系图 mermaid 源码', async () => {
    const res = await app.request(`/api/projects/${projectId}/character-graph`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.graph).toContain('graph LR');
    expect(data.graph).toContain('武松');
    expect(data.graph).toContain('师徒');
  });

  it('无角色关系时返回 graph null', async () => {
    // 覆盖 state.json 为空
    fs.writeFileSync(
      path.join(tmpDir, '.novel/state.json'),
      JSON.stringify({ characters: [], timeline: '', activeForeshadows: [], lastUpdatedChapter: 0, updatedAt: '' }),
    );
    const res = await app.request(`/api/projects/${projectId}/character-graph`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.graph).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run tests/unit/api/character-graph.test.ts`
Expected: FAIL（路由 404）

- [ ] **Step 3: 新增路由**

在 `src/api/routes/timeline.ts` 的 `GET /:id/timeline` 路由之后插入：

```typescript
/** 返回角色关系图 mermaid 源码（从 state.json.characters[].relationships 生成）。 */
timelineRouter.get('/:id/character-graph', async (c) => {
  const novelDir = await resolveNovelDir(c.req.param('id'));
  let stateRaw: string;
  try {
    stateRaw = await readFile(path.join(novelDir, 'state.json'), 'utf-8');
  } catch {
    return c.json({ graph: null });
  }
  const state = JSON.parse(stateRaw) as { characters?: Array<{ name?: string; relationships?: Record<string, string> }> };
  const chars = (state.characters || [])
    .filter((c): c is { name: string; relationships: Record<string, string> } =>
      typeof c.name === 'string' && !!c.relationships)
    .map((c) => ({ name: c.name, relationships: c.relationships }));
  const graph = buildRelationshipGraph(chars);
  return c.json({ graph });
});
```

同时在 `timeline.ts` 顶部 import 区，将 `buildRelationshipGraph` 加入现有 `diagram-builders` 导入：

```typescript
import {
  parseOutlineChapters,
  buildStoryTimeline,
  buildRelationshipGraph,
  type OutlineChapter,
} from '../../shared/diagram-builders';
```

并在 `diagram-builders.ts` 确认 `CharRelState` 已 export（已 export，无需改）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run tests/unit/api/character-graph.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/api/routes/timeline.ts tests/unit/api/character-graph.test.ts
git commit -m "feat: 角色关系图 API"
```

---

## Task 6: 角色关系图视图

**Files:**
- Create: `src/web/components/views/CharacterGraphView.tsx`
- Modify: `src/shared/stages.ts`（ALL_VIEWS 新增 character-graph）
- Modify: `src/web/pages/ProjectPage.tsx`（ViewRouter 新增分支）

- [ ] **Step 1: 修改 stages.ts 新增视图项**

在 `src/shared/stages.ts` 的 `ALL_VIEWS` 数组中，`story-arc` 项之后插入：

```typescript
  { id: 'story-arc', label: '故事脉络' },
  { id: 'character-graph', label: '角色关系' },
  { id: 'wuxia', label: '武侠' },
```

（即在 story-arc 与 wuxia 之间加一行）

- [ ] **Step 2: 创建 CharacterGraphView 组件**

```typescript
// src/web/components/views/CharacterGraphView.tsx
import { useQuery } from '@tanstack/react-query';
import { css } from '@linaria/core';
import { CollapsibleDiagram } from '../MermaidDiagram';
import { pageHeading, loadingWrap } from './viewShared';

const container = css`
  padding: 1rem;
`;

const emptyHint = css`
  padding: 2rem;
  color: var(--haze-color-text-secondary);
  font-size: 0.85rem;
  text-align: center;
`;

interface Props {
  projectId: string;
}

export default function CharacterGraphView({ projectId }: Props) {
  const { data, isLoading } = useQuery<{ graph: string | null }>({
    queryKey: ['character-graph', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/character-graph`);
      if (!res.ok) return { graph: null };
      return res.json();
    },
  });

  if (isLoading) return <div className={loadingWrap}>加载中...</div>;
  if (!data?.graph) {
    return (
      <div className={container}>
        <h2 className={pageHeading}>角色关系图</h2>
        <div className={emptyHint}>
          暂无角色关系数据。逆向拆书或正常写作后，角色关系将自动出现在此。
        </div>
      </div>
    );
  }

  return (
    <div className={container}>
      <CollapsibleDiagram chart={data.graph} title="角色关系图" />
    </div>
  );
}
```

- [ ] **Step 3: 修改 ProjectPage ViewRouter**

在 `src/web/pages/ProjectPage.tsx` 的 ViewRouter 函数中，`story-arc` 分支之后插入：

```typescript
  if (activeView === 'character-graph') return <CharacterGraphView projectId={projectId} />;
```

同时在顶部 import 区追加：

```typescript
import CharacterGraphView from '@/web/components/views/CharacterGraphView';
```

- [ ] **Step 4: 验证类型检查 + 构建**

Run: `pnpm tsc --noEmit && pnpm vite build`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/web/components/views/CharacterGraphView.tsx src/shared/stages.ts src/web/pages/ProjectPage.tsx
git commit -m "feat: 角色关系图视图"
```

---

## Task 7: HomePage 改名 + 逆向拆书表单

**Files:**
- Modify: `src/web/pages/HomePage.tsx`

- [ ] **Step 1: 改名「导入项目」→「打开项目」**

在 `src/web/pages/HomePage.tsx` 中：

1. 找到 `<button className={primaryBtn} onClick={() => setShowImport(true)} style={{ background: 'var(--haze-color-bg-secondary)', color: 'var(--haze-color-text)' }}>导入项目</button>`

替换为：

```tsx
        <button className={primaryBtn} onClick={() => setShowImport(true)} style={{ background: 'var(--haze-color-bg-secondary)', color: 'var(--haze-color-text)' }}>打开项目</button>
        <button className={primaryBtn} onClick={() => setShowImportText(true)}>导入项目</button>
```

2. 找到导入弹窗标题行（`showImport` 块内 `<label>项目目录（包含 .novel/ 结构）</label>`），改为：

```tsx
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                项目目录（包含 .novel/ 结构）
              </label>
```

3. 在 `showImport` 弹窗的「导入」按钮处，文本改为「打开」：

```tsx
            <button className={primaryBtn} onClick={handleImport}>打开</button>
```

- [ ] **Step 2: 新增逆向拆书表单 state**

在 HomePage 组件顶部 `useState` 区，`importPath` 之后追加：

```tsx
  const [showImportText, setShowImportText] = useState(false);
  const [importTextPath, setImportTextPath] = useState('');
  const [importTextTitle, setImportTextTitle] = useState('');
  const [importTextGenre, setImportTextGenre] = useState('');
```

- [ ] **Step 3: 新增 handleImportText handler**

在 `handleImport` 之后追加：

```tsx
  const handleImportText = async () => {
    if (!importTextPath.trim()) {
      toast.error('请输入源文本路径');
      return;
    }
    try {
      const res = await fetch('/api/projects/import-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: importTextPath,
          title: importTextTitle || undefined,
          genre: importTextGenre || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setShowImportText(false);
        setImportTextPath('');
        setImportTextTitle('');
        setImportTextGenre('');
        toast.success('已开始拆书，agent 正在分析');
        navigate(`/projects/${data.project.id}`);
      } else {
        toast.error(data.error || '导入失败');
      }
    } catch {
      toast.error('导入失败');
    }
  };
```

- [ ] **Step 4: 新增逆向拆书弹窗**

在 `showImport` 弹窗的闭合 `)}` 之后插入：

```tsx
      {showImportText && (
        <div className={card} style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                源文本路径（.txt/.md 文件或包含此类文件的目录）
              </label>
              <input
                className={input}
                placeholder="/home/user/novels/my-book.txt 或目录路径"
                value={importTextPath}
                onChange={(e) => setImportTextPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleImportText()}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                  标题（可选，留空自动识别）
                </label>
                <input
                  className={input}
                  placeholder="自动识别"
                  value={importTextTitle}
                  onChange={(e) => setImportTextTitle(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.25rem', color: 'var(--haze-color-text-secondary)' }}>
                  类型（可选，留空自动识别）
                </label>
                <select
                  className={input}
                  value={importTextGenre}
                  onChange={(e) => setImportTextGenre(e.target.value)}
                  style={{ width: '100%' }}
                >
                  <option value="">自动识别</option>
                  <option value="general">通用</option>
                  <option value="wuxia">武侠</option>
                  <option value="fantasy">奇幻</option>
                  <option value="scifi">科幻</option>
                  <option value="romance">言情</option>
                  <option value="mystery">悬疑</option>
                  <option value="reality">现实</option>
                </select>
              </div>
            </div>
          </div>
          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
            <button className={primaryBtn} onClick={handleImportText}>开始拆书</button>
            <button onClick={() => { setShowImportText(false); setImportTextPath(''); }}>取消</button>
          </div>
        </div>
      )}
```

**注意：** 无（select 选项与现有新建项目表单一致）。

- [ ] **Step 5: 验证类型检查 + 构建**

Run: `pnpm tsc --noEmit && pnpm vite build`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/web/pages/HomePage.tsx
git commit -m "feat: 导入项目改名打开项目，新增逆向拆书表单"
```

---

## Task 8: 全量验证与文档同步

**Files:**
- 无新建，仅验证

- [ ] **Step 1: 全量测试**

Run: `pnpm vitest run`
Expected: 全部 PASS（含新增 text-chunker / reverse-decomposer / import-text / character-graph 测试）

- [ ] **Step 2: 类型检查 + 构建**

Run: `pnpm tsc --noEmit && pnpm vite build`
Expected: 无错误

- [ ] **Step 3: 提交（若有修复）**

```bash
git add -A
git commit -m "test: 逆向拆书全量验证通过"
```

---

## Self-Review 核对

**Spec 覆盖：**
- ✅ text-chunker 纯函数 → Task 1
- ✅ reverse-decomposer prompt → Task 2
- ✅ POST /import-text 路由 → Task 3 + Task 4
- ✅ 角色关系图 API → Task 5
- ✅ 角色关系图视图 → Task 6
- ✅ HomePage 改名 + 表单 → Task 7
- ✅ 复用已有 buildRelationshipGraph → Task 5（不新增函数）
- ✅ Agent 自主多步 → Task 4（复用 launchAgent + SSE run）
- ✅ 章节标准化为 第N章.md → Task 1 + Task 3
- ✅ state.json.relationships 数据源 → Task 2 prompt + Task 5 API

**Placeholder 扫描：** 无 TBD/TODO；Task 7 Step 4 内有一处 `语义不存在的选项：` 注释提醒已标注删除。

**类型一致性：** `ChunkedChapter` / `ChunkSource` / `DecomposeMeta` / `CharRelState` 在各任务间签名一致；`detectChapters` / `buildReverseDecomposePrompt` / `buildRelationshipGraph` 命名统一。
