# RunStream + ConversationStream 设计

> 日期：2026-07-08
> 主题：合并 eventStore 与消息持久化为统一流对象，前端订阅 conversation 级流而非 run 级

## 背景与问题

### 现状

实时数据通路散落在三个职责分离但耦合的组件中：

```
agent stdout
  → emitEvent (run.ts)
      ├→ run.events.push    (内存滑动窗口, 200 条)
      ├→ run.clients.send   (实时 SSE fan-out)
      └→ eventStore.append  (缓冲 + 批写 run_events 表)
```

`messages` 表（整条消息）只在 run 结束时（`child.on('close')`）由 close handler 一次性写入。

### 问题

**刷新后响应「完全消失」**：assistant 消息只在 run 结束时写 messages 表。流式响应中途刷新页面，前端从 messages 表加载历史时该条消息尚不存在 → 响应内容不可见。用户反馈「响应中间断了，刷新后响应完全不见了」「刷新整个都出来了，可能是响应完成后才保存」——根因确认。

### 之前的错误修复（将撤）

曾尝试用 `IncrementalAssistantMessage` 在 text_delta 到达时增量写入 messages 表 + 前端轮询 messages 表恢复。这是反模式：把 DB 当实时数据源、双写、增加 DB 高频更新压力。本次重构将撤掉，改为本设计。

## 目标架构

将 `eventStore`（缓冲 + 落盘 + 重放）与 `run.clients`（实时订阅）和 close 时消息持久化合并为一个 `RunStream` 流对象。前端订阅 `ConversationStream`（conversation 级）而非直接订阅 run 级事件。

### 核心原则

1. **单一写入源**：text_delta 等事件只进 RunStream，再无第二个写入点。
2. **流生命周期 = agent 输出**：agent 输出开始时流创建，结束时流 close。close 时固化整条消息到 messages 表。
3. **前端不关注 run**：订阅 conversation 级流，run 是实现细节。

## 组件设计

### RunStream

合并现有 `eventStore` + `run.clients` 订阅 + close 时消息持久化。per-run 实例。

**职责：**

| 方法 | 职责 | 来源 |
|---|---|---|
| `push(event, data)` | 写内存窗口 + 缓冲落盘 + fan-out 订阅者 | 现 `emitEvent` 三合一 |
| `subscribe(fromSeq, callback)` → unsubscribe | 重放历史（fromSeq 之后）+ 实时推送，返回取消订阅函数 | 现 `eventStore.replay` + `run.clients` 合并 |
| `close(status)` | 聚合全部事件 `transformStreamEvents` → 写 messages 表 → 释放内存 | 现 close handler 的持久化段移入 |

**生命周期：**

- 创建：`POST /api/runs` 创建 run 时，创建一个 RunStream。
- 存活：agent 输出期间，持续接收事件、推送订阅者。
- 关闭：agent 结束（child close）时调用 `close()`：
  1. 从已落盘 + 内存事件聚合（`transformStreamEvents`）
  2. 写入 messages 表（整条消息 + events + artifacts）
  3. 清理订阅者、释放内存窗口
- 与"agent 输出结束流才关闭"一致。

**与 run.ts 的关系：**

RunStream 吸收 eventStore 的存储职责和 run.clients 的推送职责后，`run.ts` 的 `emitEvent` / `subscribeRun` / `finishRun` 中的事件处理逻辑全部委托给 RunStream。RunSession 保留状态机职责（status 流转、child 引用、pending asks）。

### ConversationStream

前端唯一订阅入口。`GET /api/conversations/:id/stream`（SSE）。

**连接时按序：**

1. 推历史消息（messages 表，整条）作为 `message` 事件
2. 若 conversation 有活跃 RunStream → 桥接：`runStream.subscribe(0)` 重放全部事件 + 实时推送 agent 事件（text_delta 等）
3. run `close()` 后：推 `message` 事件（含固化的完整消息 + events + artifacts），继续等下一条消息
4. 新 run 启动：自动桥接到新 RunStream

**前端从这条流读一切实时数据，不关注 run。** runId 只在 cancel 时用（`DELETE /api/runs/:id`，操作类需求）。

## 数据流（三个场景）

### 场景 1：实时（发消息 → agent 响应）

```
用户发消息 → POST /api/runs（创建 RunStream）
前端 conversation 流检测到活跃 RunStream → 桥接
agent stdout → text_delta → RunStream.push
  → 缓冲落盘 run_events
  → fan-out → conversation 流 → 前端实时渲染
agent 结束 → RunStream.close → 固化 messages → conversation 流推 message 事件
```

### 场景 2：刷新恢复（原 bug 场景）

```
刷新 → mount → 连 conversation 流
  → 推历史 messages（已完成的对话）
  → 检测到活跃 RunStream → subscribe(0) 重放全部事件
  → 前端从 seq 0 重新聚合，自动看到已生成的部分内容
  → run 结束后收到 message 事件（含完整结果）
```

无需轮询。重放 = eventStore.replay 的现有能力。

### 场景 3：纯历史（无活跃 run）

```
刷新 → mount → 连 conversation 流
  → 推历史 messages
  → 无活跃 RunStream → 等下一条消息
```

## 与现有代码的映射

| 现状 | 改动 |
|---|---|
| `run.ts: emitEvent`（push 窗口 + fan-out clients + eventStore.append） | 合并为 `RunStream.push` |
| `eventStore.append/flush/replay/release` | 并入 RunStream，`event-store.ts` 模块删除 |
| `runs.ts` close handler 的 `transformStreamEvents` + `insert messages` | 移入 `RunStream.close()` |
| `GET /api/runs/:id/events`（run 级 SSE） | 保留（useRewrite 仍用，它确实只关心一个 run） |
| `GET /api/conversations/:id/messages`（历史查询） | 保留（conversation 流的初始快照用它） |
| **新增** `GET /api/conversations/:id/stream` | 前端主入口 |
| `IncrementalAssistantMessage`（之前的错误修复） | **撤掉** |
| useRun 的轮询恢复逻辑（之前的错误修复） | **撤掉**，改为订阅 conversation 流 |

### 不变的

- `run_events` 表、`messages` 表 schema 不变
- `useRewrite` 不变（它本来就该关注单个 run 的 text_delta）
- POST /api/runs 创建 run 的流程不变
- cancel / ask / retry 机制不变
- `GET /api/runs/conversations/:id/active-run` 端点保留（conversation 流内部用它检测活跃 run）

## 文件清单

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/agent/run-stream.ts` | 新建 | RunStream 流对象（合并 eventStore + run.clients + close 持久化） |
| `src/agent/event-store.ts` | 删除 | 职责并入 RunStream |
| `src/agent/incremental-message.ts` | 删除 | 撤掉之前的错误修复 |
| `src/agent/run.ts` | 修改 | emitEvent/subscribeRun 委托 RunStream；RunSession 持有 RunStream 引用 |
| `src/api/routes/runs.ts` | 修改 | close handler 持久化移入 RunStream.close；新增 conversation stream 端点 |
| `src/web/hooks/useRun.ts` | 修改 | 撤轮询，改订阅 conversation 流 |
| `tests/unit/agent/run-stream.test.ts` | 新建 | RunStream 单元测试（push/subscribe/close） |
| `tests/unit/agent/event-store.test.ts` | 删除 | 职责并入 run-stream 测试 |
| `tests/unit/agent/incremental-message.test.ts` | 删除 | 撤掉之前的错误修复测试 |
| `tests/unit/web/use-run.test.tsx` | 修改 | 适配 conversation 流订阅 |

## 错误处理

- **RunStream 落盘失败**：不阻断实时流（与现 eventStore 一致），事件保留在内存窗口供短期续传。
- **流 close 前进程崩溃**：丢失内存缓冲中未落盘部分。text_delta 本就是临时的；run_events 表已落盘部分持久。不做进程重启重建（YAGNI）。
- **conversation 流断线重连**：带 `Last-Event-ID` 重放历史消息，与现有 SSE 重连机制一致。
- **conversation 流连接时 run 正好 close**：重放 + 桥接的竞态由 RunStream 内部 seq 单调性保证——close 后 subscribe 仍能 replay 全部历史事件。

## 测试策略

1. **RunStream 单元测试**：push 落盘、subscribe 重放 + 实时、close 固化 messages、close 后订阅仍可重放。
2. **useRun 测试**：订阅 conversation 流、刷新恢复（重放历史 + 活跃 run 桥接）、纯历史。
3. **集成测试**：conversation stream 端点（历史快照 + 活跃桥接 + run close 推送）。
4. **回归**：现有 601 单元测试 + 29 集成测试全过。
