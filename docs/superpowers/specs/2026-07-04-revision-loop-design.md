# 修订循环（Revision Loop）设计

> 日期：2026-07-04
> 状态：设计已与用户确认（方案 B 混合引擎）
> 动机：当前 run 模型只有「生成」语义，没有「基于已有产出修订」的 round-trip，导致：(1) 起名落俗套无法在第二轮纠正，(2) 角色脸谱化无法定向调整，(3) 整个写作流程退化成单轮生成器。真实写作是迭代的——写、读回来、定向改。

---

## 1. 背景与问题

### 1.1 现状

`POST /api/runs` 启动一个 agent 子进程，注入 composePrompt 组装的提示词（阶段指令 + 上下文层 + 用户消息），agent 从零生成文件，run 结束。同一对话的后续消息会带上 `history`，但**写作阶段的提示词始终是「生成全新」语义**——没有机制让 agent 在已有文件上做外科手术式修订。

### 1.2 三个症状的根因

| 症状 | 直接原因 | 共同根因 |
|------|----------|----------|
| 起名落俗套（沈/苏重复） | 起名工具无跨项目去重 | 无法在第二轮说「换掉这个姓」并可靠执行 |
| 角色脸谱化（三角同构） | concept SKILL 默认推经典三角 | 无法在第二轮说「师父换成话痨」并定向改 profiles |
| 单轮交互 | run 只有生成语义 | 架构上不存在「修订型 run」 |

### 1.3 关键洞察

用户的两个典型需求属于**两类完全不同的操作**：

- **语义修订**（「主角太冷，加温度」）→ 需要判断力 → agent
- **机械重命名**（「宋清改成林寒声」）→ 确定性字符串替换 → 不需要 agent

用 LLM 做确定性字符串替换是工程错误（慢、贵、会顺手改动周围文字）。用确定性引擎做语义修订不可能。两者必须分离。

---

## 2. 架构决策：方案 B 混合引擎

```
用户修订意图
     │
     ├─ 「重命名」─→ 确定性重命名引擎（§4）
     │                 · 预检（naming tool checkName）
     │                 · 精确全名替换
     │                 · 跨文件传播
     │                 · 零 agent 调用，瞬时完成
     │
     └─ 「修订内容」─→ 修订 run（§3）
                       · composePrompt mode=revise
                       · 注入目标文件全文 + 修订意见
                       · Edit 工具外科手术修改
                       · 质检管线照常运行
                       · 可选跨文件语义传播（批量单文件修订）
```

用户在 UI 上**显式二选一**选择模式，不做模糊自动分类（歧义是 bug 之源）。

---

## 3. 修订 run（语义层）

### 3.1 Run 模式扩展

`runs` 表新增两列（不新建表，避免 join 膨胀）：

```sql
ALTER TABLE runs ADD COLUMN mode    TEXT  NOT NULL DEFAULT 'generate';
ALTER TABLE runs ADD COLUMN payload JSONB;
```

`mode` 取值：
- `'generate'` — 现有行为，生成全新文件。`payload` 为 null。
- `'revise'` — 修订已有文件。`payload` 见下。
- `'rename'` — 确定性重命名操作记录。`payload` 见 §4。

`payload` 结构（mode='revise'）：

```typescript
interface RevisePayload {
  targetFile: string;        // 相对 projectDir 的路径，如 "chapters/第3章.md"
  revisionNote: string;      // 用户修订意见
  baseSnapshot: string;      // run 启动时的文件全文（内存中，用于 diff）
  diff?: string;             // close handler 中生成的 unified diff
}
```

### 3.2 Diff 来源：run-local 快照

**决策**：用 `payload.baseSnapshot`（run 启动时读入内存的文件全文），不依赖 git 历史。

**理由**：
- git `HEAD~1` 在并发或穿插 run 时不可靠（另一个 run 可能在中间提交了快照）
- run-local 快照是 O(1) 确定的——run 启动那一刻的文件状态，不可能被其他操作影响
- 代价是几 KB 内存，可忽略

### 3.3 composePrompt 的 revise 模式

`ComposePromptOptions` 新增字段：

```typescript
export interface ComposePromptOptions {
  message: string;
  projectId: string;
  skillId?: string;
  stage?: string;
  projectDir: string;
  history?: { role: string; content: string }[];
  // 新增
  mode?: 'generate' | 'revise';
  reviseTarget?: string;      // 目标文件相对路径
  reviseNote?: string;        // 修订意见
  reviseContent?: string;     // 目标文件当前全文
}
```

`mode='revise'` 时的提示词组装路径：

| 层 | generate 模式 | revise 模式 |
|----|--------------|-------------|
| 角色设定 | ✅ "你是一位小说创作助手" | ✅ 同 |
| 指令优先级 | ✅ 同 | ✅ 同 |
| 阶段指令 (STAGE_INSTRUCTIONS) | ✅ 按 stage 注入 | ❌ 不注入（修订跨阶段） |
| 阶段不匹配检测 | ✅ | ❌ 不注入 |
| 字数目标 | ✅（writing 阶段） | ✅（仅目标是章节时） |
| **修订指令 (REVISE_INSTRUCTIONS)** | ❌ | ✅ 替代阶段指令 |
| **目标文件全文** | ❌ | ✅ 注入 |
| **修订意见** | 用户 message | ✅ 注入（从 message 或 reviseNote） |
| 核心设定层 | ✅（writing 阶段） | ✅（目标是章节时注入，保持连续性判断） |
| 滚动摘要层 | ✅（writing 阶段） | ✅（目标是章节时注入最近 3 章摘要） |
| 活跃伏笔层 | ✅（writing 阶段） | ❌ 不注入（修订不需要埋伏笔提醒） |
| 工具指令 | ✅ | ✅ 同（强调用 Edit 而非 Write） |
| 输出格式 | ✅ | ✅ 同 |
| SKILL 指令 | ✅ | ❌ 不注入（SKILL 是生成导向的） |
| 对话历史 | ✅ | ✅ 同 |

### 3.4 REVISE_INSTRUCTIONS

```typescript
const REVISE_INSTRUCTIONS = `## 当前任务：修订已有内容

你不是在从零创作，而是在对一份已有的文件做**定向修订**。

### 目标文件
以下是你需要修订的文件全文（已读入上下文，无需再 Read）：

\`\`\`
{{TARGET_FILE_CONTENT}}
\`\`\`

### 修订意见
{{REVISION_NOTE}}

### 修订规则（严格遵守）

1. **必须用 Edit 工具做外科手术修改**——只改动与修订意见直接相关的段落，其余原封不动。
2. **禁止重写整篇**——如果你的改动会超过文件 30% 的内容，停下来在回复里说明原因，建议用户将修订拆分为多次。
3. **保留原文风格**——修订是定向调整，不是风格重写。不要"顺手"优化你没被要求改的句子。
4. **保存到原文件**——用 Write 工具将修改后的完整文件保存回原路径。Write 前确保文件已被 Read（系统会自动处理）。
5. **简短说明**——在回复中用 2-3 句话说明你改了什么、为什么，便于用户判断是否符合预期。`;
```

### 3.5 质检管线

修订 run 的 close handler 中，质检管线照常运行（与 generate 模式相同）：

- `qualityGateCheck`：退化检测、AI 味检测、元叙事泄漏检测
- `wordCountCheck`：字数偏差检测（仅目标是章节时）
- `ensureContextArtifacts`：补全摘要和状态表（仅目标是章节时）

**额外**：生成 diff 并存入 `payload.diff`，emit `revision-applied` 事件。

### 3.6 跨文件语义传播

「让宋清在所有出场章节都更冷」= 批量单文件修订：

1. 后端扫描 `.novel/chapters/*.md`，找包含目标角色名的文件列表。
2. 对每个文件起**独立 revise run**（各自 runId、各自 baseSnapshot、各自 diff）。
3. 前端显示进度「修订 3/8 文件…」。
4. **启动前必须确认**：成本提示「这将在 8 个文件上各执行一次 agent 调用，预计 ~3 分钟」。

**不合并成一次大 run**——一次 agent 调用改 8 个文件会导致注意力稀释、风格漂移。独立 run 各自聚焦，质量更高。

API：`POST /api/runs` body 增加 `propagateTo?: string[]`（文件路径数组）。后端顺序执行（不并发，避免额度冲击），每完成一个 emit 进度事件。

---

## 4. 重命名引擎（机械层）

### 4.1 端点

`POST /api/projects/:projectId/rename`

```typescript
// Request
interface RenameRequest {
  oldName: string;        // 旧名（精确全名，如 "宋清"）
  newName: string;        // 新名
  scope?: string[];       // 限定文件路径数组；省略 = 全项目
}

// Response 200
interface RenameResponse {
  filesModified: number;
  totalReplacements: number;
  snapshot: string;       // git 快照 commit hash
  newNameValid: boolean;
}

// Response 409（预检失败）
interface RenameConflict {
  error: 'precheck_failed';
  warnings: NameWarning[];          // 来自 naming tool checkName
  substringConflicts?: string[];    // oldName 是其他全名子串的情况
}
```

### 4.2 流程

```
1. 预检 checkName(newName)
   ├─ 有谐音/碰撞/生僻警告 → 409 + 警告列表（要求用户确认或换名）
   └─ 通过 → 继续

2. 子串消歧扫描
   · 扫描 profiles.md 提取所有人名
   · 找出包含 oldName 为子串的其他全名（如 oldName="沈" 会命中 "宋江"）
   ├─ 存在子串冲突 → 409 + 要求用户改用全名
   └─ 无冲突 → 继续

3. 扫描替换
   · 遍历 scope（默认 .novel/**/*.md + state.json + foreshadow.json + outline-meta.json）
   · 对每个文件做 String.prototype.replaceAll(oldName, newName)
   · 记录每文件替换数

4. 结构化同步
   · state.json: characters[].name 字段
   · foreshadow.json: content / 角色引用
   · outline-meta.json: POV 标签
   · 同样 replaceAll（这些是 JSON 文件，replaceAll 安全）

5. git 快照
   · createSnapshot(projectDir, "rename: ${oldName}→${newName}, ${N} files")

6. 返回
   · { filesModified, totalReplacements, snapshot, newNameValid: true }
   · 同步执行（<500ms），走 syncFilesToDb 回写章节记录
```

### 4.3 设计约束

- **只替换精确全名**，不替换单姓或单名。CJK 无词边界，模糊替换是 bug 之源。
- **不进 agent 流水线**：无 watchdog、无 quality gate、无字数检查。确定性操作不需要质量监控。但仍走 git 快照保证可回滚。
- **预检与 naming tool 闭环**：换名前先验名，复用 `checkName` 的全部 5 维校验（谐音/碰撞/语音/相似/生僻）。

---

## 5. Diff 呈现

### 5.1 后端

- revise run 启动时：读 `targetFile` 全文存入 `payload.baseSnapshot`（内存）。
- close handler 中：读修改后内容，调 `diff.createPatch()` 生成 unified diff。
- 存入 `payload.diff`，emit `revision-applied` 事件携带 diff 摘要 `{ addedLines, removedLines, targetFile }`。
- 依赖：`diff` npm 包（~15KB，Node.js 生态标准库）。

### 5.2 前端

- `useRun` 新增事件类型 `revision-applied` → 在 message 上挂 `revisionDiff` 字段。
- ChatPanel 消息气泡底部显示可折叠「修订差异」面板：
  - unified diff 渲染：`+` 绿、`-` 红、上下文灰色。
  - 大 diff（>200 行）折叠，默认只显示前 50 行 +「展开全部」按钮。
- rename 操作不显示逐行 diff（文件太多）→ 显示「N 文件 · M 处替换」摘要卡片。

### 5.3 组件结构

新增 `RevisionDiffPanel.tsx`（Linaria styled，与 QualityCheckPanel 风格一致）：
- Props: `{ diff: string; targetFile: string; addedLines: number; removedLines: number }`
- 折叠态：一行摘要「第3章.md · +12 -8」
- 展开态：unified diff 渲染，语法高亮

---

## 6. 前端入口

### 6.1 统一修订弹窗

每个产物视图（ChapterView / CharacterView / OutlineView / WorldView / ScenesView）加「修订」按钮，打开统一修订弹窗 `RevisionDialog.tsx`：

```
┌─ 修订 · 第3章.md ──────────────────────┐
│                                        │
│  模式：[ 修订内容 ] [ 重命名 ]          │
│                                        │
│  ── 修订内容模式 ──                     │
│  修订意见：                             │
│  ┌────────────────────────────────┐    │
│  │ 主角太冷，加一场与师父的温情戏    │    │
│  └────────────────────────────────┘    │
│  ☐ 同步到其他引用此角色的章节 (8)      │
│                                        │
│  ── 重命名模式 ──                       │
│  旧名：宋清（自动检测）               │
│  新名：[_______________]  [校验]        │
│  ☐ 仅当前文件  ☑ 全项目 (12 文件)      │
│                                        │
│         [ 取消 ]  [ 执行修订 ]          │
└────────────────────────────────────────┘
```

- **模式切换**：UI 显式二选一，不做自动分类。
- **重命名模式**：新名输入框失焦时调 `checkName` 预检，警告内联显示。
- **重命名 scope**：默认全项目，可选仅当前文件。
- **修订模式**：输入修订意见，可选勾选「同步到其他引用此角色的章节」触发跨文件语义传播。

### 6.2 API 调用

- 修订内容 → `POST /api/runs` body `{ mode: 'revise', targetFile, revisionNote, propagateTo? }`
- 重命名 → `POST /api/projects/:id/rename` body `{ oldName, newName, scope? }`

### 6.3 修订历史

同一文件的多次修订，通过 `runs` 表查询：
```sql
SELECT * FROM runs
WHERE mode = 'revise'
  AND payload->>'targetFile' = 'chapters/第3章.md'
ORDER BY created_at DESC;
```
前端可选展示「修订历史」时间线（v1 不做，留接口）。

---

## 7. 30% 重写阈值

REVISE_INSTRUCTIONS 规则 2：「禁止重写整篇——如果你的改动会超过文件 30% 的内容，停下来在回复里说明原因」。

- **判定方式**：agent 自行判断（不在后端做行数检测——agent 的主观判断比机械行数统计更合理，因为有些修订确实需要大改）。
- **阈值选择**：30% 是平衡点——低了会卡住合理的结构性修订，高了等于放任重写。
- **兜底**：即使 agent 超过 30% 仍完成了修改，质检管线照常运行，diff 也会完整呈现，用户可以回滚（git 快照）。

---

## 8. 不做的事（YAGNI）

- **不做修订历史时间线 UI**（v1 留 SQL 接口，不画 UI）
- **不做自动模式分类**（UI 显式二选一）
- **不做模糊替换**（只替换精确全名）
- **不做修订模板/快捷指令**（用户自由输入修订意见）
- **不把 revision 升格为项目阶段**（它是横切操作，不是阶段）
- **不做并发跨文件传播**（顺序执行避免额度冲击）

---

## 9. 测试策略

### 9.1 后端单元测试

- `composePrompt` revise 模式：验证不注入阶段指令、注入目标文件全文、注入 REVISE_INSTRUCTIONS。
- 重命名引擎：预检失败/通过、子串冲突检测、精确替换、跨文件传播、JSON 同步。
- run close handler：mode=revise 时生成 diff、emit revision-applied 事件。
- 30% 阈值：agent 行为测试（模拟 agent 回复，验证是否在超阈值时停下报告）—— 这条是 agent 行为，不做硬断言，只做集成 smoke test。

### 9.2 前端组件测试

- RevisionDiffPanel：diff 渲染、折叠/展开、大 diff 截断。
- RevisionDialog：模式切换、预检警告显示、API 调用参数正确。

### 9.3 E2E

- 真实场景：写第 3 章 → 修订（「主角太冷加温度」）→ 验证 diff 非空、文件被修改、质检通过。
- 重命名场景：创建角色 → 重命名 → 验证全项目替换、无残留旧名。

---

## 10. 实施顺序

1. **数据模型**：runs 表加 mode/payload 列 + 迁移
2. **重命名引擎**：`src/api/routes/rename.ts` + naming tool checkName 复用
3. **composePrompt revise 模式**：REVISE_INSTRUCTIONS + 上下文层裁剪
4. **run close handler 扩展**：revise 模式生成 diff、emit revision-applied
5. **diff 依赖**：安装 `diff` 包 + diff 生成工具函数
6. **前端 RevisionDiffPanel**：diff 渲染组件
7. **前端 RevisionDialog**：统一修订弹窗 + 各视图接入
8. **跨文件语义传播**：批量 revise run + 进度事件
9. **测试**：单元 + E2E
