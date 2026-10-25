# 改进计划：内置 Pi SDK，移除外部 Agent

> 状态：实施中（2026-10-25）
> 关联决策：不再维护 Claude Code / OpenCode / OMP 三条外部 CLI 一等路径；内置
> `@earendil-works/pi-coding-agent` 作为唯一 Agent 运行时。已有订阅的用户通过
> 本地反向代理把订阅暴露成 OpenAI/Anthropic 兼容接口，再以自定义 provider 接入 Pi。

## 1. 为什么改

当前 `src/agent/` 同时维护三套外部 Agent：

- `claude`：stdin stream-json + `stream-parser.ts`；
- `opencode` / `omp`：ACP JSON-RPC + `acp-bridge.ts`；
- 每种 Agent 还有独立的模型探测、subagent 部署、prompt 分支。

这带来四类成本：

1. **安装门槛**：用户必须先装 Node/pnpm，再装至少一个 Agent CLI。
2. **行为分叉**：同一个 run 在三种 Agent 上的工具集、系统提示、取消语义不同。
3. **测试矩阵**：流解析、ACP、子进程孤儿回收、模型探测都要各测一遍。
4. **订阅路径不统一**：Claude Code / Codex 订阅只能靠外部 CLI 使用。

Pi 1.4.0 是 MIT、Node ≥22.19、纯 TS/JS 的进程内 SDK，提供：

- `createAgentSession` + `SessionManager`（持久/内存会话）；
- `ModelRuntime`（多 provider、API Key/OAuth、模型目录、`models.json`）；
- 内置 `read/write/edit/grep/find/ls/bash` 工具；
- `session.subscribe` 类型化事件、`session.abort()`、自动重试、压缩；
- `DefaultResourceLoader`（system prompt、skills、prompt templates、MCP）。

它正好覆盖 open-novel 需要的 agent loop，且不需要子进程。**这应当是替换，而不是新增第四条路径。**

## 2. 目标与非目标

### 目标

- `src/agent/` 只保留一个内置 `pi` Agent；不再要求用户安装任何 Agent CLI。
- 设置页可直接配置 provider / model / base URL / API Key，并把 Key 保存在服务端。
- 订阅用户可通过本地反向代理接入（OpenAI-compatible 或 Anthropic-compatible）。
- 保留现有 run/SSE/取消/超时/重试/串行锁/审阅/快照/成本事件语义。
- 删除外部 Agent 的启动、流解析、ACP、子进程对账与相关测试。
- 用 Pi 的事件映射产出与现有前端兼容的 `StreamEvent` / `AgentEvent`。

### 非目标（本轮不做）

- 不实现自建 provider 网关或代理服务器；只提供配置入口和文档。
- 不实现多用户/云端同步。
- 不重写七阶段创作流程、git 审阅门、样章门、批量写作。
- 不在本轮完成 canon/章节合同硬门禁（列入 P1，见第 6 节）。

## 3. 目标架构

```text
React 前端
  └─ /api/runs, /api/runs/:id/events, /api/agents...
       └─ Hono API
            └─ src/agent/pi/runtime.ts（进程内）
                 ├─ createAgentSession({ cwd, tools, modelRuntime })
                 ├─ session.subscribe → mapPiEvent → StreamEvent
                 ├─ session.abort() ← cancelRun / timeout
                 └─ ModelRuntime
                      ├─ 内置 provider（anthropic/openai/deepseek/...）
                      └─ custom provider（baseUrl + openai-completions）
                           └─ 用户本地反代（订阅 → 兼容 API）
```

### 运行模型

- 每个 run 创建一个内存 `SessionManager`，prompt 由 `composePrompt()` 完整组装；
- 会话内保留工具调用/多轮循环；跨 run 的状态仍由 `.novel/` 文件与 DB 承载；
- 不启用 Pi 的项目上下文发现（`noContextFiles`），避免与 `.novel/` 分层上下文重复；
- 默认工具：`read/write/edit/grep/find/ls/ask/open_novel_api`；`bash` 默认关闭，
  阶段推进/模板/质检通过受限的 `open_novel_api` 调用；
- `session.abort()` 接入现有 `cancelRun()`；超时仍由 `config.agent.timeoutMs` 控制；
- 事件映射：
  - `message_update.assistantMessageEvent.text_delta` → `text_delta`
  - `thinking_delta` → `thinking_delta`
  - `tool_execution_start` → `tool_use`
  - `tool_execution_end` → `tool_result`
  - `message_end.usage` → `usage` + `runtime_usage`
  - `auto_retry_*` / `compaction_*` → `status`

## 4. 工作流 A：P0 运行时切换（本轮）

| # | 任务 | 落点 | 验收 |
|---|---|---|---|
| A1 | 安装 Pi SDK | `package.json` | `node -e import(...)` 成功；Node ≥22.19 |
| A2 | Pi 配置层 | `src/agent/pi/config.ts` | 读取 settings / env；构造 `ModelRuntime`；列出模型 |
| A3 | Pi 事件映射 | `src/agent/pi/runtime.ts` | 单元测试覆盖 text/thinking/tool/usage/error/abort |
| A4 | run 集成 | `src/api/routes/runs.ts` | 写作 run 走 Pi；零产出重试、超时、取消、最终化保持 |
| A5 | rewrite 集成 | `src/api/routes/rewrite.ts` | 局部重写走 Pi；SSE 文本累加不变 |
| A6 | one-shot 集成 | `src/agent/agent-once.ts` + `check.ts`/`timeline.ts` | 事实核查/时间线补全可用 Pi 单次调用 |
| A7 | Agent API 简化 | `src/api/routes/agents.ts` | 只返回 `pi`；模型列表来自 `ModelRuntime` |
| A8 | 删除外部 Agent | `registry/detection/launch/stream-parser/acp-bridge/executables/child-registry` | `grep` 无残留引用；启动不再部署 subagent CLI |
| A9 | 取消语义 | `src/agent/run.ts` | `run.abort`；取消后状态为 canceled，SSE 正常结束 |
| A10 | 测试清理 | `tests/unit/agent/*`, `tests/integration/*` | `vitest --changed` 通过；外部 Agent 测试删除或替换 |

## 5. 工作流 B：P0 产品化（本轮/下一轮）

| # | 任务 | 落点 | 验收 |
|---|---|---|---|
| B1 | 设置页「内置模型」 | `SettingsPage.tsx` + `settings.ts` | provider/model/baseUrl/apiKey/自定义协议可保存 |
| B2 | Key 安全 | `settings.ts` | 只存服务端；GET 只回 `pi_apiKeySet`；日志不输出 |
| B3 | 连接测试 | `POST /api/agents/pi/test` | 校验 provider/model/auth，不产生生成费用 |
| B4 | 反代预设 | 设置页 + README | 一键填入 `http://127.0.0.1:<port>/v1` + 模型名 |
| B5 | 模型选择 UI | ChatPanel | 模型下拉来自 Pi 目录；按阶段显示默认模型 |
| B6 | 文档 | README / HelpPage | 删除 CLI 安装说明；增加反代与 Key 配置 |

### 订阅反代约定

Pi 只认兼容 API。订阅用户需在本地启动一个反代，把订阅转成：

- OpenAI-compatible：`baseUrl=http://127.0.0.1:<port>/v1`，`api=openai-completions`；
- Anthropic-compatible：`baseUrl=http://127.0.0.1:<port>`，`api=anthropic-messages`；
- 模型 ID 填反代声明的模型名；API Key 可留空或填反代要求的占位值。

反代只监听 `127.0.0.1`；open-novel 不内置、不分发反代，避免账号条款与密钥风险。

## 6. 工作流 C：P1 长篇一致性（下一阶段）

1. `.novel/canon/` 结构化台账：实体、事实、状态、关系、伏笔、知情，带
   `sourceChapter`、`validFrom`、`status`；append-only 变更日志。
2. 每章 `chapter.plan.json`：POV、出场、beat、允许揭示、字数预算；写作前冻结。
3. state-patcher 输出 `CHANGES` JSON；校验引用、矛盾、缺席、POV 越界。
4. 门禁分级：P0 阻断“定稿”，起草只警告；作者可 override 并留审计。
5. 上下文引擎：用便宜模型/抽取式摘要替代“正文前 200 字”；token 预算；
   Postgres 下 pgvector；500 章 prompt 组装 <500ms。
6. 质量策略：事实核查结果进入“待修队列”，不再只报告；AI 味自动归档改为
   off/warn/block 可配置，归档前需确认。

验收：100 章 fixture 注入矛盾，P0 命中 ≥90%；无需手工改 state。

## 7. 工作流 D：P2 体验与分发（后续）

- 段落级 diff/合并、编辑器内联润色/扩写/续写；富文本或 Markdown WYSIWYG。
- 提示词预设版本化；导入 `SKILL.md` 并绑定阶段；组装预览。
- Docker Compose + GitHub Release + `npx`；PGlite 数据卷与健康检查。
- 成本面板：按 run/章节/模型聚合；预算提醒；摘要/检查走便宜模型。
- 发布适配：起点/番茄/七猫/晋江格式、敏感词、EPUB 校验。
- 长程评测：100/300 章 fixture + 确定性检查 + LLM judge；夜间 CI。
- git 协作：PR 式审阅、冲突解决 UI、行内评论。

## 8. 风险与回滚

| 风险 | 应对 |
|---|---|
| Pi SDK 1.4.x API 变动 | 锁精确 minor；所有调用收口在 `src/agent/pi/`；契约测试 |
| 进程内 agent 崩溃拖垮 API | run 级 try/catch + `session.dispose()`；后续可加 worker 隔离 |
| 工具越权（读项目外文件） | 默认不启用 bash；read/write/edit 的 cwd 限制；后续加沙箱 |
| provider 目录不含用户模型 | custom provider + `models.json` 兼容入口；模型名/上下文/输出上限可配 |
| 反代不稳定 | 连接测试 + 明确错误提示；run 失败可重试；不自动切换外部 CLI |
| 老用户依赖 Claude Code 订阅 | 文档提供反代方案；短期保留只读迁移说明，不保留 CLI runtime |
| 删除外部代码引发回归 | 分两次提交：先引入 Pi 并切换，再删外部；每步跑 typecheck + 定向测试 |

## 9. 验收指标

- 干净机器：`pnpm install && pnpm dev`，只配一个 API Key 即可写出第一章。
- `GET /api/agents` 只返回 `pi`；`/api/agents/pi/models` 返回可用模型。
- 写作/重写/事实核查/时间线四条链路均有 Pi 集成测试。
- 取消：`DELETE /api/runs/:id` 后 5 秒内 SSE 收到 `end`，run 状态 `canceled`。
- 超时：`AGENT_TIMEOUT_MS` 到期后 session abort，无残留定时器。
- 成本：每个 run 的 usage/cost 进入 `AgentEvent` 与消息 footer。
- 代码：`src/agent/` 不再包含 `claude/opencode/omp` 字符串（迁移说明除外）。

## 10. 任务拆分（供并行实施）

- **Task 1（核心）**：Pi config/runtime/event mapping；runs/rewrite/one-shot 集成；run abort。
- **Task 2（清理）**：agents API、check/timeline/manuscript、删除外部 Agent 文件与测试。
- **Task 3（产品）**：设置页、模型下拉、反代预设、HelpPage/README。
- **Task 4（验证）**：新增 Pi 单测；更新受影响的 runs/rewrite/UI 测试；typecheck/build。

## 11. 本轮实施记录（2026-10-25）

已完成：

- **A1** 安装 `@earendil-works/pi-coding-agent@1.4.0` + `@earendil-works/pi-ai@1.4.0`；Node 最低版本提升到 22.19。
- **A2** 新增 `src/agent/pi/config.ts`：设置读写、环境变量回退、`ModelRuntime` 构造、
  自定义 provider（OpenAI-compatible / 反代 / Ollama）、模型列表、配置检查。
- **A3** 新增 `src/agent/pi/runtime.ts`：进程内 `createAgentSession`、文本/思考/工具/usage
  事件映射、`session.abort()`、单次调用、自定义 `ask` 工具（接现有 SSE/提问 UI）。
- **A4** `runs.ts` 切换到 `startPiAgent`；保留串行锁、样章门、看门狗、零产出重试、
  超时、取消、质检、快照、批量推进、里程碑。
- **A5** `rewrite.ts` 切换到 Pi；取消/超时/收尾语义保持。
- **A6** `agent-once.ts`、事实核查、时间线补全切换到 `callPiOnce`。
- **A7** `/api/agents` 只返回内置 `pi`；模型列表来自 `ModelRuntime`；新增
  `POST /api/agents/pi/test`。
- **A8** 删除 `registry/detection/launch/stream-parser/acp-bridge/executables/child-registry`
  及其测试；启动不再部署外部 subagent、不再对账孤儿 CLI 进程。旧 `agentId`
  （claude/opencode/omp）仅作为兼容别名映射到 `pi`。
- **A9** `RunSession.child` 移除，改为 `abort`；取消后由 Pi promise 结算，
  `finishRun(canceled)` + SSE `end`。
- **A10** 新增 `tests/unit/agent/pi-runtime.test.ts`（真实 fake provider 的文本/usage/
  ask/abort）与 `tests/integration/pi-run.test.ts`（API → Pi → 工具写盘 → DB status）。
- **B1–B3** 设置页新增「内置 Pi 模型（BYOK）」：provider/model/baseUrl/api/key/
  thinking level，保存、清除密钥、测试配置；GET 只回 `pi_apiKeySet`。
- **B5** 对话面板模型下拉来自当前 Pi provider 的模型目录。
- **B4** 设置页增加 OpenAI 兼容反代 / Anthropic 兼容反代 / Ollama 三个快捷预设。
- **B6** README / HelpPage / 工具使用指南更新；新增 `docs/订阅反代接入.md`。
- **安全收口** 新增 `src/agent/pi/api-tool.ts`：项目作用域白名单的 `open_novel_api` 工具，
  替代 `bash + curl`；`runs` 默认 `allowBash: false`。
- **P1 基础层** 新增 `src/shared/canon.ts`：`.novel/canon/` 台账、append-only changes、
  章节合同、确定性 POV/出场/揭示/字数校验、canon/contract prompt 注入、
  `contract-gate` 定稿门禁与 `overrides.jsonl` 留痕；新增 `/canon`、`/contracts` API、
  只读「设定台账」视图与测试。

已验证：

- `pnpm typecheck` 通过。
- `pnpm lint` 0 error（仅历史 warning）。
- `pnpm vitest run --changed --maxWorkers=4`：83 files / 1280 tests 通过。
- 设定台账视图浏览器验证：侧边栏入口、实体/事实/知情边界渲染正常。
- `pnpm build` 通过；生产服务 `GET /api/agents`、`PATCH /api/settings`、
  `POST /api/agents/pi/test`、`PATCH /api/projects/:id/chapters/:num` 合同门禁实测通过；
  设置页反代预设与 Pi 配置表单浏览器验证通过。

仍待后续：

- B5 按阶段默认模型（当前为全局模型 + 对话面板临时覆盖）。
- P1 进阶：LLM 语义 `CHANGES` 自动提取/写回、100 章一致性 fixture、
  上下文引擎（摘要/预算/context inspector）。
- P2 编辑器/分发/发布/评测。
