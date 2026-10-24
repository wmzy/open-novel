# open-novel

AI 辅助小说写作应用：通过调用外部 AI 编码 agent（`claude` / `opencode` CLI）完成从立意到成稿的全流程创作，前端实时展示 agent 的流式输出与文件操作。

## 工作流

创作被拆分为若干阶段，每个阶段产出对应的 `.novel/` 文件（阶段定义以 `src/shared/stages.ts` 为准）：

```
concept → world → characters → outline → scenes → sample → writing
 立意     世界观    人物设定     大纲      场景      样章      写作
```

- **样章（sample）**：scenes 与 writing 之间的强制关卡，写 3 章样章检验声口与节奏。
- **伏笔状态机**：伏笔按 `pending → planted → progressing → resolved` 推进（planted 可直接回收，回退需显式 `reopen`），`progressedIn` 记录推进章号；逾期/临期伏笔在写作上下文与伏笔看板中高亮提醒。
- **drafting / revision / polish** 是写作子模式（`/draft`、`/revision`、`/polish` 命令），
  不是独立主线阶段，与 writing 共用分层上下文。
- **质量检查**：章节视图提供反 AI 味、伏笔、OOC 与事实核查。事实核查覆盖 POV 知情越界（`.novel/character-knowledge.json`）、人名/别名笔误与设定时间线矛盾；默认只报告、不阻断写作。
- **导入手稿**：首页「导入手稿」支持 txt/md/epub，自动识别「第N章/回/节」、`Chapter N`、Markdown `#`/`##` 与数字标题切章（兼容中文数字、UTF-8 BOM、GBK/GB18030）；预览中可合并/拆分/改名，确认后写入已有或新建项目的 `.novel/chapters/` 并可标记定稿，可选自动触发章节摘要/角色状态补全（enrich run）。
- **导出**：顶部「导出」菜单支持 Markdown（含设定/纯正文）、TXT、EPUB 3 电子书与 DOCX（Word）；EPUB/DOCX 均按章号顺序输出，章节标题为 Heading 1，正文首行缩进 2 字符，缺章/质检归档会通过 `x-export-warnings` 提示。
- **批量写作**：输入 `/batch 10-20` 或「写第10到20章」（单批 ≤10 章），每章是串行锁下的真实 run；支持暂停（当前章写完）、继续、取消与失败章恢复，进度落盘 `.novel/batch.json`，刷新/重启后可继续。
- **自动里程碑**：每 `milestoneEvery` 章（默认 50，0 关闭）与卷末自动创建 `milestone-*` 快照（幂等账本 `.novel/milestones.json`），空闲时以正常 `retro` run 生成阶段回顾报告；有 run 在途时跳过并记录备注。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 19 · Vite 8 · React Query · Linaria（CSS-in-JS） |
| API | Hono（进程内 + 可独立部署的 Node 服务） |
| 数据库 | Drizzle ORM · PGlite（嵌入式开发）/ postgres（生产） |
| Agent | spawn 子进程 + SSE 流式解析（claude-stream-json） |
| 测试 | Vitest（单元 + 集成） · Playwright（E2E） |

## 开发

```bash
pnpm install          # 安装依赖
npm run dev           # 启动开发服务器（Vite + 内嵌 API，:3006）
npm run typecheck     # 类型检查
npm run test          # 单元 + 集成测试
npm run test:e2e      # E2E 测试（需先 build）
npm run build         # 构建：dist/client（前端）+ dist/server/api.js（服务）
npm start             # 生产启动 node dist/server/api.js
```

需要本机已安装 `claude` 或 `opencode` CLI 并在 PATH 中，agent 检测会自动发现它们。

## 配置

通过环境变量配置（均有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3006` | 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址（默认仅本机可访问） |
| `AUTH_TOKEN` | — | 可选 API 令牌；设置后所有 `/api/*`（含 SSE）都需要认证 |
| `DATABASE_URL` | — | 设置则用 postgres，否则用嵌入式 PGlite |
| `PGLITE_DATA_DIR` | `./data/pglite` | PGlite 数据目录 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `200` / `60000` | API 限流 |
| `AGENT_TIMEOUT_MS` | `1800000` | agent 子进程超时（30 分钟） |

**访问控制（可选）**：服务默认只监听 `127.0.0.1`。需要局域网或容器访问时，显式设置 `HOST=0.0.0.0`，并强烈建议同时设置 `AUTH_TOKEN`：

```bash
AUTH_TOKEN="$(openssl rand -hex 24)" HOST=0.0.0.0 npm start
```

设置后除 `/api/health` 外的所有 `/api/*` 请求（包括 `/api/projects/:id/events` 等 SSE 流）都要求凭证：

- **浏览器**：打开 `http://<host>:<port>/api/health?token=<AUTH_TOKEN>` 完成一次性登录——服务校验后写入 HttpOnly 登录 Cookie（30 天），并 302 到去掉 `token` 的地址；之后普通 `fetch` 与 `EventSource` 会自动携带 Cookie。
- **脚本 / API 客户端**：`Authorization: Bearer <AUTH_TOKEN>`。
- 静态资源与 `/api/health` 始终开放；未授权请求返回 401 `UNAUTHORIZED`，前端会弹出登录指引。
- 若 `HOST` 非回环地址且未设置 `AUTH_TOKEN`，启动时打印醒目安全警告（只警告，不拒绝启动）。
- 令牌比对使用 SHA-256 + `crypto.timingSafeEqual`（先哈希，长度不同也不会提前返回或泄漏长度）；日志不会输出令牌。

**语义检索（可选，默认关闭）**：在「设置 → 语义检索」配置 OpenAI 兼容的嵌入服务（Base URL / 模型 / API Key）。配置后章节正文与摘要会发送到该服务建立索引，搜索支持 `mode=semantic|hybrid`，写作阶段还会注入最多 3 个语义相关的更早章节片段。API Key 只存服务端、不回显；未配置时搜索、提示词与索引行为均保持不变。向量以 `real[]` 存储并在 JS 侧计算余弦（当前 PGlite 未内置 pgvector），未配置/调用失败时自动回退文本检索。

## 项目结构

```
src/
  api/            Hono 路由与中间件
  agent/          agent 子系统（spawn、流解析、prompt 组装、运行状态机）
  db/             Drizzle schema 与初始化
  plugins/        插件加载（plugins/ 目录下的技能包）
  server/         生产服务入口（静态服务 + SPA fallback）
  web/            React 前端（components / pages / hooks）
  shared/         前后端共享逻辑
plugins/          技能插件（reality / wuxia / novel）
tests/            unit / integration / e2e
drizzle/          数据库 migration（schema.ts 为唯一定义来源）
```

## 插件

每个插件是 `plugins/<name>/` 目录，包含 `open-novel.json`（清单）和 `SKILL.md`（技能指令），启动时自动加载。

## License

[MIT](./LICENSE) © 2026 wmzy。

MIT 是当前默认选择；版权持有人可随时修改 `LICENSE` 与 `package.json` 的 `license` 字段。

