# 单阶段深度迭代（Deepen）设计

> 日期：2026-07-08
> 状态：设计已批准，待写实现计划
> 前置：night-explore 的 autonomous 模式已实现（composePrompt 支持 `autonomous` 标志，runs API 透传）

## 问题

现有 explore 设计是"多路发散→快速推进 N 个阶段"，产出一部快速但无价值的小说。用户真正需要的是：**在一个阶段（如角色）反复打磨到极致**，根据概念和世界观持续补充完善角色，一晚上或数个晚上都做这一件事。

快速吐出一部无价值的小说没有意义；做深做极致才有意义。

## 目标

让用户从某个视图（如角色页）点一个按钮，设定截止时间后离开。AI 在该阶段自主循环深化——每轮读取当前产出和历史改进记录，找出尚未补强的薄弱点，深度完善并记录。到点或手动中断时停止。

## 设计

### 核心机制：累积反思循环

每轮 agent 做同一阶段的同一批文件（如反复打磨 `.novel/characters/profiles.md`），不推进阶段。维护 `.novel/deepen-log.md` 记录每轮改进，避免重复，早上用户可看轨迹。

```
点 🔁 深化 → 弹框输截止时间（默认06:00）→ 确认
  → 第1轮 autonomous run（message 引导读产出+deepen-log，找新薄弱点）
  → run 完成（SSE 'end' 事件）→ 检查时间未到点
  → 第2轮 autonomous run（message 带轮数，引导找新的薄弱点）
  → ...
  → 到点 / 用户发消息 / 点停止 / 关页面 → 循环中断
```

### 触发方式

各视图页面加 🔁 深化按钮（与现有 ✎修订 / ⇄重命名 / 💡灵感 并列）。点击后 dispatch `DEEPEN_TO_CHAT_EVENT`，携带 `stage`（从视图上下文获取），ChatPanel 监听后弹出截止时间输入框。

**stage 来源**：视图自带的 stage（CharacterView → 'characters'，WorldView → 'world'），通过 CustomEvent 传递。与现有修订按钮（`REVISE_TO_CHAT_EVENT`）完全一致的模式。

**上下文自动获取**（零参数）：project / skill / agent 从会话状态拿，截止时间弹框输入。

### 停止机制（三重）

1. **定时**：每轮开始前检查 `Date.now()` 是否超过截止时间，到点优雅退出
2. **手动中断**：用户发任何消息（自然中断循环）、点停止按钮（现有 UI）、关闭页面
3. **连续失败保护**：连续 2 轮 run 失败（疑似额度耗尽）自动停止

### 每轮 message 构造

由前端 `buildDeepenMessage(stage, round)` 函数生成：

```
你在做「<stage>」阶段的深化打磨，这是第 <round> 轮迭代。

要求：
1. 读取当前阶段的产出文件
2. 读取 .novel/deepen-log.md 了解前几轮已改进的内容
3. 找出当前产出中最薄弱、最需要补强的点——不要重复已改过的
4. 深度补强：补充细节、增加层次、丰富内心世界、强化矛盾张力
5. 修改完后在 .novel/deepen-log.md 追加本轮记录，格式：
   ## 第<N>轮
   - 发现：<本轮识别的薄弱点>
   - 改进：<做了什么>
   - 下轮建议：<下一轮值得关注的方向>
6. 不要用 question 工具提问，不要推进到下一阶段
```

### deepen-log.md 结构

存在项目 `.novel/` 下。每轮 agent 追加记录：

```markdown
# 深化日志

## 第1轮
- 发现：主角动机模糊，缺少具体创伤事件
- 改进：补充童年背叛场景，明确复仇执念的心理根源
- 下轮建议：反派与主角的镜像关系尚未建立

## 第2轮
- 发现：反派缺少独立动机，沦为工具人
- 改进：赋予反派独立目标（证明自己的理念），建立与主角的镜像对照
- 下轮建议：配角群像单薄，缺少功能性角色
```

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
   - `buildDeepenMessage(stage: string, round: number): string`

### 后端

**零改动。** autonomous 模式、`POST /api/runs` 透传、`GET /:id/status` 端点在 night-explore 中已完成。深化循环完全由前端驱动——每轮就是一个普通的 autonomous run。

### 与现有 explore 的关系

- CLI 的 diverge 模式（多路发散）保留——仍有使用价值
- `/explore` slash 命令保留现有行为（单次 autonomous run）
- 深化功能**不依赖** CLI 脚本，是纯前端 ChatPanel 驱动的循环
- explore 的核心定位转向"深度迭代"，多路发散降为次要功能

## 已知限制

- **无产出质量门禁**：每轮不做质检，依赖 agent 自我判断薄弱点。deepen-log 是唯一的质量轨迹
- **deepen-log 膨胀**：长时间运行日志会增长。当前不自动截断（轮数有限，每轮记录短）；如成问题后续加轮数上限或日志大小限制
- **单 conversation 累积**：所有轮次在同一 conversation 内，上下文窗口可能被历史填满。autonomous 模式下 agent 每轮独立读文件而非依赖对话历史，影响可控
- **并发不安全**：同时开多个 deepen 循环（不同视图）会互相干扰——同一项目的同一批文件。当前不支持并发，进入 deepenMode 时若已有活跃循环则拒绝
- **关页面即停**：循环状态不持久化。刷新/关页面后需手动重启。这是设计选择——deepen-log 记录了已完成的工作，重启不会丢失成果

## 不做（YAGNI）

- 后端任务调度器：不需要后端常驻循环，前端 SSE 驱动足够
- CLI 深化模式：深化是交互式（弹框输时间），不适合 CLI
- 多阶段连续深化：设计目标是做深一个阶段，不是串联多个阶段
- 自动嫁接/合并：跨阶段产出嫁接超出范围
- 额外的质检报告：deepen-log 即报告
