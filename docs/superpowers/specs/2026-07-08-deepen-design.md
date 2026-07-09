# 单阶段深度迭代（Deepen）设计

> 日期：2026-07-08
> 状态：设计已批准（含调研优化），待写实现计划
> 前置：night-explore 的 autonomous 模式已实现（composePrompt 支持 `autonomous` 标志，runs API 透传）
> 调研依据：Self-Refine (NeurIPS 2023)、R2-Write (ICML)、Semantic Early-Stopping / GainNet 停止策略研究

## 问题

现有 explore 设计是"多路发散→快速推进 N 个阶段"，产出一部快速但无价值的小说。用户真正需要的是：**在一个阶段（如角色）反复打磨到极致**，根据概念和世界观持续补充完善角色，一晚上或数个晚上都做这一件事。

快速吐出一部无价值的小说没有意义；做深做极致才有意义。

## 目标

让用户从某个视图（如角色页）点一个按钮，设定截止时间后离开。AI 在该阶段自主循环深化——每轮按结构化维度评分，验证→回溯→修订，记录量化的改进轨迹。到点、手动中断或饱和检测触发时停止。

## 调研依据

业界自我精炼（self-refinement）最佳实践，三项核心研究直接相关：

- **Self-Refine (NeurIPS 2023)**：多维度结构化评分远优于泛泛「找薄弱点」。反馈必须可操作（actionable）：含问题定位 + 改进指令。收益通常 2-3 轮后大幅递减。
- **R2-Write (ICML)**：专为开放式写作设计。核心发现——深度推理在数学任务提升 +200%，但写作任务仅提升 +0.3-1.2%，原因是写作任务缺少**验证**（Verification）和**回溯**（Backtracking）思维模式。解决方案：writer-judge 循环，每轮先反思（自然语言，避免机械公式化）再重写。
- **停止策略研究**：Semantic Early-Stopping（连续 K 轮语义不变即停，省 38% token）和 GainNet（增益预测器，省 60-70% 计算保持 96-99% 质量）。Agent Self-Review 经验值 MAX_ROUNDS=3。

基于以上，本设计在原始「累积反思循环」上做了 4 个优化（详见下文各节）。

## 设计

### 核心机制：结构化反思循环

每轮 agent 做同一阶段的同一批文件（如反复打磨 `.novel/characters/profiles.md`），不推进阶段。维护 `.novel/deepen-log.md` 记录每轮改进，避免重复，早上用户可看轨迹。

与原始「泛泛找薄弱点」不同，每轮 agent 按**该阶段的结构化维度**自评打分（1-5），找到最低分维度，经**验证→回溯→修订**思维路径针对性补强。

```
点 🔁 深化 → 弹框输截止时间（默认06:00）→ 确认
  → 第1轮 autonomous run（message 引导按维度评分→验证→回溯→修订）
  → run 完成（SSE 'end' 事件）→ 检查时间/饱和信号
  → 第2轮 autonomous run（带轮数+维度评分历史）
  → ...
  → 到点 / 饱和 / 用户发消息 / 点停止 / 关页面 → 循环中断
```

### 触发方式

各视图页面加 🔁 深化按钮（与现有 ✎修订 / ⇄重命名 / 💡灵感 并列）。点击后 dispatch `DEEPEN_TO_CHAT_EVENT`，携带 `stage`（从视图上下文获取），ChatPanel 监听后弹出截止时间输入框。

**stage 来源**：视图自带的 stage（CharacterView → 'characters'，WorldView → 'world'），通过 CustomEvent 传递。与现有修订按钮（`REVISE_TO_CHAT_EVENT`）完全一致的模式。

**上下文自动获取**（零参数）：project / skill / agent 从会话状态拿，截止时间弹框输入。

### 停止机制（四重）

1. **定时**：每轮开始前检查 `Date.now()` 是否超过截止时间，到点优雅退出
2. **手动中断**：用户发任何消息（自然中断循环）、点停止按钮（现有 UI）、关闭页面
3. **连续失败保护**：连续 2 轮 run 失败（疑似额度耗尽）自动停止
4. **饱和检测**：agent 在 deepen-log 中写「各维度已达 4+ 分，无明显可改进项」时，前端检测到此信号后提前优雅退出——避免低效空转（Semantic Early-Stopping 思想）

### 结构化维度（优化 1：来自 Self-Refine + R2-Write）

每个阶段定义自己的质量维度。agent 每轮按维度自评 1-5 分，找到最低分维度针对性补强。

```typescript
const DEEPEN_DIMENSIONS: Record<string, string[]> = {
  characters: [
    '动机清晰度：每个主要角色的驱动力三角（外在目标/内在需求/核心缺陷）是否具体、独特？',
    '关系丰富度：角色间关系是否有层次（对立/同盟/暧昧/转变）？',
    '弧光完整性：主角是否有清晰的变化轨迹（起点→转折→终点）？',
    '差异化程度：角色声音/行事风格是否可区分，避免千人一面？',
    '功能性覆盖：是否缺少叙事必需的功能性角色（导师/镜像/催化剂）？',
  ],
  world: [
    '体系自洽性：力量/社会/经济体系内部是否有矛盾？',
    '历史纵深：世界是否有可信的历史背景和因果链？',
    '文化丰富度：不同地域/阶层是否有差异化的文化特征？',
    '冲突潜力：世界设定是否孕育了多种潜在冲突源？',
    '感官沉浸：环境描写是否有视听嗅味触的多感官细节？',
  ],
  outline: [
    '三幕结构：起承转合是否清晰、节奏是否合理？',
    '因果链紧密度：事件之间是否有因果驱动而非巧合？',
    '伏笔密度：埋设与回收是否成对且分布合理？',
    '情感节奏：高低潮交替是否张弛有度？',
    '主题贯穿：核心主题是否在各幕中得到递进体现？',
  ],
  scenes: [
    '场景目的性：每个场景是否推进了情节或揭示了角色？',
    '主动被动交替：Scene/Sequel 是否合理交替？',
    '冲突烈度：场景内冲突是否有升级和转折？',
    '感官落地：场景是否有具体的感官细节而非纯对话？',
    '信息节制：是否避免了信息倾泻（info-dump）？',
  ],
  concept: [
    '核心冲突锐度：故事的核心矛盾是否清晰、有力？',
    '主题深度：道德前提是否有探讨价值，非说教？',
    '独特性：概念是否有区别于同类作品的差异化点？',
    '情感钩子：开头是否能抓住读者情感？',
    '可展开性：概念是否支撑长篇叙事的体量？',
  ],
};
```

### 每轮 message 构造

由前端 `buildDeepenMessage(stage, round, dimensions)` 函数生成。融合三个优化点：

```
你在做「<stage>」阶段的深化打磨，这是第 <round> 轮迭代。

## 评估维度
<列出该阶段的维度清单>

## 流程（验证→回溯→修订）
1. 读取当前阶段的产出文件
2. 读取 .novel/deepen-log.md 了解前几轮的评分和改进历史
3. **验证**：逐维度检查当前产出是否满足质量标准，给每个维度打 1-5 分
4. **回溯**：对最低分维度，分析根因（是缺少信息？逻辑断裂？还是深度不够？）
5. **修订**：针对根因做具体补充，而非表面润色
6. 修改完后在 .novel/deepen-log.md 追加本轮记录（格式见下）
7. 不要用 question 工具提问，不要推进到下一阶段

## 饱和信号
如果本轮评估后发现所有维度已达 4 分以上，且没有明显可改进项，
在 deepen-log 本轮记录中写明「各维度已达 4+ 分，无明显可改进项」，
系统将自动停止循环。
```

**设计要点**（来自调研）：
- **结构化维度评分**（优化 1）：比泛泛「找薄弱点」精确得多，agent 有明确的评估框架
- **验证→回溯思维引导**（优化 2）：触发 R2-Write 证明写作质量最依赖的两种思维模式
- **饱和信号**（优化 3）：Semantic Early-Stopping 思想，避免低效空转

### deepen-log.md 结构

存在项目 `.novel/` 下。每轮 agent 追加记录。**含维度评分快照**（优化 4），让 agent 和用户都能看到量化进步轨迹：

```markdown
# 深化日志

## 第1轮
**维度评分**：动机清晰度 3→4, 关系丰富度 2→3, 弧光完整性 4→4, 差异化程度 3→3, 功能性覆盖 4→4
- 发现：角色关系层次不足（2分），缺少暧昧/转变关系
- 改进：增加师徒间的理念分歧——表面和睦暗藏对立
- 下轮建议：差异化声音仍可加强（3分），角色行事风格不够鲜明

## 第2轮
**维度评分**：动机清晰度 4→5, 关系丰富度 3→4, 弧光完整性 4→4, 差异化程度 3→4, 功能性覆盖 4→4
- 发现：动机仍可深化（4分），主角执念缺少具体的失去代价
- 改进：补充因执念导致的关键人际关系断裂场景
- 下轮建议：弧光和功能性已达 4 分，主要差距在差异化声音

## 第3轮
**维度评分**：动机 5, 关系 4, 弧光 4, 差异化 4, 功能性 4
- 发现：各维度已达 4+ 分，无明显可改进项
[饱和信号：各维度已达 4+ 分，无明显可改进项]
```

第 3 轮触发饱和信号，前端检测后自动停止循环。

**维度评分快照**的价值（优化 4）：
- agent 读历史评分知道「哪些已在改善」，避免重复关注同一维度
- 用户早上看到量化进步曲线（如动机 3→4→5），而非模糊的自由文本
- 饱和检测有量化依据（全 4+ 分）而非主观判断

### 退出时

- 退出原因（到点/手动/连续失败）打印到 ChatPanel
- deepen-log.md 即是改进记录，无需额外报告文件
- 循环期间 ChatPanel 显示状态指示（如"🔁 深化中 · 第 N 轮 · 截止 06:00"）

## 改动范围

### 前端

1. **`src/web/components/ChatPanel.tsx`**
   - 监听 `DEEPEN_TO_CHAT_EVENT`，收到后弹出截止时间输入框（小型 modal/inline）
   - 加 deepenMode 状态：`{ active: boolean, stage: string, deadline: number, round: number }`
   - 进入 deepenMode 时发第1轮，run 完成后（SSE 'end'）检查时间并续轮
   - 用户发消息时退出 deepenMode（手动中断）
   - 状态指示条（类似现有 pendingRevise 横幅）

2. **`src/web/hooks/useRun.ts`**
   - `sendMessage` 已支持 `autonomous` 字段（night-explore 已加）
   - 加 deepenMode 相关状态管理：或在 useRun 内、或在 ChatPanel 内（实现时定）
   - run 完成后的续轮逻辑：监听 `isRunning` 从 true→false 的转换

3. **视图按钮**（5 个文件，每个加一个按钮 + dispatch 事件）
   - `src/web/components/views/ConceptView.tsx`（stage: 'concept'）
   - `src/web/components/views/WorldView.tsx`（stage: 'world'）
   - `src/web/components/views/CharacterView.tsx`（stage: 'characters'）
   - `src/web/components/views/OutlineView.tsx`（stage: 'outline'，需补 useFileRevision 或直接 dispatch）
   - `src/web/components/views/SceneView.tsx`（stage: 'scenes'，同上）
   - WritingView 不需要深化（写作阶段已有自动重试和质量检查机制）

4. **`src/shared/deepen.ts`（新建）**
   - `DEEPEN_TO_CHAT_EVENT` 常量
   - `DeepenToChatDetail` 类型
   - `DEEPEN_DIMENSIONS` 常量（各阶段的结构化质量维度）
   - `SATURATION_SIGNAL` 常量（饱和检测标记字符串）
   - `buildDeepenMessage(stage: string, round: number): string`
   - `detectSaturation(logContent: string): boolean`（检测饱和信号）

### 后端

**零改动。** autonomous 模式、`POST /api/runs` 透传、`GET /:id/status` 端点在 night-explore 中已完成。深化循环完全由前端驱动——每轮就是一个普通的 autonomous run。

### 与现有 explore 的关系

- CLI 的 diverge 模式（多路发散）保留——仍有使用价值
- `/explore` slash 命令保留现有行为（单次 autonomous run）
- 深化功能**不依赖** CLI 脚本，是纯前端 ChatPanel 驱动的循环
- explore 的核心定位转向"深度迭代"，多路发散降为次要功能

## 已知限制

- **维度评分是 agent 自评**：无外部 judge 校验，存在自偏风险（Self-Refine 论文指出的局限）。但本场景是创作深化而非事实核查，agent 自评 + 结构化维度已将偏差降到可接受范围。后续可加独立 judge 轮做外部校验
- **deepen-log 膨胀**：长时间运行日志会增长。当前不自动截断（轮数有限，每轮记录短）；饱和检测和定时停止双重保证不会无限增长
- **单 conversation 累积**：所有轮次在同一 conversation 内，上下文窗口可能被历史填满。autonomous 模式下 agent 每轮独立读文件而非依赖对话历史，影响可控
- **并发不安全**：同时开多个 deepen 循环（不同视图）会互相干扰——同一项目的同一批文件。当前不支持并发，进入 deepenMode 时若已有活跃循环则拒绝
- **关页面即停**：循环状态不持久化。刷新/关页面后需手动重启。这是设计选择——deepen-log 记录了已完成的工作（含评分快照），重启不会丢失成果
- **维度清单是预设的**：不同类型小说（武侠/科幻/现实）可能需要不同维度。当前用通用维度，后续可按 skill 动态加载

## 不做（YAGNI）

- 后端任务调度器：不需要后端常驻循环，前端 SSE 驱动足够
- CLI 深化模式：深化是交互式（弹框输时间），不适合 CLI
- 多阶段连续深化：设计目标是做深一个阶段，不是串联多个阶段
- 自动嫁接/合并：跨阶段产出嫁接超出范围
- 额外的质检报告：deepen-log 即报告
