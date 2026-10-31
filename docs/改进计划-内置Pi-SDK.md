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

- P2 编辑器/分发/发布/评测。

## 12. 第二轮实施记录（2026-10-25）

本轮完成首轮遗留的 B5 与 P1 进阶全部三项（P2 仍待后续）：

- **B5 按阶段默认模型**：设置 `pi_stage_models`（7 主阶段 → 模型 ID JSON）；
  模型优先级：显式指定 > 阶段默认 > 全局；写作族子阶段
  （drafting/revision/polish/decompose/enrich/retro）回退 `writing` 配置。
  设置页「按阶段默认模型（可选）」7 个下拉；ChatPanel 默认项内联显示
  当前阶段解析到的模型 ID。落点：`src/agent/pi/config.ts`、`runtime.ts`、
  `SettingsPage.tsx`、`ChatPanel.tsx`、`runs.ts`（传 stage）。
- **P1-a CHANGES 自动提取/写回**：新增 `src/agent/canon-extractor.ts`——
  章节写完后用 `callPiOnce` 从正文提取 `CanonChanges` JSON（括号计数健壮
  解析、失败折叠为 `ok:false` 绝不阻断），`appendCanonChanges` 写回台账；
  `finalizePiRun` 在确定性检查之后、快照之前自动执行（writing/sample/
  drafting，项目开关 `canonAutoExtract` 默认开），emit `canon-update` 事件；
  新增 `POST /api/projects/:id/canon/extract` 手动补录（带 run 锁 409）。
- **P1-b 100 章一致性 fixture**：`validateChapterContract` 新增
  `dead-entity-cast`（blocker：合同 POV/出场命中已死亡实体）与
  `dead-entity-mentioned`（major：正文提及退场实体）；种子化生成器
  `tests/fixtures/consistency-fixture.ts` + 注入器；
  `tests/integration/canon-consistency.test.ts`：100 章注入 42 个矛盾，
  P0 命中 30/30（100% ≥ 90%）、major 13/13、干净章节零误报、
  `buildCanonContext` 100 章台账 1ms < 500ms。
- **P1-c 上下文引擎**：`src/shared/extractive-summary.ts` 确定性抽取式摘要
  替代占位摘要「前 200 字」截断；`src/agent/context-budget.ts` token 估算
  （CJK×1 + 拉丁词×1.3）+ 分层预算组装（合同=0/canon=1/大纲=2 等七级优先，
  超预算先丢低优先层、priority 0 永不整层丢弃），接入
  `buildWritingContextLayers`（预算 = min(窗口×40%, 48k)，未超预算时输出
  与改前逐字一致）；新增 `GET /api/projects/:id/context/preview` 分层
  token 报告 + 写作视图「🧭 上下文检查器」只读面板（懒加载）。

已验证：

- `pnpm typecheck` 通过；`pnpm lint` 0 error（仅历史 warning）；`pnpm build` 通过。
- `pnpm vitest run --changed --maxWorkers=4`：36 files / 509 tests 通过
  （新增：pi-config-stages 11、canon-extractor 15+6、canon-auto-extract 2、
  canon-consistency 4、context-budget/extractive-summary 24、context 6、
  canon 死亡实体 5 等）。
- 生产服务冒烟：`PATCH /api/settings`（pi_stage_models 保存/回显）、
  `GET /api/projects/:id/context/preview`（分层 token 报告 + 预算）、
  `POST /api/projects/:id/canon/extract`（无 Key 时优雅降级 `ok:false`
  带明确指引，不崩溃）实测通过。

仍待后续：

- ~~P2 编辑器/分发/发布/评测~~ → 已在第三轮完成（见第 13 节）。

## 13. 第三轮实施记录（2026-10-26）：P2 体验与分发全部落地

七个 P2 条目全部实施（两波并行子任务 + 主线集成）：

- **编辑器内联 AI（润色/扩写/续写 + 段落级 diff/合并）**：
  `src/shared/inline-edit.ts` 纯函数层（三动作中文 prompt、段落合并计划
  原位替换/追加/整体替换三策略）+ `POST /api/projects/:id/inline` 同步端点
  （run 锁、callPiOnce）+ EditorPanel 内联工具条（选区感知：有选区出
  润色/扩写、光标在文末出续写；结果先 diff 预览、应用/放弃，应用走既有
  防抖保存）。34 用例（含 jsdom 组件全流程）。
- **成本面板**：`runtime_usage` 事件补 `model` 字段；
  `GET /api/projects/:id/costs/summary`（byModel/byRun/byChapter/byDay
  聚合，章节归属用 artifacts 写盘清单精确解析）+ `/budget`
  （`cost_budget_usd` 设置、超支判断）；CostPanel（预算进度条、超支横幅、
  四张聚合表）挂入侧栏「成本」视图。rewrite run 无 conversation 不计入
  （runs 表无归属，不摊派）。
- **发布适配**：`publish-formats.ts` 表驱动四平台纯文本格式（起点/晋江
  章名行+单空行、番茄标题后空行、七猫段落无空行，全部剥 markdown）；
  `sensitive-words.ts` 内置 81 词 + 项目级 `.novel/sensitive-words.txt`
  扩展，`GET /export/sensitive-scan` 全本扫描；`validateEpub` 结构校验
  （mimetype stored 首位、container.xml、OPF manifest/spine 闭环）接入
  epub 导出自检；导出菜单新增「平台文本 / 敏感词」对话框（可跳章）。
  37 用例；平台规则标注 [假设：通行约定]。
- **提示词预设版本化 + SKILL.md 导入 + 组装预览**：
  `.novel/prompt-presets/`（manifest + append-only vN.md + current 指针）、
  `bindings.json` 阶段绑定、`importFromSkillFile`（剥 YAML frontmatter）；
  `/api/projects/:id/presets` CRUD/版本/绑定/导入（run 锁）+ `/preview`
  组装预览（预设边界标记 + token 估算）；PromptPresetPanel 挂侧栏
  「提示词预设」视图。**composePrompt 已接线消费**：generate 模式注入
  当前阶段绑定预设（写作族子阶段复用 writing 绑定，decompose/enrich
  专用路径不注入，损坏静默跳过）。
- **Docker/npx/Release 打包**：多阶段 Dockerfile（node:22-slim、非 root、
  HEALTHCHECK node fetch、状态收敛 /data 含 HOME）、docker-compose.yml
  （named volume + AUTH_TOKEN 示例）、`bin/open-novel.mjs` 启动器 +
  package.json bin/files、release.yml（tag → typecheck/测试/build →
  tarball+sha256 → GitHub Release）、README「部署」章节。podman 全程
  E2E 实测（build/run/健康检查/AUTH_TOKEN 401/数据卷持久化）。
  修复 pnpm 11 `ERR_PNPM_IGNORED_BUILDS`（allowBuilds 补齐）。
- **长程评测 + 夜间 CI**：`tests/eval/consistency.eval.test.ts`
  （EVAL_RUN 门控，常规 CI skip）；`scripts/eval-consistency.mjs` 薄壳 +
  `pnpm eval:consistency`；100/300 章实跑：P0 命中 100%（30/30、90/90）、
  干净章零误报、buildCanonContext ≤1ms；可选 LLM judge（无 Key 优雅
  跳过）；eval-nightly.yml（cron + artifact）。
- **PR 式审阅行内评论**：`.novel/review/comments.jsonl`（append-only、
  后写覆盖 resolve、O_APPEND 原子追加）；review 路由新增
  GET/POST `/comments`、PATCH `/comments/:id`（写操作 run 锁、路径校验，
  GET 在 run 中放行）；ReviewPanel 改 PR 式：文件展开 diff、行级评论
  （行号锚点 + 解决勾选）、💬 徽标与「N 文件 / M 未解决评论」汇总条。
  git accept/reject 语义与不变量零改动。31 用例。

已验证：

- `pnpm typecheck` 通过；`pnpm lint` 0 error（41 历史warning）；`pnpm build` 通过。
- `pnpm vitest run --changed --maxWorkers=4`：102 files / 1484 tests 通过
  （1 skipped 为 eval 门控文件，符合设计）。
- 生产构建冒烟：costs summary/budget 空态、presets 创建（拼音 slug）/
  绑定/preview（边界标记 + tokensApprox）、inline 无 Key 优雅 500、
  qidian 平台导出、sensitive-scan 干净零命中、review comments 写入与
  byFile 分组全部实测通过。
- 打包：podman build/run/健康检查/AUTH_TOKEN 鉴权/数据卷持久化 E2E 通过。

仍待后续（P3 候选）：

- ~~富文本/Markdown WYSIWYG 编辑器（当前内联 AI 基于纯文本 textarea）~~ → 已在第四轮完成（见第 14 节）。
- ~~npm 实际发布（package.json bin/files 已就绪，需 registry 凭据）~~ → 第四轮完成发布通道（workflow + 包内容校验 + 包名改 scoped）；仍需维护者配置 `NPM_TOKEN` 与 npm 组织权限后首次发布。
- ~~Docker 镜像发布（workflow 留 TODO）~~ → 第四轮完成（`release.yml` 的 `docker` job 推 GHCR）。
- ~~run 级实时成本提醒（当前打开成本面板才提醒）~~ → 第四轮完成（`cost_alert` 事件 + 对话面板横幅）。
- ~~语义回忆向量化模型可配~~ → 第四轮完成：嵌入模型/地址变更立即触发全量索引重建，换模型当场生效。
- ~~LLM judge 接入夜间 CI（需 CI 凭据注入）~~ → 第四轮完成：夜间 workflow 注入 `PI_*` 凭据与 `EVAL_JUDGE_MODEL`。

## 14. 第四轮实施记录（2026-10-27）

本轮收口第三轮遗留的 P3 候选，并修掉两个「装不上/跑不起来」的发布级缺陷。

### 14.1 富文本（Markdown WYSIWYG）编辑器

- 新增 `src/shared/rich-markdown.ts`：`markdownToEditorHtml`（marked + GFM，原始 HTML 一律丢弃）
  与 `editorHtmlToMarkdown`（turndown，ATX 标题 / `-` 项目符号 / 围栏代码块）双向转换，
  外加 `sanitizeEditorHtml` 白名单清洗（仅 p/h1-h6/strong/em/del/code/pre/blockquote/ul/ol/li/hr/br/a；
  丢弃 script/style/iframe 等连内容标签；`javascript:`/`data:` 链接拒绝；属性只留 `a[href]` 与 `ol[start]`）。
- 新增 `src/web/components/RichMarkdownEditor.tsx`：完全非受控的 `contentEditable`
  （React 只在外部 value 变化时写 innerHTML，打字过程不回写 DOM——光标不跳）；
  粘贴一律按纯文本处理，杜绝从网页粘入脚本/外链图片；工具栏含加粗/斜体/标题/引用/无序/有序列表
  （`document.execCommand` 不可用时静默跳过，不抛错）。
- `EditorPanel` 新增「富文本」模式（源码 / 富文本 / 预览 / 局部重写 四态）；
  富文本模式下内联 AI（润色/扩写/续写）仍以源码模式为准，界面给出明确提示。
- 落盘的权威格式仍是 Markdown：编辑走既有 `handleChange` → 1s 防抖 → PATCH，
  字数口径（中文按字 + 英文按词）与源码模式完全一致。

### 14.2 run 级实时成本提醒

- 新增 `src/shared/cost-budget.ts`：`createBudgetTracker` 纯函数层——run 启动时快照项目累计花费，
  之后按 `runtime_usage` 累加本次 run 成本，首次越过预算产出一次 alert（只提醒一次）。
- 服务端：`src/api/routes/costs.ts` 导出 `getProjectCostSnapshot`（与 summary/budget 同源）；
  `src/api/routes/runs.ts` 在 run 启动时取快照并创建 tracker，
  越过预算时 emit `cost_alert`（含 `spentUsd`/`budgetUsd`/`percent`/`runCostUsd`）；
  启动时已超支也会立即提醒（不等第一条 usage）。
- 前端：`useRun` 新增 `costAlert` 状态与 `dismissCostAlert`；`ChatPanel` 输入区上方显示可关闭的提醒条
  （`role="alert"`，带 `data-testid="cost-alert"`）。新 run 开始时清空旧提醒。

### 14.3 发布通道（npm + Docker 镜像）

- **包根解析修复（关键）**：此前 `templates/`、`plugins/`、`drizzle/` 全部按 `process.cwd()` 解析——
  `npx`/全局安装时 cwd 是用户目录，模板、插件、migration 全部找不到（新建项目没有初始文件、
  技能消失、PGlite 首次启动无 migration）。新增 `src/shared/package-root.ts`：
  `OPEN_NOVEL_PACKAGE_ROOT` 显式覆盖 → 从模块位置向上找 `package.json` → 兜底 cwd；
  插件/模板/migration 三处改用它，`bin/open-novel.mjs` 启动器显式注入包根。
- **包名改 scoped**：`open-novel` 在 npm 上已被他人占用（现有 1.1.2），改用 `@wmzy/open-novel`
  （`bin` 名仍是 `open-novel`，命令不变）。
- `package.json` 补 `description`/`repository`/`homepage`/`bugs`/`publishConfig.access`；
  `files` 增 `templates/`；新增 `prepack`（打包前自动构建，避免发布过期产物）。
- 新增 `.github/workflows/publish-npm.yml`：Release published 或手动触发 →
  typecheck → 测试 → 构建 → `npm pack --json --dry-run` 内容校验 → `npm publish --provenance`。
  未配置 `NPM_TOKEN` 时只打印 notice 跳过，不影响 Release。
- 新增 `scripts/verify-package-contents.mjs`（含单测）：发布包缺 dist/启动器/插件/模板/migration 任一项即失败。
- `release.yml` 增加 `docker` job：登录 GHCR → `docker/metadata-action` 打 `X.Y.Z`/`X.Y`/`latest` 标签
  → `docker/build-push-action` 推送（`packages: write` 权限）。Dockerfile 同步补 `templates/`。

### 14.4 Pi 配置的环境变量回退 + 夜间 LLM judge

- `src/agent/pi/config.ts` 新增通用环境变量：`PI_PROVIDER`/`PI_MODEL`/`PI_BASE_URL`/`PI_API`/`PI_API_KEY`/
  `PI_THINKING_LEVEL`/`PI_CONTEXT_WINDOW`/`PI_MAX_TOKENS`。
  优先级：设置页（DB）> 通用 env > provider 专用 env（`OPENAI_API_KEY` 等）> 默认值。
  Docker / CI / 一次性部署无需先写数据库设置。
- `tests/eval/consistency.eval.test.ts` 支持 `EVAL_JUDGE_MODEL`（judge 用独立便宜模型）。
- `.github/workflows/eval-nightly.yml` 注入 `PI_API_KEY`（secret）与 `PI_PROVIDER`/`PI_MODEL`/
  `PI_BASE_URL`/`PI_API`/`EVAL_JUDGE_MODEL`（variables）；有凭据时自动 `EVAL_JUDGE=1`，
  无凭据时 judge 跳过、确定性评测照常执行。`EVAL_JUDGE_MODEL` 建议指向便宜模型。

### 14.5 语义回忆的向量化模型「可配」落地

嵌入模型/地址此前只能在设置页改，但换模型后既有向量立即失效（检索按 `row.model === config.model`
过滤 → 退化为 `index-empty`，写作期语义回忆注入为空），要等下一次章节同步才重建。
现在 `PATCH /api/settings` 检测到模型/地址/密钥变更即调度全量重建
（`scheduleSemanticReindexAll`），换模型当场生效。

### 14.6 首访 500 修复（并发 git 竞态）

`GET /api/projects/:id`（迁移双分支）与 `GET /api/projects/:id/review`（审阅 diff 前同样要迁移）
在项目页首访并发触发，两次 `ensureDraftBranch` 都判定「draft 不存在」并各自执行
`git branch draft`，后者报「分支已存在」→ 审阅接口 500 → 浏览器控制台报错，E2E 首访用例失败。

修复（`src/agent/snapshot.ts`）：
- 每个项目目录一条 git 操作串行链（`runExclusiveGitOp`），结构性操作排队执行，
  check-then-act 不再有窗口期；
- `ensureDraftBranch` / `reviewDiff` 走该链；`git init` 与分支创建对「已存在」幂等容忍
  （跨进程/多实例场景同样安全）；
- 新增回归用例：并发 `ensureDraftBranch` 与并发 `ensureDraftBranch + reviewDiff` 全部成功。

### 14.7 已验证

- `pnpm typecheck` 通过；`pnpm lint` 0 error（41 历史 warning）；`pnpm build` 通过。
- `pnpm vitest run --changed --maxWorkers=4`：110 files / 1528 tests 通过
  （1 skipped 为 eval 门控文件，符合设计）。新增用例：
  rich-markdown 转换/清洗、rich-editor 组件、cost-budget 纯函数、
  run-cost-alert 端到端接线、package-root 资源解析、pi-config-env 环境变量回退、
  verify-package-contents 发布包校验、semantic-model-switch 换模型重建、
  snapshot 并发 git 竞态回归。
- `npm pack --dry-run` 内容校验通过：207 个文件，必需条目 13 项齐全。
- GitHub Actions YAML 四个 workflow 均可被 `yaml.safe_load` 解析。
- `npx playwright test`：25/25 通过（修复前 22/25，首访 500 已消除）。
- 生产构建冒烟（真实浏览器 + 假 provider）：
  新建项目时 `templates/` 模板正常初始化（CREATOR/progress/character-states 落盘）；
  富文本模式渲染 `<h1>`/`<p>`，工具栏「加粗」产出 `**…**` 并经既有防抖保存写回
  `.novel/chapters/第1章.md`；运行期 SSE 推送 `cost_alert`，
  对话面板出现「⚠ 预算提醒」横幅（可关闭）；换嵌入模型后后台重建索引、检索与语义回忆恢复。

仍待后续：

- npm 首次发布需维护者配置 `NPM_TOKEN` 与 `@wmzy` 组织权限；GHCR 首次推送同理。
- 富文本模式暂不支持内联 AI（内联 AI 仍在源码模式）。
- run 级成本提醒按「项目累计 + 本次 run」判定，未做按章节/按模型的细分预算。
- 局部重写（`/api/projects/:id/rewrite`）的 run 不绑定对话，成本不计入项目累计
  （与成本面板口径一致），因此也不会触发预算提醒。
