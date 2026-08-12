# 意图卡（Intent Card）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现作者意图卡（`.novel/intent.md`）：新建项目表单采集 + 大纲阶段 agent 追问 + 每次 run 全量注入 prompt。

**Architecture:** 新增 `src/shared/intent-card.ts` 纯函数模块（骨架生成 + 分节合并）；`prompt-composer.ts` 增加意图层注入与大纲阶段采集指令；`projects.ts` 接收 `intent` 字段并落盘；前端新建项目表单加可选折叠区。

**Tech Stack:** TypeScript · Hono · React 19 · Linaria · Vitest

**设计规格:** `docs/superpowers/specs/2026-08-13-intent-card-design.md`

**隐私红线:** 仓库是公开的。所有代码、注释、测试数据、commit message 一律使用通用示例或古典名著公开人物名（如武松、林冲），禁止出现任何真实小说项目名、书名或角色名。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/shared/intent-card.ts` | 新建 | 纯函数：`INTENT_DIMENSIONS` 维度定义、`buildIntentSkeleton()` 骨架生成、`mergeIntentSections()` 分节合并写回 |
| `src/agent/prompt-composer.ts` | 修改 | `buildIntentLayer()` 读取注入意图层；`INTENT_COLLECTION_INSTRUCTION` 大纲阶段采集指令；`buildStageInstructions` 拼接入口 |
| `src/api/routes/projects.ts` | 修改 | `POST /` 接收 `intent` 字段；`WorkspaceOpts` 加 `intent`；`initWorkspace()` 落盘 intent.md |
| `src/hooks/useProject.ts` | 修改 | `CreateProjectInput` 加 `intent` 字段 |
| `src/web/pages/HomePage.tsx` | 修改 | 新建项目表单加「创作偏好」折叠区（4 个文本域） |
| `tests/unit/shared/intent-card.test.ts` | 新建 | Task 1 单元测试 |
| `tests/unit/agent/prompt-composer.test.ts` | 追加 | Task 2/3 注入测试 |
| `tests/integration/api.test.ts` | 追加 | Task 4 落盘集成测试 |

---

## Task 1: intent-card 纯函数模块

**Files:**
- Create: `src/shared/intent-card.ts`
- Test: `tests/unit/shared/intent-card.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/unit/shared/intent-card.test.ts`：

```ts
/**
 * 意图卡纯函数测试。
 * 来源：intent-card 功能（2026-08-13 规格）。
 * 归并建议：后续意图卡相关纯函数（如意图符合度解析）可继续追加本文件。
 */
import { describe, it, expect } from 'vitest';
import { buildIntentSkeleton, mergeIntentSections, INTENT_DIMENSIONS } from '../../../src/shared/intent-card';

describe('buildIntentSkeleton', () => {
  it('无输入时生成 8 个维度全部「未设定」的骨架', () => {
    const skeleton = buildIntentSkeleton();
    expect(skeleton).toContain('# 作者意图卡');
    for (const dim of INTENT_DIMENSIONS) {
      expect(skeleton).toContain(`## ${dim.title}`);
    }
    expect(skeleton.match(/未设定/g)?.length).toBeGreaterThanOrEqual(8);
    // 无输入时每个维度小节都应含至少一个「未设定」条目
    expect(skeleton.split('## ').length - 1).toBe(8);
  });

  it('表单提供值的维度以自由文本写入，其余维度保持「未设定」', () => {
    const skeleton = buildIntentSkeleton({ pacing: '每章 4000 字，张弛有度' });
    const pacingSection = skeleton.slice(skeleton.indexOf('## 节奏偏好'), skeleton.indexOf('## 角色权重'));
    expect(pacingSection).toContain('每章 4000 字，张弛有度');
    // 其他维度仍为未设定
    expect(skeleton).toContain('核心角色（弧线优先）：未设定');
  });

  it('空字符串维度按未提供处理', () => {
    const skeleton = buildIntentSkeleton({ pacing: '  ' });
    expect(skeleton).toContain('每章字数：未设定');
  });

  it('超过 500 字的维度值截断到 500 字', () => {
    const long = '字'.repeat(600);
    const skeleton = buildIntentSkeleton({ pacing: long });
    const pacingSection = skeleton.slice(skeleton.indexOf('## 节奏偏好'), skeleton.indexOf('## 角色权重'));
    expect(pacingSection).toContain('字'.repeat(500));
    expect(pacingSection).not.toContain('字'.repeat(501));
  });
});

describe('mergeIntentSections', () => {
  const base = [
    '# 作者意图卡',
    '',
    '> 本文件记录作者的创作意图与偏好。',
    '',
    '## 节奏偏好',
    '',
    '每章 4000 字',
    '',
    '## 角色权重',
    '',
    '- 核心角色（弧线优先）：未设定',
  ].join('\n');

  it('只更新目标维度小节，其他小节原样保留', () => {
    const merged = mergeIntentSections(base, { 角色权重: '- 核心角色（弧线优先）：林冲' });
    expect(merged).toContain('## 节奏偏好');
    expect(merged).toContain('每章 4000 字');
    expect(merged).toContain('## 角色权重');
    expect(merged).toContain('林冲');
    expect(merged).not.toContain('核心角色（弧线优先）：未设定');
    // 文档头保留
    expect(merged).toContain('# 作者意图卡');
  });

  it('更新不存在的维度时追加到末尾', () => {
    const merged = mergeIntentSections(base, { 伏笔风格: '- 长线/短线配比：1:3' });
    expect(merged.indexOf('## 节奏偏好')).toBeLessThan(merged.indexOf('## 伏笔风格'));
    expect(merged).toContain('- 长线/短线配比：1:3');
  });

  it('空 updates 返回原文', () => {
    expect(mergeIntentSections(base, {})).toBe(base);
  });

  it('current 为空字符串时生成仅含更新节的文档', () => {
    const merged = mergeIntentSections('', { 节奏偏好: '每章 5000 字' });
    expect(merged.trim()).toBe('## 节奏偏好\n\n每章 5000 字');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/shared/intent-card.test.ts`
Expected: FAIL — 模块 `src/shared/intent-card` 不存在。

- [ ] **Step 3: 实现 intent-card.ts**

创建 `src/shared/intent-card.ts`：

```ts
/**
 * 意图卡：作者创作偏好的单一权威文档（.novel/intent.md）。
 *
 * - buildIntentSkeleton：表单数据 → markdown 骨架（新建项目向导落盘用）。
 * - mergeIntentSections：按维度标题合并写回（agent 追问结果落盘用，不覆盖其他小节）。
 *
 * 消费方：prompt-composer（注入 prompt）、projects 路由（创建时落盘）。
 */

/** 新建项目表单可采集的 4 个高频维度。 */
export interface IntentInput {
  /** 节奏偏好 */
  pacing?: string;
  /** 角色权重 */
  characterWeight?: string;
  /** 伏笔风格 */
  foreshadowStyle?: string;
  /** 文风锚点 */
  styleAnchor?: string;
}

/** 全部 8 个维度定义：标题 → 表单键（可选）→ 未设定时的条目骨架。 */
export const INTENT_DIMENSIONS: ReadonlyArray<{
  title: string;
  inputKey?: keyof IntentInput;
  items: string[];
}> = [
  { title: '节奏偏好', inputKey: 'pacing', items: ['每章字数：未设定', '张弛密度：未设定', '断章钩子：未设定'] },
  { title: '角色权重', inputKey: 'characterWeight', items: ['核心角色（弧线优先）：未设定', '不可死亡角色：未设定', '配角戏份上限：未设定'] },
  { title: '伏笔风格', inputKey: 'foreshadowStyle', items: ['长线/短线配比：未设定', '埋设密度：未设定', '回收节奏：未设定'] },
  { title: '文风锚点', inputKey: 'styleAnchor', items: ['语言密度：未设定', '对话/描写比例：未设定', '用词禁区：未设定'] },
  { title: '理念冲突偏好', items: ['理念冲突 vs 武力冲突比重：未设定', '说教容忍度：未设定', '理念呈现方式：未设定'] },
  { title: '多线叙事规则', items: ['单章视角数上限：未设定', '线路切换频率：未设定'] },
  { title: '结局方向', items: ['基调：未设定', '开放/闭合程度：未设定'] },
  { title: '叙事手法', items: ['倒叙/插叙容忍度：未设定', '时间跳跃：未设定'] },
];

const INTENT_HEADER = [
  '# 作者意图卡',
  '',
  '> 本文件记录作者的创作意图与偏好。AI 生成、修订、评审均以此为准。',
  '> 可随时手动编辑；缺失维度用「未设定」标注。',
].join('\n');

/** 单个维度的自由文本长度上限（规格 §5.1：表单字段超长时后端截断）。 */
const MAX_DIMENSION_CHARS = 500;

/**
 * 生成意图卡骨架。表单提供的维度以自由文本写入该节；未提供的维度输出条目骨架（「未设定」）。
 * 所有输入都会 trim；空串按未提供处理；超长值截断到 500 字。
 */
export function buildIntentSkeleton(input?: IntentInput): string {
  const sections = INTENT_DIMENSIONS.map((dim) => {
    const value = dim.inputKey ? input?.[dim.inputKey]?.trim() : undefined;
    if (value) {
      return `## ${dim.title}\n${value.slice(0, MAX_DIMENSION_CHARS)}`;
    }
    return `## ${dim.title}\n${dim.items.map((item) => `- ${item}`).join('\n')}`;
  });
  return [INTENT_HEADER, ...sections].join('\n\n') + '\n';
}

/**
 * 按 `## 标题` 行切分 markdown 文档。第一个 `##` 之前的内容归入 header。
 */
function splitSections(doc: string): { header: string; sections: Array<{ title: string; body: string }> } {
  const sections: Array<{ title: string; body: string }> = [];
  let header = '';
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  for (const line of doc.split('\n')) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (currentTitle !== null) {
        sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
      }
      currentTitle = match[1].trim();
      currentBody = [];
    } else if (currentTitle === null) {
      header += (header ? '\n' : '') + line;
    } else {
      currentBody.push(line);
    }
  }
  if (currentTitle !== null) {
    sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
  }
  return { header, sections };
}

/**
 * 合并写回：updates 的 key 为维度标题（如「角色权重」），只更新对应 `##` 小节，
 * 其他小节原样保留；目标小节不存在时追加到文档末尾。
 * 用于 agent 追问结果落盘——不覆盖用户已设定的其他维度。
 * 空值（空串/仅空白）的条目被忽略；updates 全为空时返回原文。
 */
export function mergeIntentSections(current: string, updates: Record<string, string>): string {
  const entries = Object.entries(updates).filter(([, value]) => typeof value === 'string' && value.trim());
  if (entries.length === 0) return current;

  const { header, sections } = splitSections(current);
  for (const [title, content] of entries) {
    const index = sections.findIndex((section) => section.title === title);
    if (index >= 0) {
      sections[index] = { title, body: content.trim() };
    } else {
      sections.push({ title, body: content.trim() });
    }
  }

  const body = sections.map((section) => `## ${section.title}\n\n${section.body}`).join('\n\n');
  return (header.trim() ? header.trim() + '\n\n' : '') + body + '\n';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/shared/intent-card.test.ts`
Expected: PASS（9 个用例）。

- [ ] **Step 5: Commit**

```bash
git add src/shared/intent-card.ts tests/unit/shared/intent-card.test.ts
git commit -m "feat: 意图卡纯函数模块（骨架生成 + 分节合并）"
```

---

## Task 2: 意图层注入（buildIntentLayer）

**Files:**
- Modify: `src/agent/prompt-composer.ts`（约 392-396 行 readNovelFile 之后、约 823 行 composePrompt 的 Current Stage 之前）
- Test: `tests/unit/agent/prompt-composer.test.ts`（追加到 `describe('composePrompt')` 内）

- [ ] **Step 1: 写失败测试**

在 `tests/unit/agent/prompt-composer.test.ts` 的 `describe('composePrompt')` 块末尾追加：

```ts
  describe('intent layer injection', () => {
    it('injects intent layer when intent.md exists', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      await fs.writeFile(
        path.join(tempDir, '.novel', 'intent.md'),
        '# 作者意图卡\n\n## 节奏偏好\n\n每章 4000 字\n',
      );
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).toContain('## 作者意图（以此为准）');
      expect(prompt).toContain('每章 4000 字');
      // 意图层在阶段指令之前
      expect(prompt.indexOf('## 作者意图（以此为准）')).toBeLessThan(prompt.indexOf('## Current Stage'));
    });

    it('skips intent layer when intent.md missing', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## 作者意图（以此为准）');
    });

    it('skips intent layer when intent.md is empty', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      await fs.writeFile(path.join(tempDir, '.novel', 'intent.md'), '\n');
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('## 作者意图（以此为准）');
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: FAIL — 新增 3 个用例断言不通过（prompt 不含意图层）。

- [ ] **Step 3: 实现 buildIntentLayer 与注入**

在 `src/agent/prompt-composer.ts` 中 `readNovelFile` 函数定义之后添加：

```ts
/**
 * 意图层：读取 .novel/intent.md（作者创作偏好），全量注入 prompt。
 * 文件缺失或为空返回空串——run 不阻断，存量项目平滑过渡。
 */
async function buildIntentLayer(projectDir: string): Promise<string> {
  const content = await readNovelFile(projectDir, 'intent.md');
  if (!content.trim()) return '';
  return `\n## 作者意图（以此为准）\n${content.trim()}`;
}
```

在 `composePrompt` 中，找到这一行（约 823 行）：

```ts
  parts.push(`\n## Current Stage: ${currentStage}\n${effectiveStageInstructions}`);
```

在其**之前**插入：

```ts
  // 作者意图层：意图卡（intent.md）作为硬约束，置于阶段指令之前
  const intentLayer = await buildIntentLayer(projectDir);
  if (intentLayer) {
    parts.push(intentLayer);
  }

  parts.push(`\n## Current Stage: ${currentStage}\n${effectiveStageInstructions}`);
```

（即把原 `parts.push` 行替换为上面三段；保留原行内容不变。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: PASS（原有用例 + 新增 3 个全通过）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompt-composer.ts tests/unit/agent/prompt-composer.test.ts
git commit -m "feat: composePrompt 注入作者意图层（intent.md）"
```

---

## Task 3: 大纲阶段意图采集指令

**Files:**
- Modify: `src/agent/prompt-composer.ts`（`buildStageInstructions`，约 177-187 行）
- Test: `tests/unit/agent/prompt-composer.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `tests/unit/agent/prompt-composer.test.ts` 的 `describe('composePrompt')` 块末尾追加：

```ts
  describe('intent collection instruction', () => {
    it('injects intent collection instruction in outline stage (non-autonomous)', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
      });
      expect(prompt).toContain('作者意图采集（仅大纲阶段）');
      expect(prompt).toContain('.novel/intent.md');
    });

    it('does not inject in autonomous mode', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'outline',
        projectDir: tempDir,
        autonomous: true,
      });
      expect(prompt).not.toContain('作者意图采集（仅大纲阶段）');
    });

    it('does not inject in non-outline stages', async () => {
      mockLimit.mockResolvedValue([makeProject()]);
      await seedProjectFiles(tempDir);
      const prompt = await composePrompt({
        message: 'hi',
        projectId: 'p',
        skillId: 'novel',
        stage: 'characters',
        projectDir: tempDir,
      });
      expect(prompt).not.toContain('作者意图采集（仅大纲阶段）');
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: FAIL — 新增 3 个用例断言不通过。

- [ ] **Step 3: 实现 INTENT_COLLECTION_INSTRUCTION 常量与拼接**

在 `src/agent/prompt-composer.ts` 的 `buildStageInstructions` 函数（约 177 行）**之前**添加常量：

```ts
/** 大纲阶段的意图采集指令：先读意图卡 → 追问「未设定」维度 → 合并写回。仅采访式（非自治）注入。 */
const INTENT_COLLECTION_INSTRUCTION = [
  '',
  '## 作者意图采集（仅大纲阶段）',
  '生成大纲前，先处理作者意图卡（.novel/intent.md）：',
  '1. 用 Read 读取 .novel/intent.md。若文件不存在，用 Write 按下方模板创建：',
  '',
  '```markdown',
  '# 作者意图卡',
  '',
  '> 本文件记录作者的创作意图与偏好。AI 生成、修订、评审均以此为准。',
  '> 可随时手动编辑；缺失维度用「未设定」标注。',
  '',
  '## 节奏偏好',
  '- 每章字数：未设定',
  '- 张弛密度：未设定',
  '- 断章钩子：未设定',
  '',
  '## 角色权重',
  '- 核心角色（弧线优先）：未设定',
  '- 不可死亡角色：未设定',
  '- 配角戏份上限：未设定',
  '',
  '## 伏笔风格',
  '- 长线/短线配比：未设定',
  '- 埋设密度：未设定',
  '- 回收节奏：未设定',
  '',
  '## 文风锚点',
  '- 语言密度：未设定',
  '- 对话/描写比例：未设定',
  '- 用词禁区：未设定',
  '',
  '## 理念冲突偏好',
  '- 理念冲突 vs 武力冲突比重：未设定',
  '- 说教容忍度：未设定',
  '- 理念呈现方式：未设定',
  '',
  '## 多线叙事规则',
  '- 单章视角数上限：未设定',
  '- 线路切换频率：未设定',
  '',
  '## 结局方向',
  '- 基调：未设定',
  '- 开放/闭合程度：未设定',
  '',
  '## 叙事手法',
  '- 倒叙/插叙容忍度：未设定',
  '- 时间跳跃：未设定',
  '```',
  '',
  '2. 对仍为「未设定」的维度，用提问工具（ask）逐维追问——选择题形式，每轮不超过 3 题；相关维度可合并一轮。',
  '3. 追问结果写回 intent.md：写入前重读文件，用 Edit 精确替换你追问过的维度小节，其他小节原样保留。',
  '4. 用户拒绝补充的维度保持「未设定」，不要编造。',
  '5. 生成大纲时严格以 intent.md 为约束；大纲内容不得违背其中已设定的偏好。',
].join('\n');
```

将 `buildStageInstructions` 函数体替换为：

```ts
function buildStageInstructions(stage: string, autonomous: boolean): string {
  const head = STAGE_HEAD[stage];
  if (head === undefined) return '';
  const tail = STAGE_TAIL[stage] ?? '';
  const base = autonomous
    ? head + AUTONOMOUS_PROTOCOL + '\n' + tail
    : head + INTERVIEW_PROTOCOL + '\n' + (DECISION_PROMPTS[stage] ?? '') + tail;
  // 大纲阶段（采访式）：追加意图采集指令
  if (stage === 'outline' && !autonomous) {
    return base + INTENT_COLLECTION_INSTRUCTION;
  }
  return base;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: PASS（原有用例 + Task 2 的 3 个 + 新增 3 个全通过）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompt-composer.ts tests/unit/agent/prompt-composer.test.ts
git commit -m "feat: 大纲阶段注入意图采集指令（追问未设定维度）"
```

---

## Task 4: 后端接收 intent 字段并落盘

**Files:**
- Modify: `src/api/routes/projects.ts`（`POST /` 约 40-75 行；`WorkspaceOpts` 约 285 行；`initWorkspace` 约 293 行）
- Test: `tests/integration/api.test.ts`（追加到 `describe('API Integration')` 内）

- [ ] **Step 1: 写失败测试**

在 `tests/integration/api.test.ts` 的 `describe('API Integration')` 块内（`POST /api/projects creates a project` 用例之后）追加：

```ts
  it('POST /api/projects with intent writes .novel/intent.md', async () => {
    const testDir = `/tmp/open-novel-intent-${Date.now()}`;
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Intent Test',
        path: testDir,
        genre: 'wuxia',
        intent: { pacing: '每章 4000 字，张弛有度' },
      }),
    });
    expect(res.ok).toBe(true);
    const intentPath = path.join(testDir, '.novel', 'intent.md');
    expect(fs.existsSync(intentPath)).toBe(true);
    const content = fs.readFileSync(intentPath, 'utf-8');
    expect(content).toContain('## 节奏偏好');
    expect(content).toContain('每章 4000 字，张弛有度');
    // 未提供的维度保持「未设定」
    expect(content).toContain('核心角色（弧线优先）：未设定');
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('POST /api/projects without intent does not create intent.md', async () => {
    const testDir = `/tmp/open-novel-nointent-${Date.now()}`;
    const res = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No Intent', path: testDir, genre: 'wuxia' }),
    });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.novel', 'intent.md'))).toBe(false);
    fs.rmSync(testDir, { recursive: true, force: true });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/integration/api.test.ts`
Expected: FAIL — 新增 2 个用例断言不通过（intent.md 不存在）。

- [ ] **Step 3: 实现后端接收与落盘**

`src/api/routes/projects.ts` 顶部 import 区添加：

```ts
import { buildIntentSkeleton, type IntentInput } from '../../shared/intent-card';
```

（现有 import 区已含 `import { resolveProjectDir, resolveNovelDir } from '../../shared/project-dir';`，将新 import 加在其后。）

`WorkspaceOpts` 接口添加字段：

```ts
interface WorkspaceOpts {
  title: string;
  genre: string;
  targetWords: number;
  chapterCount: number;
  perspective: string;
  skillId?: string;
  /** 新建项目表单采集的创作偏好（可选）。 */
  intent?: IntentInput;
}
```

`POST /` 路由中，`initWorkspace` 调用处（约 64-73 行）替换为：

```ts
  // 过滤空意图字段：全部为空时按未提供处理（不生成 intent.md）
  const rawIntent = (body.intent ?? {}) as Record<string, unknown>;
  const intentEntries = Object.entries(rawIntent).filter(
    ([, value]) => typeof value === 'string' && value.trim(),
  ) as Array<[keyof IntentInput, string]>;
  const intent: IntentInput | undefined = intentEntries.length > 0
    ? Object.fromEntries(intentEntries) as IntentInput
    : undefined;

  // Auto-initialize workspace
  initWorkspace(userPath, {
    title: project.title,
    genre: project.genre,
    targetWords: project.targetWords,
    chapterCount: project.chapterCount,
    perspective: project.perspective,
    skillId: body.skillId,
    intent,
  });
```

`initWorkspace` 函数中，在 `writeFileSync(path.join(novelDir, 'config.json'), ...)` 调用**之前**插入：

```ts
  // 意图卡：表单提供的创作偏好写入 intent.md（存量项目 .novel 已存在时函数已提前 return，不受影响）
  if (opts.intent) {
    writeFileSync(path.join(novelDir, 'intent.md'), buildIntentSkeleton(opts.intent), 'utf-8');
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/integration/api.test.ts`
Expected: PASS（原有用例 + 新增 2 个全通过）。

- [ ] **Step 5: Commit**

```bash
git add src/api/routes/projects.ts tests/integration/api.test.ts
git commit -m "feat: 创建项目支持意图偏好字段并落盘 intent.md"
```

---

## Task 5: 前端新建项目表单折叠区

**Files:**
- Modify: `src/hooks/useProject.ts`（`CreateProjectInput` 接口）
- Modify: `src/web/pages/HomePage.tsx`（创建表单区，约 205-230 行）

**说明:** 数据链路已被 Task 4 集成测试覆盖；本任务为纯 UI，不新增测试文件（无 HomePage 测试文件可归并，避免补丁测试孤岛）。

- [ ] **Step 1: 扩展 CreateProjectInput 类型**

`src/hooks/useProject.ts` 的 `CreateProjectInput` 接口添加：

```ts
export interface CreateProjectInput {
  title: string;
  path: string;
  genre?: string;
  targetWords?: number;
  chapterCount?: number;
  perspective?: string;
  /** 创作偏好（可选）：节奏偏好 / 角色权重 / 伏笔风格 / 文风锚点 */
  intent?: {
    pacing?: string;
    characterWeight?: string;
    foreshadowStyle?: string;
    styleAnchor?: string;
  };
}
```

- [ ] **Step 2: HomePage 添加偏好折叠区状态与样式**

`src/web/pages/HomePage.tsx` 组件内，其他 useState 附近添加：

```tsx
  const [intentPacing, setIntentPacing] = useState('');
  const [intentCharacterWeight, setIntentCharacterWeight] = useState('');
  const [intentForeshadowStyle, setIntentForeshadowStyle] = useState('');
  const [intentStyleAnchor, setIntentStyleAnchor] = useState('');
```

文件底部样式区添加（与现有 linaria `css` 定义风格一致，主题变量用 `--haze-color-*`）：

```ts
const prefsArea = css`
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-top: 0.75rem;
`;

const prefsTextarea = css`
  width: 100%;
  min-height: 3.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  border: 1px solid var(--haze-color-border);
  background: var(--haze-color-bg);
  color: var(--haze-color-text);
  font-size: 0.875rem;
  resize: vertical;
  font-family: inherit;
`;
```

- [ ] **Step 3: 组装 intent 并传入 createProject**

将 `handleCreate` 函数体替换为：

```tsx
  const handleCreate = () => {
    if (!title.trim() || !projectPath.trim()) return;
    const intentEntries = [
      ['pacing', intentPacing.trim()],
      ['characterWeight', intentCharacterWeight.trim()],
      ['foreshadowStyle', intentForeshadowStyle.trim()],
      ['styleAnchor', intentStyleAnchor.trim()],
    ].filter(([, value]) => value) as Array<[string, string]>;
    const intent = intentEntries.length > 0 ? Object.fromEntries(intentEntries) : undefined;
    createProject.mutate({
      title: title.trim(),
      path: projectPath.trim(),
      genre,
      targetWords: parseInt(targetWords) || 100000,
      chapterCount: parseInt(chapterCount) || 20,
      ...(intent ? { intent } : {}),
    }, {
      onSuccess: (data) => {
        setShowCreate(false);
        setTitle('');
        setProjectPath('');
        setIntentPacing('');
        setIntentCharacterWeight('');
        setIntentForeshadowStyle('');
        setIntentStyleAnchor('');
        navigate(`/projects/${data.project.id}`);
      },
    });
  };
```

- [ ] **Step 4: 表单 UI 添加折叠区**

插入位置：在创建表单 JSX 中 `</div>`（`formGrid` 结束，项目目录字段之后）与 `<div className={actionRow}>` 之间：

```tsx
          </div>
          <details className={prefsArea}>
            <summary>创作偏好（可选，可跳过）</summary>
            <div className={prefsArea}>
              <textarea
                className={prefsTextarea}
                maxLength={500}
                placeholder="节奏偏好：如「每章 4000 字，高潮后必留喘息章」"
                value={intentPacing}
                onChange={(e) => setIntentPacing(e.target.value)}
              />
              <textarea
                className={prefsTextarea}
                maxLength={500}
                placeholder="角色权重：如「核心角色：林冲；不可死亡：鲁智深」"
                value={intentCharacterWeight}
                onChange={(e) => setIntentCharacterWeight(e.target.value)}
              />
              <textarea
                className={prefsTextarea}
                maxLength={500}
                placeholder="伏笔风格：如「长线藏深、短线密集，每 3-5 章一个钩子」"
                value={intentForeshadowStyle}
                onChange={(e) => setIntentForeshadowStyle(e.target.value)}
              />
              <textarea
                className={prefsTextarea}
                maxLength={500}
                placeholder="文风锚点：如「语言克制、对话多于描写」"
                value={intentStyleAnchor}
                onChange={(e) => setIntentStyleAnchor(e.target.value)}
              />
            </div>
          </details>
          <div className={actionRow}>
```

注意：第一步的 `</div>` 是 `formGrid` 的闭合标签；第二步开始的 `<details>` 与其后的 `<div className={actionRow}>` 之间不需要额外的 `<div>` 包裹——`details` 自身即块级元素。`summary` 使用浏览器默认样式。

- [ ] **Step 5: 类型检查与构建**

Run: `npm run typecheck`
Expected: 无错误。

Run: `npm run build:client`
Expected: 构建成功。

- [ ] **Step 6: 手动冒烟验证**

Run: `npm run dev`，打开 http://localhost:3006，点击「新建项目」：
1. 展开「创作偏好（可选，可跳过）」，填「节奏偏好」，创建项目；
2. 在项目目录 `.novel/` 下确认 `intent.md` 存在且「节奏偏好」节为所填内容、其余维度为「未设定」；
3. 再创建一个不带偏好的项目，确认其 `.novel/` 下无 `intent.md`。

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useProject.ts src/web/pages/HomePage.tsx
git commit -m "feat: 新建项目表单支持创作偏好（意图卡）采集"
```

---

## 最终验证

全部任务完成后，依次运行：

```bash
npm run typecheck   # Expected: 无错误
npm run test        # Expected: 全部通过（含新增 intent-card 单元测试与集成用例）
npm run build       # Expected: client + server 构建成功
```

对照规格 `docs/superpowers/specs/2026-08-13-intent-card-design.md` 第 10 节验收标准逐条核对：

1. 新建项目（带 intent）→ `.novel/intent.md` 存在、表单维度已写入、其余「未设定」→ Task 4 集成测试覆盖；
2. 新建项目（不带 intent）→ 不生成 intent.md → Task 4 集成测试覆盖；
3. 大纲阶段 run 的 prompt 含「作者意图」层 → Task 2 测试覆盖；
4. intent.md 缺失/为空 → run 正常、prompt 无意图层 → Task 2 测试覆盖；
5. 手工编辑 intent.md 后再次发起 run，prompt 反映编辑内容 → `buildIntentLayer` 每次 run 重新读取文件，无缓存；Task 2 的"存在即注入"测试覆盖读取路径（手工编辑验证可在冒烟测试中做）。
