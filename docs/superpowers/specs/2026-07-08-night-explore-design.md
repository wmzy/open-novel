# 夜间多路探索（Night Explore）：自治模式下从种子发散多套前期设定

**日期**：2026-07-08
**状态**：设计中
**背景**：用户的 token plan 额度按 5 小时窗口重置，睡眠时段白白浪费。open-novel 已有完整的逐章写作流水线，但用户更需要的是利用夜间额度做**前期设定阶段的多路探索**——睡前给一句话种子，让 LLM 自主发散 N 条差异化的 concept / world / characters / outline 方向，各自独立成稿；早上对比、挑选或嫁接最优的一条作主线。问题在于 open-novel 的前期阶段（concept→scenes）强制采用「采访式」交互协议（`INTERVIEW_PROTOCOL`），要求 agent 用 question 工具就关键创作决策提问——无人值守时 agent 会卡在提问上直到 30 分钟超时，产出为零。

## 目标

- 睡前一句话种子 → 夜间 LLM 自主发散 N 条差异化路线 → 每条路线独立成 open-novel project（concept→world→characters→outline 串行自治）
- 早上获得 N 套完整前期设定 + 一份对比报告，人工挑选/嫁接最优的一条作主线
- 利用现有全部底座：逐章触发 API、写后质检（前期不触发）、失败重试、git 快照、上下文分层注入

## 非目标（YAGNI）

- 不做前端"多路对比"视图——用 report.md + 直接开多个 project 够用，验证价值后再说
- 不做自动嫁接/合并——人工挑文件复制更可控，合并是后期的事
- 不做 concept 阶段重跑——发散已产出 concept，展开阶段直接拷入作种子
- 不做正文连写（writing 阶段）——本设计聚焦前期设定；正文连写是已有能力，按需手动触发
- 不引入新的 agent 后端——复用现有 launchAgent + composePrompt + run 生命周期

## 核心矛盾与破解

### 矛盾

`prompt-composer.ts` 中，前期五阶段（concept/world/characters/outline/scenes）的 `STAGE_INSTRUCTIONS` 内联了 `INTERVIEW_PROTOCOL`（行 32-45），明文要求：

> 所有需要用户拍板的方向性选择都必须通过 question 工具提问，不要用纯文字列举选项让用户回复字母。

此外，composePrompt 全局"指令优先级"块（约行 479-502）也明确写：

> 规划阶段（concept / world / characters / outline / scenes）采用「采访式」——动手落盘前，用 question 工具就关键创作决策与用户确认。

无人值守时 agent 执行此指令 → 调 question 工具提问 → elicitation 挂起等待用户 → 无人应答 → 30 分钟超时 → 产出为零。这是夜间自动跑前期的致命阻塞。

### 破解：autonomous 模式（方案 B，已与用户确认）

给 `composePrompt` 加一个 `autonomous?: boolean` 标志（默认 false，不影响现有交互流程）。为 true 时：

1. **前期阶段的 `stageInstructions`**：跳过 `INTERVIEW_PROTOCOL` 和"需要用 question 工具与用户确认的关键创作决策"清单，改注入自治指令（见下文）。
2. **全局"指令优先级"块**：前期阶段的协作方式从"采访式"改为"自治式"。
3. **写作阶段**：本就自治，不受影响。

#### AUTONOMOUS_PROTOCOL（替代 INTERVIEW_PROTOCOL 的自治指令）

```
## 本阶段的协作方式：自治式
这是无人值守的自治运行。你不需要等待用户输入——所有创作决策由你自主做出。

流程：
1. **理解方向**：仔细阅读 User Request 中给定的创作方向（种子概念/世界类型/主角原型等）。
2. **自主决策**：对于本阶段需要确定的创作选择（角色原型、世界类型、核心冲突等），基于给定方向自主选择最契合、最有戏剧张力的方案。不要用 question 工具提问。
3. **高质量产出**：按照 Skill Instructions 的质量标准，产出完整的阶段产出文件。
4. **落盘**：将内容写入对应的 .novel/ 文件。
5. **不要调用 PATCH API 推进阶段**——阶段推进由外部调度器控制。
```

#### 实现策略（两种，推荐 A）

**策略 A：分离重构（推荐）**

将 `STAGE_INSTRUCTIONS` 拆为两部分：
- `STAGE_CORE[stage]`：每个阶段的核心任务描述 + 落盘指令（不含交互协议、不含决策清单）。
- 组装时根据 `autonomous` 标志拼接不同的协议头：
  - 非 autonomous：`STAGE_CORE[stage] + INTERVIEW_PROTOCOL + 决策清单`
  - autonomous：`STAGE_CORE[stage] + AUTONOMOUS_PROTOCOL`

优点：干净、可测、不依赖字符串替换。代价：需重构现有常量。

**策略 B：字符串替换（备选）**

保持 `STAGE_INSTRUCTIONS` 不变，autonomous=true 时对选出的字符串做 `replace(INTERVIEW_PROTOCOL.join('\n'), AUTONOMOUS_PROTOCOL.join('\n'))`。

优点：改动最小。缺点：脆弱（内联后字符串引用可能失效）。仅当重构成本被证明不可接受时使用。

> 具体实现方式由 writing-plans 阶段决定，本 spec 只约束行为契约。

## 设计

### 整体流程

```
睡前：pnpm explore --seed "武侠·失忆剑客寻仇" --routes 3 --depth outline

scripts/explore.ts 调度器（cron/手动启动，串行为默认）
  │
  ├─ 夜①发散阶段（diverge）
  │   ├─ 创建种子项目 seed-project（POST /api/projects）
  │   ├─ 触发 concept 阶段自治 run：
  │   │   message = "基于种子「{seed}」，发散出 {N} 条差异化的故事概念方向。
  │   │           每条概念需包含：一句话核心、主角原型、核心冲突、世界类型、情感基调。
  │   │           将每条概念分别写入 .novel/concept-route-{1..N}.md。
  │   │           N 条路线之间必须在核心冲突、世界类型、情感基调上有实质性差异，不能只是换皮。"
  │   ├─ 轮询 run status → succeeded/failed
  │   └─ 解析 .novel/concept-route-{1..N}.md，拿到 N 个方向
  │
  ├─ 夜②展开阶段（expand）
  │   对每个 concept-route-{i}.md：
  │   ├─ 创建路线项目 route-project-{i}（独立目录 + DB 记录，天然隔离）
  │   ├─ 将 concept-route-{i}.md 拷贝为 route-project-{i}/.novel/concept.md
  │   ├─ 按 --depth 串行触发自治 run：world → characters → outline (→ scenes)
  │   │   每阶段：POST /api/runs { autonomous:true, stage, message:"基于种子概念自治推进{stage}阶段" }
  │   │          监听 SSE → 遇 elicitation 自动应答（兜底） → 轮询 status
  │   └─ 单阶段失败：重试 1 次（POST /retry）；仍失败则标记该路线为「部分完成」并记录到达的阶段，跳到下一条
  │
  └─ 收尾：生成 _explore/report.md
      ├─ 各路线 project 路径
      ├─ 各阶段产出文件路径
      └─ concept.md 开头摘要（前 300 字）
```

### open-novel 改动（2 处，加标志、默认行为不变）

#### 1. `composePrompt` 加 autonomous 标志

**文件**：`src/agent/prompt-composer.ts`

- `ComposePromptOptions` 接口加 `autonomous?: boolean`。
- 函数体解构出 `autonomous`。
- 前期阶段（concept/world/characters/outline/scenes）的 `stageInstructions` 组装逻辑：autonomous=true 时用 `AUTONOMOUS_PROTOCOL` 替代 `INTERVIEW_PROTOCOL` + 决策清单。
- 全局"指令优先级"块：autonomous=true 时，前期阶段的协作方式描述从"采访式"改为"自治式"，并增加"禁用 question 工具提问"。
- 写作阶段不受影响（本就自治）。

#### 2. `POST /api/runs` 加 autonomous 字段

**文件**：`src/api/routes/runs.ts`

- body 解构加 `autonomous`。
- 透传给 `composePrompt({ ..., autonomous })`。

### scripts/explore.ts 调度器（新增）

**文件**：`scripts/explore.ts`

纯 node 脚本，通过 fetch 调用本机 open-novel API（默认 `http://localhost:3006`）。

#### CLI 接口

```bash
pnpm explore --seed "一句话种子" [选项]

选项：
  --routes <N>       发散路线数（默认 3）
  --depth <stage>    展开深度：world | characters | outline | scenes（默认 outline）
  --api <url>        API 地址（默认 http://localhost:3006）
  --base-dir <path>  路线项目根目录（默认 ./_explore/night-{timestamp}）
  --agent <id>       agent ID：claude | opencode | omp（默认自动检测首个可用）
  --skill <id>       插件技能 ID（默认 wuxia，可按种子类型扩展）
  --poll-interval <s> 轮询间隔秒数（默认 10）
```

#### 核心模块

1. **`createProject(title, genre)`** → 调 `POST /api/projects`，返回 `{ id, path }`。
2. **`triggerRun(projectId, stage, message, opts)`** → 调 `POST /api/runs { autonomous:true, ... }`，返回 `runId`。
3. **`waitForRun(runId)`** → 轮询 run status（或监听 conversation SSE），resolve 于 succeeded/failed。超时保护：单 run 最长 `AGENT_TIMEOUT_MS`（30 min）。
4. **`autoAnswerElicitations(runId)`** → 监听 SSE，遇 ask 事件自动 `POST /api/runs/:id/ask/:askId` 回 `{ action: 'accept' }`（选第一个选项）。自治模式下基本不触发，纯保险。
5. **`parseConceptRoutes(seedProjectPath)`** → 读 `.novel/concept-route-{1..N}.md`，返回方向数组。
6. **`generateReport(routes)`** → 写 `_explore/report.md`。

#### 阶段推进控制

展开阶段的每个 run 的 message 明确写"不要调用 PATCH API 推进阶段，调度器会控制"。run 完成后，脚本自己调 `PATCH /api/projects/{id} { currentStage: nextStage }` 推进，再触发下一阶段。这比依赖 agent 自调 PATCH 更可靠（agent 不总是可靠地调 API）。

### 错误处理与兜底

| 场景 | 处理 |
|---|---|
| elicitation 卡死 | 自动应答第一个选项（兜底）；自治模式下基本不触发 |
| 单阶段 run 失败 | 重试 1 次（`POST /api/runs/:id/retry`）；连续失败标记该路线失败，跳到下一条 |
| 额度耗尽 | 连续 2 条路线在首阶段（world）即失败 → 判定额度窗口耗尽，停止整批，报告已完成的路线 |
| 超时 | 每 run 受 `AGENT_TIMEOUT_MS`（30min）保护；脚本层额外设总时长上限（默认 5h，对应额度窗口） |
| 发散阶段产出不足 N 条 | 实际产出几个就展开几条，report.md 注明 |
| 发散阶段产出 0 条 | 重试发散 run 1 次；仍产出 0 条 → 退出并报告「发散失败，检查种子描述或 agent 状态」|
| API 不可达 | 启动时健康检查 `GET /api/projects`，失败则立即退出并提示 `pnpm dev` |

### 产出结构与对比报告

```
_explore/
  night-{timestamp}/
    report.md                    # 对比报告
    seed-project/                # 发散阶段的临时项目
      .novel/concept-route-1.md
      .novel/concept-route-2.md
      .novel/concept-route-3.md
    route-1/                     # 路线 1 的完整 project
      .novel/concept.md
      .novel/world-building.md
      .novel/characters/profiles.md
      .novel/outline-detailed.md
    route-2/
      ...
    route-3/
      ...
```

`report.md` 格式：

```markdown
# 夜间探索报告 {timestamp}

## 种子
{seed}

## 路线概览

### 路线 1：{从 concept-route-1.md 提取的一句话核心}
- 状态：✅ 完成（outline）/ ⚠️ 部分完成（characters 后失败）/ ❌ 失败
- Project：_explore/night-{ts}/route-1/
- concept 摘要：{前 300 字}

### 路线 2：...
### 路线 3：...

## 如何使用
1. 打开各 route-{i} 的 .novel/ 目录对比
2. 选定主线后，将对应 route 目录 import 为正式项目（POST /api/projects/import）
3. 或从不同路线中挑选文件嫁接
```

## 测试策略

### open-novel 改动

- **`composePrompt` 单测**（`tests/unit/agent/prompt-composer.test.ts`）：
  - autonomous=true + concept 阶段 → prompt 不含 INTERVIEW_PROTOCOL 文本（"采访式"、"question 工具"），含 AUTONOMOUS_PROTOCOL 文本（"自治式"、"自主决策"）。
  - autonomous=false + concept 阶段 → 现状不变（含 INTERVIEW_PROTOCOL）。
  - autonomous=true/false + writing 阶段 → 无差异（写作阶段本就自治）。
  - autonomous=true → 全局"指令优先级"块中前期协作方式为"自治式"。
- **`runs` API 测试**（`tests/unit/api/runs.test.ts`）：
  - POST body 带 `autonomous: true` → composePrompt 被调用时 options.autonomous === true。
  - POST body 不带 autonomous → options.autonomous 为 undefined/false，行为不变。

### scripts/explore.ts

- 发散文件解析：mock `.novel/concept-route-{1..N}.md` → 正确提取 N 个方向。
- 多 project 展开顺序：mock API，验证串行触发 world→characters→outline 的顺序与 PATCH 推进。
- elicitation 兜底：mock SSE ask 事件 → 自动 POST ask 端点。
- 失败重试：mock run status=failed → 触发 retry；连续失败 → 跳过该路线。

## 已知限制

| 问题 | 影响 | 临时方案 |
|---|---|---|
| 前期产出无质检门禁 | concept/world/outline 质量不可控（无 score 归档） | 早上人工审阅；report.md 摘要辅助快速判断 |
| 串行执行较慢 | N 条路线 × 4 阶段，单 run 可达数分钟 | 可改并行 2（受 agent 并发限制）；或减少 --depth |
| 发散方向可能不够差异 | LLM 可能产出 N 个"换皮"概念 | message 中强硬约束差异化维度；早上人工筛选 |
| state.json 在前期阶段不维护 | 前期阶段不触发 ensureContextArtifacts | 无影响（前期阶段不依赖 state） |

## 实现顺序建议

1. open-novel 改动（composePrompt + runs API + 测试）——这是地基，先验证 autonomous 模式可靠。
2. scripts/explore.ts 骨架（createProject + triggerRun + waitForRun）——先跑通单路线单阶段。
3. 发散阶段 + 多路线展开 + 报告生成。
4. 错误处理与兜底（elicitation、重试、额度耗尽检测）。
5. package.json 加 `explore` 脚本入口。
