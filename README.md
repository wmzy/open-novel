# open-novel

AI 辅助小说写作应用：通过调用外部 AI 编码 agent（`claude` / `opencode` CLI）完成从立意到成稿的全流程创作，前端实时展示 agent 的流式输出与文件操作。

## 工作流

创作被拆分为若干阶段，每个阶段产出对应的 `.novel/` 文件：

```
concept → world → characters → outline → scenes → writing → revision → polish
 立意     世界观    人物设定     大纲      场景      写作      修订       润色
```

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
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATABASE_URL` | — | 设置则用 postgres，否则用嵌入式 PGlite |
| `PGLITE_DATA_DIR` | `./data/pglite` | PGlite 数据目录 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `200` / `60000` | API 限流 |
| `AGENT_TIMEOUT_MS` | `1800000` | agent 子进程超时（30 分钟） |

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
