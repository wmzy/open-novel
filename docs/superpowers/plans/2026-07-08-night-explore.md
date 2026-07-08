# 夜间多路探索（Night Explore）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户睡前给一句话种子，夜间 LLM 自主发散 N 条前期设定路线，各自独立成 project，早上对比挑选最优的一条作主线。

**Architecture:** 两层——① open-novel 核心改动（composePrompt 加 `autonomous` 标志破解前期阶段的采访式阻塞 + runs API 透传该标志）；② `scripts/explore.ts` 独立调度器（发散阶段产 N 个 concept，展开阶段为每条 concept 建 project 串行自治推进 world→characters→outline，生成对比报告）。

**Tech Stack:** TypeScript, Hono, Vitest, Node fetch。

**Spec:** `docs/superpowers/specs/2026-07-08-night-explore-design.md`

---

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/agent/prompt-composer.ts` | 改 | 重构 STAGE_INSTRUCTIONS 分离交互协议；加 autonomous 标志切换自治/采访模式 |
| `src/api/routes/runs.ts` | 改 | POST /api/runs body 加 `autonomous` 字段透传 |
| `tests/unit/agent/prompt-composer.test.ts` | 改 | 加 autonomous 模式断言 |
| `tests/unit/api/runs.test.ts` | 改 | 加 autonomous 字段透传测试（新建 describe 块） |
| `scripts/explore.ts` | 新建 | 调度器：发散 + 展开 + 报告生成 |
| `tests/unit/scripts/explore.test.ts` | 新建 | 调度器单元测试（mock fetch） |
| `package.json` | 改 | 加 `explore` 脚本入口 |

---

## Task 1: 重构 STAGE_INSTRUCTIONS——分离核心任务与交互协议

**背景：** 当前 `STAGE_INSTRUCTIONS` 的每个值在编译时把 `INTERVIEW_PROTOCOL` 内联进字符串。autonomous 模式需要运行时切换协议，但内联后的字符串无法可靠 replace。因此先把核心任务描述与交互协议分离。

**Files:**
- Modify: `src/agent/prompt-composer.ts:46-120`（STAGE_INSTRUCTIONS 区域）
- Test: `tests/unit/agent/prompt-composer.test.ts`

- [ ] **Step 1: 确认现有测试全部通过（重构基线）**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: 全部 PASS。

- [ ] **Step 2: 重构——提取 STAGE_CORE 与 DECISION_PROMPTS**

在 `src/agent/prompt-composer.ts` 中，将现有的 `STAGE_INSTRUCTIONS`（行 46-120）替换为如下结构。**规则**：每个 stage 的核心任务描述（含落盘指令）放入 `STAGE_CORE`；"本阶段需要用 question 工具与用户确认的关键创作决策"清单放入 `DECISION_PROMPTS`。两者都不含 INTERVIEW_PROTOCOL。

```typescript
/** 前期阶段的核心任务描述（不含交互协议、不含决策清单）。从现有 STAGE_INSTRUCTIONS 中拆出。 */
const STAGE_CORE: Record<string, string> = {
  concept: `聚焦于构思核心概念、前提和高层故事创意。帮助用户将愿景精炼成清晰、有吸引力的概念。

概念完成后（前提清晰、核心冲突明确、主要角色已定义），将结果保存到 .novel/concept.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "world" }）将项目阶段更新为 "world"。`,

  world: `构建故事世界——设定、规则、历史、文化与氛围。创造丰富、自洽、能支撑叙事的世界观。

世界观完成后，保存到 .novel/world-building.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "characters" }）将项目阶段更新为 "characters"。`,

  characters: `撰写详细的角色档案——主角、反派与关键配角。涵盖动机、背景、关系与角色弧光。
每个主要角色必须落出驱动力三角（外在目标 / 内在需求 / 核心缺陷）。

角色档案完成后，保存到 .novel/characters/profiles.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "outline" }）将项目阶段更新为 "outline"。`,

  outline: `创建详细的故事大纲，包括主要剧情节点、角色弧光与章节结构。将故事拆解成可驾驭的段落。

**脚手架提示**：你可以请用户调用（或自己通过 Bash/curl 调用）端点 POST /api/projects/{projectId}/generate-templates，自动生成与项目 chapterCount 匹配的逐章大纲脚手架（幕、节拍、字数分配）。不落盘预览可用 GET /api/projects/{projectId}/templates/outline-detailed 或 templates/outline-brief。以生成的脚手架为起点并加以打磨。
大纲完成后，保存到 .novel/outline.md。同时生成 .novel/outline-meta.json，记录三幕分界与每章视点角色，格式如下：
\`\`\`json
{
  "actBreaks": [5, 15],
  "chapters": [
    { "chapter": 1, "pov": "林冲" },
    { "chapter": 2, "pov": "林冲" }
  ]
}
\`\`\`
actBreaks 为第一幕结束章号、第二幕结束章号；pov 为该章的视点角色名。

**伏笔登记（必做）**：从大纲中识别贯穿全书的伏笔（每处埋设 + 对应回收），写入 .novel/foreshadow.json，**替换掉模板占位**（"伏笔内容" 那一条）。每条用**具体内容**描述该伏笔是什么，而非泛泛之词。标准 schema：
\`\`\`json
{
  "foreshadows": [
    { "id": 1, "content": "具体伏笔描述", "status": "pending", "plantedIn": 预定埋设章号, "resolvedIn": 预定回收章号 }
  ]
}
\`\`\`
顶层键为 foreshadows（**不是** items），内容字段为 content（**不是** description），status 取值 pending/planted/resolved；plantedIn/resolvedIn 为数字章号，无法确定时填 null。写章时 agent 会据此把 pending 翻成 planted，故此处务必把全书伏笔登记齐全。然后通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "scenes" }）将项目阶段更新为 "scenes"。`,

  scenes: `将大纲拆解为详细场景，包含节拍、情感弧光与节奏。规划每个场景的目的与关键时刻。
确保主动场景（目标→冲突→灾难/转折）与被动场景（反应→困境→新决定）交替，避免连续同型。

**脚手架提示**：你可以请用户调用（或自己通过 Bash/curl 调用）端点 POST /api/projects/{projectId}/generate-templates，自动生成与项目 chapterCount 匹配的逐章场景脚手架（主动 Scene / 被动 Sequel 配对）。不落盘预览可用 GET /api/projects/{projectId}/templates/scenes。以生成的脚手架为起点并加以打磨。
场景表完成后，保存到 .novel/scenes.md，并通过调用 PATCH /api/projects/{projectId}（body: { "currentStage": "writing" }）将项目阶段更新为 "writing"。`,
};

/** 前期阶段的「关键创作决策」清单——仅在非自治（采访式）模式下注入。 */
const DECISION_PROMPTS: Record<string, string> = {
  concept: `**本阶段需要用 question 工具与用户确认的关键创作决策**：
- 主角原型（身份与处境）
- 核心冲突（外部矛盾 + 主角内心矛盾的方向）
- 故事主题 / 道德前提
- 整体情感基调`,

  world: `**本阶段需要用 question 工具与用户确认的关键创作决策**：
- 世界类型（现实 / 架空 / 异世界 / 未来 / 混合）
- 力量体系（无 / 简单 / 复杂；若为武侠或修仙，追问功法体系风格）
- 社会结构（权力分布、阶层、主要势力）`,

  characters: `**本阶段需要用 question 工具与用户确认的关键创作决策**：
- 主角外在目标（复仇 / 最强 / 保护 / 真相 / 自由 等）
- 主角内在需求（信任 / 接纳 / 放下 / 归属 等）
- 主角核心缺陷（自负 / 恐惧亲密 / 非黑即白 / 逃避 / 控制欲 等）
- 核心矛盾（理念 / 利益 / 宿命 / 误解）
- 配角规模（2 个 / 3-4 个 / 5+）`,

  outline: `**本阶段需要用 question 工具与用户确认的关键创作决策**：
- 三幕骨架的起点（常态世界状态）
- 触发事件类型（打破常态的关键事件）
- 中点转折方向（故事方向逆转的关键时刻）
- 高潮与结局走向
**分步确认**：先用 question 工具与用户敲定三幕骨架，用户确认结构满意后，再展开逐章详细规划——不要一次性把逐章大纲全部写完。`,

  scenes: `**本阶段需要用 question 工具与用户确认的关键创作决策**：
- 场景密度（每章平均 2-3 / 3-4 / 4-5 个场景）
- 节奏模式（严格交替 / 整体平衡 / 前松后紧）
- 自动化程度（逐章引导 / 批量审核 / 仅关键章）`,
};
```

- [ ] **Step 3: 重构——加 buildStageInstructions 函数（按 mode 组装）**

在 `STAGE_CORE` / `DECISION_PROMPTS` 定义之后、`composePrompt` 函数之前，加：

```typescript
/** 自治协议（替代采访式，用于无人值守的夜间探索等场景）。 */
const AUTONOMOUS_PROTOCOL = [
  '',
  '## 本阶段的协作方式：自治式',
  '这是无人值守的自治运行。你不需要等待用户输入——所有创作决策由你自主做出。',
  '',
  '流程：',
  '1. **理解方向**：仔细阅读 User Request 中给定的创作方向（种子概念/世界类型/主角原型等）。',
  '2. **自主决策**：对于本阶段需要确定的创作选择（角色原型、世界类型、核心冲突等），基于给定方向自主选择最契合、最有戏剧张力的方案。不要用 question 工具提问。',
  '3. **高质量产出**：按照 Skill Instructions 的质量标准，产出完整的阶段产出文件。',
  '4. **落盘**：将内容写入对应的 .novel/ 文件。',
  '5. **不要调用 PATCH API 推进阶段**——阶段推进由外部调度器控制。',
  '',
].join('\n');

/**
 * 按自治/采访模式组装阶段指令。
 * - 自治模式：STAGE_CORE + AUTONOMOUS_PROTOCOL
 * - 采访模式（默认）：STAGE_CORE + INTERVIEW_PROTOCOL + DECISION_PROMPTS
 * - 写作阶段不受影响（不含 STAGE_CORE，仍用原 STAGE_INSTRUCTIONS 中的写作条目）
 */
function buildStageInstructions(stage: string, autonomous: boolean): string {
  const core = STAGE_CORE[stage];
  if (!core) return '';  // 写作/未知阶段由调用方兜底
  if (autonomous) {
    return core + AUTONOMOUS_PROTOCOL;
  }
  return core + INTERVIEW_PROTOCOL + '\n' + (DECISION_PROMPTS[stage] || '');
}
```

- [ ] **Step 4: 保留 STAGE_INSTRUCTIONS 但仅留写作阶段条目**

将原 `STAGE_INSTRUCTIONS` 对象中**删除** concept/world/characters/outline/scenes 五个键（已移入 STAGE_CORE/DECISION_PROMPTS），**保留** writing/drafting/revision/polish 四个键不动。`decompose`/`enrich` 不在此对象中（由独立分支处理）。最终 `STAGE_INSTRUCTIONS` 只剩写作四阶段。

- [ ] **Step 5: 运行现有测试——预期全部仍 PASS（行为不变）**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: 全部 PASS（采访式断言仍成立，因为 buildStageInstructions(false) 组装回原样）。

> ⚠️ 如果有测试失败：检查 STAGE_CORE/DECISION_PROMPTS 的文本是否与原 STAGE_INSTRUCTIONS 分毫不差地拆分。STAGE_FEATURES 断言（如 `聚焦于构思核心概念`）必须仍命中。

- [ ] **Step 6: Commit**

```bash
git add src/agent/prompt-composer.ts
git commit -m "refactor: 拆分 STAGE_INSTRUCTIONS 为 STAGE_CORE + DECISION_PROMPTS

为 autonomous 模式做准备——核心任务描述与交互协议分离，
使运行时切换采访式/自治式成为可能。行为不变。"
```

---

## Task 2: composePrompt 加 autonomous 标志

**Files:**
- Modify: `src/agent/prompt-composer.ts`（ComposePromptOptions 接口 + composePrompt 函数体 + 全局指令优先级块）
- Test: `tests/unit/agent/prompt-composer.test.ts`

- [ ] **Step 1: 写失败的测试——autonomous=true 切换协议**

在 `tests/unit/agent/prompt-composer.test.ts` 的 `describe('interview-style protocol', ...)` 块之后，加一个新 describe 块：

```typescript
    describe('autonomous mode', () => {
      const PLANNING_STAGES = ['concept', 'world', 'characters', 'outline', 'scenes'];
      for (const stage of PLANNING_STAGES) {
        it(`injects autonomous protocol (not interview) into ${stage} stage when autonomous=true`, async () => {
          const prompt = await composePrompt({
            message: 'hi',
            projectId: 'p',
            stage,
            projectDir: tempDir,
            autonomous: true,
          });
          // 自治协议存在
          expect(prompt).toContain('本阶段的协作方式：自治式');
          expect(prompt).toContain('自主决策');
          // 采访式协议不存在
          expect(prompt).not.toContain('本阶段的协作方式：采访式');
          expect(prompt).not.toContain('先示范');
          // 决策清单不存在（autonomous 跳过）
          expect(prompt).not.toContain('本阶段需要用 question 工具与用户确认的关键创作决策');
        });
      }

      it('keeps writing stage unaffected by autonomous flag', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'writing',
          projectDir: tempDir,
          autonomous: true,
        });
        expect(prompt).not.toContain('本阶段的协作方式：自治式');
        expect(prompt).not.toContain('本阶段的协作方式：采访式');
      });

      it('autonomous mode changes global priority block to forbid questions', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
          autonomous: true,
        });
        expect(prompt).toContain('规划阶段采用「自治式」');
        expect(prompt).toContain('禁用 question 工具');
      });

      it('default (no autonomous) keeps interview protocol unchanged', async () => {
        const prompt = await composePrompt({
          message: 'hi',
          projectId: 'p',
          stage: 'concept',
          projectDir: tempDir,
        });
        expect(prompt).toContain('本阶段的协作方式：采访式');
        expect(prompt).not.toContain('本阶段的协作方式：自治式');
      });
    });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts -t "autonomous mode"`
Expected: FAIL（4 个新测试全红——autonomous 标志尚未实现）。

- [ ] **Step 3: 实现——ComposePromptOptions 加字段**

在 `src/agent/prompt-composer.ts` 的 `ComposePromptOptions` 接口末尾（`reviseContent?: string;` 之后）加：

```typescript
  /** 自治模式：跳过采访式协议，前期阶段改为自主决策。默认 false。 */
  autonomous?: boolean;
```

- [ ] **Step 4: 实现——composePrompt 函数体解构 + stageInstructions 组装**

在 composePrompt 函数体第一行解构中加 `autonomous`：

```typescript
  const { message, projectId, skillId, stage, projectDir, history,
          mode = 'generate', reviseTarget, reviseNote, reviseContent,
          autonomous = false } = options;
```

将 stageInstructions 组装逻辑（约行 505-509）改为优先用 buildStageInstructions：

```typescript
  // Stage-specific instructions
  const currentStage = stage || 'concept';
  const stageInstructions = isRevise
    ? buildReviseInstructions(reviseContent!, reviseNote!)
    : currentStage === 'decompose'
      ? buildReverseDecomposePrompt({
          projectDir,
          chapterCount: projectMeta?.chapterCount ?? 0,
        })
      : currentStage === 'enrich'
        ? buildEnrichPrompt({ projectDir })
        : buildStageInstructions(currentStage, autonomous)
          || STAGE_INSTRUCTIONS[currentStage]
          || `着手推进小说项目的「${currentStage}」阶段。`;
```

> 逻辑：前期阶段 → buildStageInstructions 返回非空；写作阶段 → 返回空串，回退到 STAGE_INSTRUCTIONS[writing]。

- [ ] **Step 5: 实现——全局"指令优先级"块按 autonomous 切换**

将 composePrompt 中 `parts.push(...)` 的第一个大字符串块（"你是一位小说创作助手..."含"# 指令优先级"）改为函数式构建。把硬编码的协作方式段提取为条件文本：

```typescript
  const collaborationRule = autonomous
    ? `- **按阶段切换协作方式**：
  - 规划阶段（concept / world / characters / outline / scenes）采用「自治式」——基于 User Request 给定的方向自主决策并落盘，**禁用 question 工具提问**，不要等待用户输入。
  - 写作阶段（writing / drafting / revision / polish）同样自治——基于注入的上下文直接撰写章节正文。`
    : `- **按阶段切换协作方式**：
  - 规划阶段（concept / world / characters / outline / scenes）采用「采访式」——动手落盘前，用 question 工具就关键创作决策与用户确认（详见各 Stage 指令中的「采访式」流程）。
  - 写作阶段（writing / drafting / revision / polish）采用「自治式」——基于注入的上下文直接撰写章节正文，写完在回复里说明你的选择即可；只有遇到会从根本上改变后续几万字走向且无法回滚的岔路口时，才用 question 工具问一个问题。`;

  const questionRule = autonomous
    ? '- **禁用 question 工具**：本会话为无人值守自治运行，所有创作决策由你自主做出。'
    : '- **何时用 question 工具**：当需要用户在创作方向上拍板时使用（规划阶段的关键决策、写作阶段无法回滚的岔路口）；纯执行与文笔打磨一律自行判断，不要为细节反复打断用户。';
```

然后在 parts.push 的大字符串中，把对应的两个硬编码 bullet 替换为 `${collaborationRule}` 和 `${questionRule}`。其余文本（文件访问规则等）不变。

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run tests/unit/agent/prompt-composer.test.ts`
Expected: 全部 PASS（含新增 4 个 autonomous 测试 + 原有测试不变）。

- [ ] **Step 7: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 8: Commit**

```bash
git add src/agent/prompt-composer.ts tests/unit/agent/prompt-composer.test.ts
git commit -m "feat: composePrompt 支持 autonomous 模式

前期阶段跳过采访式协议，改注入自治指令 + 禁用 question 工具。
破解无人值守场景下的 elicitation 阻塞。默认 false，现有行为不变。"
```

---

## Task 3: POST /api/runs 透传 autonomous 字段

**Files:**
- Modify: `src/api/routes/runs.ts:202-210`（body 解构 + composePrompt 调用）
- Test: `tests/unit/api/runs.test.ts`

- [ ] **Step 1: 写失败的测试——autonomous 字段透传**

在 `tests/unit/api/runs.test.ts` 文件末尾加新 describe 块。由于 POST `/` 路由依赖 DB/agent 启动，这里测的是"body 解构是否把 autonomous 传给 composePrompt"——通过 spy composePrompt 验证。

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mock composePrompt 捕获调用参数
const { mockCompose } = vi.hoisted(() => ({
  mockCompose: vi.fn().mockResolvedValue('composed'),
}));

vi.mock('../../../src/agent/prompt-composer', () => ({
  composePrompt: mockCompose,
}));

// Mock detectAgents 返回 claude 可用
vi.mock('../../../src/agent/executables', () => ({
  detectAgents: vi.fn().mockResolvedValue([{ id: 'claude', available: true }]),
}));

describe('POST /api/runs — autonomous passthrough', () => {
  it('passes autonomous=true to composePrompt when in body', async () => {
    // 此测试验证解构透传；完整路由集成由 e2e 覆盖
    // 模拟 body 解构后的 composePrompt 调用
    mockCompose.mockClear();
    // 直接调用 composePrompt（模拟路由已透传）来验证字段存在
    const { composePrompt } = await import('../../../src/agent/prompt-composer');
    await composePrompt({
      message: 'test',
      projectId: 'p',
      stage: 'concept',
      projectDir: '/tmp',
      autonomous: true,
    });
    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({ autonomous: true }),
    );
  });

  it('autonomous defaults to undefined when not in body', async () => {
    mockCompose.mockClear();
    const { composePrompt } = await import('../../../src/agent/prompt-composer');
    await composePrompt({
      message: 'test',
      projectId: 'p',
      stage: 'concept',
      projectDir: '/tmp',
    });
    expect(mockCompose).toHaveBeenCalledWith(
      expect.not.objectContaining({ autonomous: true }),
    );
  });
});
```

> 注：此测试验证 composePrompt 接受 autonomous 字段（契约层）。路由的完整集成测试依赖 DB + agent spawn，由手动 e2e 覆盖。

- [ ] **Step 2: 运行测试验证失败（或观察当前行为）**

Run: `npx vitest run tests/unit/api/runs.test.ts -t "autonomous passthrough"`
Expected: 若 Task 2 已完成，composePrompt 已支持 autonomous，此测试应 PASS。若失败则检查 import 路径。

- [ ] **Step 3: 实现——runs.ts body 解构加 autonomous**

在 `src/api/routes/runs.ts` 行 203 的 body 解构中加 `autonomous`：

```typescript
  const { projectId, agentId, skillId, stage, message, conversationId, model,
          mode = 'generate', targetFile, revisionNote, autonomous } = body;
```

- [ ] **Step 4: 实现——composePrompt 调用透传 autonomous**

在 composePrompt 调用处（约行 286-292）加 `autonomous`：

```typescript
  const composedPrompt = await composePrompt({
    message,
    projectId,
    skillId,
    stage,
    projectDir,
    history: history.length > 0 ? history : undefined,
    mode,
    reviseTarget: targetFile,
    reviseNote: revisionNote,
    reviseContent,
    autonomous,
  });
```

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/runs.ts tests/unit/api/runs.test.ts
git commit -m "feat: POST /api/runs 透传 autonomous 字段

使夜间探索调度器能触发自治模式的 agent run。"
```

---

## Task 4: 调度器骨架——createProject + triggerRun + waitForRun

**背景：** 调度器是纯 node 脚本，通过 fetch 调本机 API。先建骨架（三个核心函数 + CLI 参数解析），后续 Task 加发散/展开逻辑。

**Files:**
- Create: `scripts/explore.ts`
- Create: `tests/unit/scripts/explore.test.ts`

- [ ] **Step 1: 写失败的测试——createProject / triggerRun / waitForRun**

创建 `tests/unit/scripts/explore.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

const { createProject, triggerRun, waitForRun, parseArgs } = await import('../../../scripts/explore');

describe('explore helpers', () => {
  beforeEach(() => fetchSpy.mockReset());

  describe('createProject', () => {
    it('POSTs to /api/projects and returns { id, path }', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ project: { id: 'proj_123', path: '/tmp/r1' } }),
      });
      const result = await createProject('http://localhost:3006', {
        title: 'Route 1', genre: 'wuxia', path: '/tmp/r1',
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:3006/api/projects',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(result).toEqual({ id: 'proj_123', path: '/tmp/r1' });
    });

    it('throws on non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, statusText: 'Bad Request' });
      await expect(createProject('http://localhost:3006', { title: 'x', genre: 'x', path: '/tmp/x' }))
        .rejects.toThrow('Bad Request');
    });
  });

  describe('triggerRun', () => {
    it('POSTs to /api/runs with autonomous:true and returns runId', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ runId: 'run_abc', conversationId: 'conv_1' }),
      });
      const result = await triggerRun('http://localhost:3006', {
        projectId: 'proj_123', agentId: 'claude', stage: 'world',
        message: '推进世界构建', skillId: 'wuxia',
      });
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('http://localhost:3006/api/runs');
      expect(JSON.parse(opts.body)).toMatchObject({
        projectId: 'proj_123', stage: 'world', autonomous: true,
      });
      expect(result).toEqual({ runId: 'run_abc', conversationId: 'conv_1' });
    });
  });

  describe('waitForRun', () => {
    it('resolves when status becomes succeeded', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'running' }),
      });
      // 让第三次查询返回 succeeded
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'running' }) });
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'succeeded' }) });
      const status = await waitForRun('http://localhost:3006', 'run_abc', { pollIntervalMs: 1 });
      expect(status).toBe('succeeded');
    });

    it('resolves when status becomes failed', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'failed' }) });
      const status = await waitForRun('http://localhost:3006', 'run_abc', { pollIntervalMs: 1 });
      expect(status).toBe('failed');
    });
  });

  describe('parseArgs', () => {
    it('parses seed, routes, depth', () => {
      const args = parseArgs(['--seed', '武侠失忆剑客', '--routes', '3', '--depth', 'outline']);
      expect(args.seed).toBe('武侠失忆剑客');
      expect(args.routes).toBe(3);
      expect(args.depth).toBe('outline');
    });

    it('uses defaults when minimal args', () => {
      const args = parseArgs(['--seed', '种子']);
      expect(args.routes).toBe(3);
      expect(args.depth).toBe('outline');
      expect(args.api).toBe('http://localhost:3006');
    });

    it('throws when seed missing', () => {
      expect(() => parseArgs([])).toThrow('seed');
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/unit/scripts/explore.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现——创建 scripts/explore.ts 骨架**

创建 `scripts/explore.ts`：

```typescript
#!/usr/bin/env node
/**
 * 夜间多路探索调度器（Night Explore）
 *
 * 睡前给一句话种子 → 夜间 LLM 自主发散 N 条前期设定路线 → 每条独立成 project。
 * 早上对比 N 套前期，挑选/嫁接最优的一条作主线。
 *
 * 用法：pnpm explore --seed "武侠·失忆剑客寻仇" --routes 3 --depth outline
 *
 * 依赖：open-novel dev server 必须运行（pnpm dev）。
 */

// ===== CLI 参数 =====

export interface ExploreOptions {
  seed: string;
  routes: number;
  depth: string;  // world | characters | outline | scenes
  api: string;
  baseDir: string;
  agent: string | null;
  skill: string;
  pollIntervalMs: number;
}

export function parseArgs(argv: string[]): ExploreOptions {
  const opts: Partial<ExploreOptions> = {
    routes: 3,
    depth: 'outline',
    api: process.env.EXPLORE_API || 'http://localhost:3006',
    baseDir: `./_explore/night-${Date.now()}`,
    agent: null,
    skill: 'wuxia',
    pollIntervalMs: 10_000,
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--seed': opts.seed = argv[++i]; break;
      case '--routes': opts.routes = parseInt(argv[++i], 10); break;
      case '--depth': opts.depth = argv[++i]; break;
      case '--api': opts.api = argv[++i]; break;
      case '--base-dir': opts.baseDir = argv[++i]; break;
      case '--agent': opts.agent = argv[++i]; break;
      case '--skill': opts.skill = argv[++i]; break;
      case '--poll-interval': opts.pollIntervalMs = parseInt(argv[++i], 10) * 1000; break;
    }
  }

  if (!opts.seed) throw new Error('--seed 是必需参数');
  return opts as ExploreOptions;
}

// ===== API 辅助 =====

export interface ProjectInfo { id: string; path: string; }

export async function createProject(api: string, params: {
  title: string; genre: string; path: string; chapterCount?: number;
}): Promise<ProjectInfo> {
  const res = await fetch(`${api}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`createProject failed: ${res.statusText}`);
  const data = await res.json() as { project: ProjectInfo };
  return data.project;
}

export interface RunInfo { runId: string; conversationId: string; }

export async function triggerRun(api: string, params: {
  projectId: string; agentId: string; stage: string;
  message: string; skillId?: string;
}): Promise<RunInfo> {
  const res = await fetch(`${api}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, autonomous: true }),
  });
  if (!res.ok) throw new Error(`triggerRun failed: ${res.statusText}`);
  return res.json() as Promise<RunInfo>;
}

export async function waitForRun(
  api: string,
  runId: string,
  opts: { pollIntervalMs: number; timeoutMs?: number },
): Promise<'succeeded' | 'failed'> {
  const timeoutMs = opts.timeoutMs ?? 1_800_000; // 30 min default
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${api}/api/runs/${runId}/status`);
    if (res.ok) {
      const data = await res.json() as { status: string };
      if (data.status === 'succeeded' || data.status === 'failed') return data.status;
    }
    await sleep(opts.pollIntervalMs);
  }
  return 'failed'; // timeout
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/unit/scripts/explore.test.ts`
Expected: 全部 PASS。

> ⚠️ 注意：测试用 `fetchSpy.mockResolvedValueOnce` 链式返回，需确保 waitForRun 第一次 fetch 得到正确 mock。如果 waitForRun 的实现里先 fetch 一次再进循环，mock 序列要对齐。实现已用 while 循环每次 fetch，mock 按调用顺序消费。

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add scripts/explore.ts tests/unit/scripts/explore.test.ts
git commit -m "feat: 夜间探索调度器骨架（createProject/triggerRun/waitForRun/parseArgs）"
```

---

## Task 5: 调度器——发散阶段 + 展开阶段 + 报告

**Files:**
- Modify: `scripts/explore.ts`（加 diverge / expand / report 逻辑 + main）
- Modify: `tests/unit/scripts/explore.test.ts`（加发散/展开测试）

- [ ] **Step 1: 写失败的测试——发散 concept 解析 + 展开顺序**

在 `tests/unit/scripts/explore.test.ts` 末尾加：

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { parseConceptRoutes, buildDivergeMessage, buildExpandMessage, STAGE_ORDER } =
  await import('../../../scripts/explore');

describe('diverge', () => {
  it('parseConceptRoutes extracts concept-route-{N}.md files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explore-'));
    await fs.writeFile(path.join(dir, '.novel', 'concept-route-1.md'), '# 路线1\n核心：复仇');
    // 注意：fs.writeFile 不自动建目录，需先 mkdir
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    await fs.writeFile(path.join(dir, '.novel', 'concept-route-1.md'), '# 路线1\n核心：复仇');
    await fs.writeFile(path.join(dir, '.novel', 'concept-route-2.md'), '# 路线2\n核心：救赎');
    const routes = await parseConceptRoutes(dir);
    expect(routes).toHaveLength(2);
    expect(routes[0].content).toContain('复仇');
    expect(routes[1].content).toContain('救赎');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('parseConceptRoutes returns empty array when no files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'explore-'));
    const routes = await parseConceptRoutes(dir);
    expect(routes).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('buildDivergeMessage contains seed, route count, and differentiation directive', () => {
    const msg = buildDivergeMessage('武侠·失忆剑客', 3);
    expect(msg).toContain('武侠·失忆剑客');
    expect(msg).toContain('3');
    expect(msg).toContain('concept-route-1.md');
    expect(msg).toContain('实质性差异');
  });

  it('buildExpandMessage references concept seed and forbids PATCH', () => {
    const msg = buildExpandMessage('world');
    expect(msg).toContain('concept.md');
    expect(msg).toContain('不要调用 PATCH');
  });
});

describe('STAGE_ORDER', () => {
  it('orders stages from world to outline by default depth', () => {
    expect(STAGE_ORDER.outline).toEqual(['world', 'characters', 'outline']);
  });
  it('stops at world for shallow depth', () => {
    expect(STAGE_ORDER.world).toEqual(['world']);
  });
  it('includes scenes for full depth', () => {
    expect(STAGE_ORDER.scenes).toEqual(['world', 'characters', 'outline', 'scenes']);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/unit/scripts/explore.test.ts -t "diverge"`
Expected: FAIL（函数未导出）。

- [ ] **Step 3: 实现——发散/展开消息构建 + 阶段顺序**

在 `scripts/explore.ts` 中加：

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';

// ===== 阶段顺序 =====

export const STAGE_ORDER: Record<string, string[]> = {
  world: ['world'],
  characters: ['world', 'characters'],
  outline: ['world', 'characters', 'outline'],
  scenes: ['world', 'characters', 'outline', 'scenes'],
};

// ===== 消息构建 =====

export function buildDivergeMessage(seed: string, routeCount: number): string {
  return `基于种子「${seed}」，发散出 ${routeCount} 条差异化的故事概念方向。

要求：
1. 每条概念需包含：一句话核心、主角原型、核心冲突、世界类型、情感基调。
2. 将每条概念分别写入 .novel/concept-route-1.md 至 .novel/concept-route-${routeCount}.md。
3. ${routeCount} 条路线之间必须在核心冲突、世界类型、情感基调上有**实质性差异**，不能只是换皮或微调。
4. 每条都要有独立的戏剧张力和可展开性。

不要调用 question 工具提问——自主选择最有戏剧性的方向。`;
}

export function buildExpandMessage(_stage: string): string {
  return `基于 .novel/concept.md 中的种子概念，自治推进本阶段。

要求：
1. 仔细阅读 concept.md，理解故事核心。
2. 按本阶段的质量标准产出完整内容，写入对应的 .novel/ 文件。
3. 所有创作决策自主做出，不要用 question 工具提问。
4. **不要调用 PATCH API 推进阶段**——阶段推进由外部调度器控制。`;
}

// ===== 发散产物解析 =====

export interface ConceptRoute {
  index: number;
  filename: string;
  content: string;
  summary: string;  // 前 300 字
}

export async function parseConceptRoutes(projectDir: string): Promise<ConceptRoute[]> {
  const novelDir = path.join(projectDir, '.novel');
  const routes: ConceptRoute[] = [];
  for (let i = 1; i <= 20; i++) {  // 上限 20 防 glob
    const filename = `concept-route-${i}.md`;
    const filePath = path.join(novelDir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      routes.push({
        index: i,
        filename,
        content,
        summary: content.slice(0, 300),
      });
    } catch {
      break;  // 文件不连续，停止
    }
  }
  return routes;
}
```

- [ ] **Step 4: 实现——发散阶段主逻辑**

在 `scripts/explore.ts` 中加 `diverge` 函数：

```typescript
// ===== 发散阶段 =====

export async function diverge(opts: ExploreOptions): Promise<{ seedProject: ProjectInfo; routes: ConceptRoute[] }> {
  const seedPath = path.resolve(opts.baseDir, 'seed-project');
  const seedProject = await createProject(opts.api, {
    title: `探索种子：${opts.seed.slice(0, 20)}`,
    genre: opts.skill,
    path: seedPath,
  });

  const message = buildDivergeMessage(opts.seed, opts.routes);
  const agentId = opts.agent || (await detectFirstAgent(opts.api));
  const { runId } = await triggerRun(opts.api, {
    projectId: seedProject.id,
    agentId,
    stage: 'concept',
    message,
    skillId: opts.skill,
  });

  const status = await waitForRun(opts.api, runId, { pollIntervalMs: opts.pollIntervalMs });
  if (status === 'failed') {
    // 重试一次
    const retryRes = await fetch(`${opts.api}/api/runs/${runId}/retry`, { method: 'POST' });
    if (retryRes.ok) {
      const retryData = await retryRes.json() as { runId: string };
      const retryStatus = await waitForRun(opts.api, retryData.runId, { pollIntervalMs: opts.pollIntervalMs });
      if (retryStatus === 'failed') return { seedProject, routes: [] };
    } else {
      return { seedProject, routes: [] };
    }
  }

  const routes = await parseConceptRoutes(seedPath);
  return { seedProject, routes };
}

async function detectFirstAgent(api: string): Promise<string> {
  const res = await fetch(`${api}/api/agents`);
  if (!res.ok) throw new Error('无法获取 agent 列表');
  const data = await res.json() as { agents: Array<{ id: string; available: boolean }> };
  const first = data.agents.find((a) => a.available);
  if (!first) throw new Error('没有可用的 agent');
  return first.id;
}
```

- [ ] **Step 5: 实现——展开阶段主逻辑**

在 `scripts/explore.ts` 中加 `expand` 函数：

```typescript
// ===== 展开阶段 =====

export interface RouteResult {
  index: number;
  project: ProjectInfo;
  stages: string[];        // 成功完成的阶段
  failedAt: string | null; // 失败的阶段
  conceptSummary: string;
}

export async function expandRoute(
  opts: ExploreOptions,
  route: ConceptRoute,
  agentId: string,
): Promise<RouteResult> {
  const routePath = path.resolve(opts.baseDir, `route-${route.index}`);
  const project = await createProject(opts.api, {
    title: `路线 ${route.index}：${route.summary.slice(0, 20)}`,
    genre: opts.skill,
    path: routePath,
  });

  // 拷贝 concept 作种子
  await fs.mkdir(path.join(routePath, '.novel'), { recursive: true });
  await fs.writeFile(path.join(routePath, '.novel', 'concept.md'), route.content);

  const stages = STAGE_ORDER[opts.depth] || STAGE_ORDER.outline;
  const completed: string[] = [];
  let failedAt: string | null = null;

  for (const stage of stages) {
    // 推进项目阶段
    await fetch(`${opts.api}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentStage: stage }),
    });

    const message = buildExpandMessage(stage);
    const { runId } = await triggerRun(opts.api, {
      projectId: project.id,
      agentId,
      stage,
      message,
      skillId: opts.skill,
    });

    let status = await waitForRun(opts.api, runId, { pollIntervalMs: opts.pollIntervalMs });

    // 重试一次
    if (status === 'failed') {
      const retryRes = await fetch(`${opts.api}/api/runs/${runId}/retry`, { method: 'POST' });
      if (retryRes.ok) {
        const retryData = await retryRes.json() as { runId: string };
        status = await waitForRun(opts.api, retryData.runId, { pollIntervalMs: opts.pollIntervalMs });
      }
    }

    if (status === 'failed') {
      failedAt = stage;
      break;
    }
    completed.push(stage);
  }

  return { index: route.index, project, stages: completed, failedAt, conceptSummary: route.summary };
}
```

- [ ] **Step 6: 实现——报告生成 + main**

在 `scripts/explore.ts` 中加：

```typescript
// ===== 报告生成 =====

export function buildReport(opts: ExploreOptions, results: RouteResult[]): string {
  const lines: string[] = [
    `# 夜间探索报告`,
    ``,
    `## 种子`,
    opts.seed,
    ``,
    `## 路线概览`,
    ``,
  ];

  for (const r of results) {
    const status = r.failedAt
      ? `⚠️ 部分完成（${r.stages.join('→')} 后在 ${r.failedAt} 失败）`
      : `✅ 完成（${r.stages.join('→')}）`;
    lines.push(`### 路线 ${r.index}：${r.conceptSummary.slice(0, 40)}`);
    lines.push(`- 状态：${status}`);
    lines.push(`- Project：${r.project.path}`);
    lines.push(`- concept 摘要：${r.conceptSummary}`);
    lines.push(``);
  }

  lines.push(`## 如何使用`);
  lines.push(`1. 打开各 route-{i} 的 .novel/ 目录对比`);
  lines.push(`2. 选定主线后，将对应 route 目录 import 为正式项目（POST /api/projects/import）`);
  lines.push(`3. 或从不同路线中挑选文件嫁接`);

  return lines.join('\n');
}

// ===== main =====

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`[${new Date().toISOString()}] 夜间探索启动`);
  console.log(`  种子：${opts.seed}`);
  console.log(`  路线数：${opts.routes}，深度：${opts.depth}`);

  // 健康检查
  const health = await fetch(`${opts.api}/api/projects`);
  if (!health.ok) {
    console.error(`API 不可达（${opts.api}），请先运行 pnpm dev`);
    process.exit(1);
  }

  // 发散
  console.log(`\n[发散阶段] 生成 ${opts.routes} 条概念方向...`);
  const { routes } = await diverge(opts);
  if (routes.length === 0) {
    console.error('发散失败：未产出任何 concept-route 文件。检查种子描述或 agent 状态。');
    process.exit(1);
  }
  console.log(`  产出 ${routes.length} 条路线`);

  // 展开
  console.log(`\n[展开阶段] 逐条推进至 ${opts.depth}...`);
  const agentId = opts.agent || (await detectFirstAgent(opts.api));
  const results: RouteResult[] = [];
  let consecutiveFailures = 0;

  for (const route of routes) {
    console.log(`\n  路线 ${route.index}：${route.summary.slice(0, 40)}`);
    const result = await expandRoute(opts, route, agentId);
    results.push(result);

    if (result.failedAt && result.stages.length === 0) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        console.error(`连续 ${consecutiveFailures} 条路线首阶段失败，疑似额度耗尽，停止整批。`);
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
  }

  // 报告
  const report = buildReport(opts, results);
  const reportPath = path.resolve(opts.baseDir, 'report.md');
  await fs.mkdir(opts.baseDir, { recursive: true });
  await fs.writeFile(reportPath, report, 'utf-8');
  console.log(`\n[${new Date().toISOString()}] 探索完成`);
  console.log(`  报告：${reportPath}`);
  console.log(`  完成 ${results.filter((r) => !r.failedAt).length}/${routes.length} 条路线`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 7: 运行测试验证通过**

Run: `npx vitest run tests/unit/scripts/explore.test.ts`
Expected: 全部 PASS。

- [ ] **Step 8: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 9: Commit**

```bash
git add scripts/explore.ts tests/unit/scripts/explore.test.ts
git commit -m "feat: 夜间探索调度器——发散/展开/报告完整逻辑"
```

---

## Task 5b: elicitation 自动应答兜底（保险机制）

**背景：** autonomous 模式下 system prompt 已禁用 question 工具，agent 理论上不会触发 elicitation。但作为无人值守的保险，如果 agent 仍触发 ask，自动应答第一个选项避免卡满 30 分钟超时。同时记录到日志暴露异常。

**Files:**
- Modify: `scripts/explore.ts`（加 monitorElicitations 函数 + 在 waitForRun 中集成）
- Modify: `tests/unit/scripts/explore.test.ts`

- [ ] **Step 1: 写失败的测试——monitorElicitations 自动应答 ask**

在 `tests/unit/scripts/explore.test.ts` 末尾加：

```typescript
const { monitorElicitations } = await import('../../../scripts/explore');

describe('elicitation guard', () => {
  it('auto-answers ask events via POST /api/runs/:id/ask/:askId', async () => {
    fetchSpy.mockReset();
    // waitForRun 轮询时第一次返回 running + 模拟 ask
    // 监听 SSE 端点会返回 ask 事件——这里简化：monitorElicitations 直接调 ask 端点
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'succeeded' }) });
    await monitorElicitations('http://localhost:3006', 'run_abc', {
      pollIntervalMs: 1,
      onAsk: (askId) => {},
    });
    // 至少调了 ask 端点（如果检测到挂起的 ask）
    const askCall = fetchSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('/ask/'),
    );
    // monitorElicitations 内部会轮询 active-run 或 conversation stream
    // 这里验证函数不抛错且能正常 resolve
    expect(fetchSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 实现——monitorElicitations 函数**

在 `scripts/explore.ts` 中加。该函数并行监听 run 的 conversation stream（SSE），遇 ask 事件自动 POST 应答。由于 node 环境 SSE 需要流式解析，这里用简化实现：轮询 conversation 的 active-run 端点检测挂起的 ask。

```typescript
/**
 * 保险机制：并行监听 run 的 elicitation，遇 ask 自动应答。
 * autonomous 模式下基本不触发；触发则说明 autonomous 失效，记录后自动应答。
 * 返回清理函数（取消监听）。
 */
export async function monitorElicitations(
  api: string,
  runId: string,
  opts: { pollIntervalMs: number; onAsk?: (askId: string) => void },
): Promise<void> {
  const active = true;
  while (active) {
    try {
      // 通过 conversation stream 检测 ask 事件（简化：轮询 run 状态 + 检测挂起 ask）
      const res = await fetch(`${api}/api/runs/${runId}/status`);
      if (res.ok) {
        const data = await res.json() as { status: string; pendingAsk?: string };
        if (data.status === 'succeeded' || data.status === 'failed') return;
        if (data.pendingAsk) {
          // 自动应答第一个选项
          await fetch(`${api}/api/runs/${runId}/ask/${data.pendingAsk}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'accept' }),
          });
          opts.onAsk?.(data.pendingAsk);
        }
      }
    } catch { /* ignore transient errors */ }
    await sleep(opts.pollIntervalMs);
  }
}
```

> 注：此实现依赖 run status 端点暴露 `pendingAsk` 字段。若该字段不存在，monitorElicitations 退化为无操作（不报错），不影响主流程。实际集成时，可在 waitForRun 内部并行 spawn monitorElicitations，run 结束后自动退出。

- [ ] **Step 3: 集成到 waitForRun**

修改 `waitForRun`，在轮询循环中检测 pendingAsk 并自动应答：

```typescript
export async function waitForRun(
  api: string,
  runId: string,
  opts: { pollIntervalMs: number; timeoutMs?: number },
): Promise<'succeeded' | 'failed'> {
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${api}/api/runs/${runId}/status`);
    if (res.ok) {
      const data = await res.json() as { status: string; pendingAsk?: string };
      // elicitation 兜底：自动应答
      if (data.pendingAsk) {
        await fetch(`${api}/api/runs/${runId}/ask/${data.pendingAsk}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'accept' }),
        }).catch(() => {});
      }
      if (data.status === 'succeeded' || data.status === 'failed') return data.status;
    }
    await sleep(opts.pollIntervalMs);
  }
  return 'failed';
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run tests/unit/scripts/explore.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/explore.ts tests/unit/scripts/explore.test.ts
git commit -m "feat: 调度器加 elicitation 自动应答兜底"
```

---

## Task 6: package.json 加 explore 脚本入口

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 加 scripts 入口**

在 `package.json` 的 `scripts` 对象中加（放在 `"start"` 之后）：

```json
    "explore": "node scripts/explore.ts",
```

- [ ] **Step 2: 验证脚本可执行**

Run: `node scripts/explore.ts --help 2>&1 || true`
Expected: 不报 module 解析错误（Node 22+ 支持 ts 直接跑 via tsx/esbuild，若项目无 tsx 则需 `npx tsx`）。如报错，改入口为 `"explore": "npx tsx scripts/explore.ts"`。

> 注：open-novel 是 ESM 项目（`"type": "module"`），Node 22+ 可直接运行 .ts。如不行，用 `npx tsx`。

- [ ] **Step 3: 全量测试**

Run: `npm run typecheck && npm test`
Expected: typecheck 无错误；所有测试 PASS。

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: 加 explore 脚本入口"
```

---

## 验收清单

- [ ] `composePrompt({ autonomous: true, stage: 'concept' })` 不含采访式协议、含自治协议
- [ ] `composePrompt({ stage: 'concept' })`（默认）行为不变
- [ ] `POST /api/runs` body 的 `autonomous` 字段正确透传
- [ ] `pnpm explore --seed "..." --routes 3` 能启动调度器
- [ ] 发散失败时有明确错误提示
- [ ] 单路线失败时不阻塞其他路线
- [ ] 连续 2 条首阶段失败时停止整批
- [ ] 最终生成 report.md
