# 逆向拆书（新「导入项目」）设计

**Date:** 2026-07-04
**Status:** Approved

## 动机

open-novel 当前只能从零「新建项目」或「打开项目」（注册一个已有的 `.novel/` 目录）。用户手上若只有一部已完成的小说原文（txt/md），无法利用 open-novel 的结构化写作辅助。

逆向拆书功能：接受原始文本文件或目录，AI 阅读分析后生成完整 `.novel/` 结构化数据（config / concept / outline / 角色档案 / 伏笔 / 状态），并自动产出故事脉络 timeline 与角色关系图，把任意小说变成一个 open-novel 项目。

### 命名调整

| 原按钮 | 新按钮 | 含义 |
|--------|--------|------|
| 导入项目 | **打开项目** | 注册一个已含 `.novel/` 结构的本地目录（原逻辑不变） |
| （无） | **导入项目** | 逆向拆书：从原文文本生成新项目 |

## 架构

### 总流程

```
用户给路径（文件 / 目录）
    ↓
[text-chunker 纯函数] 检测章节边界 → 标准化为 第N章.md
    ↓
[后端 POST /import-text] 建空 .novel/ 骨架 + 初始 config.json
    ↓
[Agent 自主多步] 逐章读 → 提取大纲 → 聚合角色 → 识别伏笔 → 写结构化文件
    ↓ （SSE 流式进度）
[后端] 注册 DB 记录 → 前端跳转项目页
    ↓
[角色关系图] 从 state.json.relationships 渲染 Mermaid graph（复用 MermaidDiagram）
```

### 处理模型：Agent 自主多步

复用现有 SSE run 系统（`createRun` / `emitEvent` / `launchAgent`）。后端启动一个 agent 会话，注入逆向拆解指令，agent 自己负责分块读取、逐步分析、写入 `.novel/` 文件。前端通过 SSE 看到 agent 的实时进度输出。

这复用 `runs.ts` 已有的 agent 驱动基础设施，不引入新的编排层。大文本由 agent 自行管理分块（每次读 2-3 章）。

## 组件

### 1. `src/shared/text-chunker.ts`（纯函数）

**职责：** 检测章节边界，切分原文，标准化为 `{ number, title, content }`。

```typescript
export interface ChunkedChapter {
  number: number;   // 1-based 章节序号
  title: string;    // 章节标题（无标题则「第N章」）
  content: string;  // 正文
}

export function detectChapters(source: ChunkSource): ChunkedChapter[];
export type ChunkSource =
  | { kind: 'file'; content: string; filename: string }
  | { kind: 'dir'; files: { name: string; content: string }[] };
```

**单文件切分策略（按优先级匹配）：**
1. `^第\s*([\d一二三四五六七八九十百千]+)\s*章` —— 中文章节标记
2. `^Chapter\s+(\d+)` / `^CHAPTER\s+(\d+)` —— 英文章节标记
3. `^(\d+)\s*[.、]\s+` —— 数字编号标题（`1. 标题` / `1、标题`）
4. 切分失败（<2 段）→ 整文件作为单章（number=1）

**目录切分策略：**
1. 过滤 `.txt` / `.md` 文件，按文件名**自然排序**
2. 文件名含数字 → 用作章节序号（如 `03.md` → 第 3 章）
3. 文件名无数字 → 按排序顺序递增，从内容首行提取标题
4. 每个文件若内部还有章节标记 → 进一步切分（罕见，但兼容）

**章节序号归一化：** 中文数字 → 阿拉伯数字（一二三 → 123），保证 `第N章.md` 命名一致。

**输出文件格式：** 每章写入 `.novel/chapters/第N章.md`，首行 `# 第N章 标题`，空行后正文。与现有系统（`readChapterFile`、`prompt-composer`）完全兼容。

### 2. `src/agent/reverse-decomposer.ts`

**职责：** 构建逆向拆解的 agent 指令 prompt。

```typescript
export function buildReverseDecomposePrompt(
  projectDir: string,
  chapterCount: number,
  meta?: { title?: string; genre?: string },
): string;
```

**Prompt 五步指令：**

```
你是一位资深文学分析师。请逆向拆解这部小说，逐步生成 open-novel 项目结构。

源章节文件：.novel/chapters/第N章.md（共 {N} 章）

按以下顺序分析并写入：

## 第一步·全局概览
读取第1章与最后1章。写入：
- .novel/config.json（补充 title/genre/perspective/chapterCount）
- .novel/concept.md（核心立意、故事内核、主题，约 300 字）

## 第二步·逐章大纲
每次读 2-3 章。为每章提取，写入 .novel/outline-detailed.md：
#### 第N章：标题
| POV | 核心事件 | 出场角色 | 情感弧线 | 写作定位 |
（沿用现有 outline-detailed 表格格式）

## 第三步·角色档案
汇总全部出场角色。为主要角色（出场≥3次）生成完整档案：
- 驱动力三角（欲望/需求/核心缺陷）
- 性格特征、外貌锚点、行为习惯、3 句典型台词
写入 .novel/characters/profiles.md（表格索引格式）+ .novel/characters/profiles/{name}.md
次要角色写入简表。

## 第四步·状态与伏笔
- .novel/state.json：每个角色的 location/emotion/knows/relationships/lastAppearance；
  timeline 推进到全书终局；activeForeshadows 收集所有 planted 伏笔。
- .novel/foreshadow.json：识别全书的伏笔（planted）与回收（resolved）。

## 第五步·滚动摘要
逐章读，为每章写约 200 字语义摘要到 .novel/chapters/第N章.summary.md。

完成后通过 POST 写回标记。
```

**关键：** `relationships` 字段写入 `state.json`（不新建 relationships.json）——与正向写作约定一致，角色关系图的唯一数据源。

### 3. `src/api/routes/projects.ts` — `POST /import-text`

**职责：** 接收源路径 → 切章 → 建骨架 → 启动 agent → SSE。

```
POST /api/projects/import-text
body: { path: string, title?: string, genre?: string }

1. 校验 path 存在（文件或目录）
2. text-chunker 检测章节 → ChunkedChapter[]
3. 若章节为 0 → 400 "未检测到有效文本"
4. 在 path 下创建 .novel/（若已存在 → 400 "该目录已是项目，请用打开项目"）
5. 写 .novel/config.json（章节切分结果，标题/类型留空待 agent 补）
6. 写 .novel/chapters/第N章.md（切分结果）
7. 创建 DB 项目记录（path = userPath）
8. buildReverseDecomposePrompt → createRun → launchAgent → SSE
9. 返回 { project, runId }；前端跳转项目页并接 SSE 流
```

与现有 `POST /import`（打开项目）并存：`/import` 要求 `.novel/` 已存在且完整；`/import-text` 从原文生成 `.novel/`。

### 4. `src/web/components/CharacterGraph.tsx`（纯函数 + 组件）

**职责：** 从 `state.json.characters[].relationships` 生成 Mermaid `graph` 源码并渲染。

```typescript
// 纯函数：state.json → Mermaid graph 源码（便于单测）
export function buildRelationshipGraph(state: NovelState): string;
// 输出示例：
// graph LR
//   武松([武松])
//   鲁智深([鲁智深])
//   武松 -.师徒.-> 鲁智深
//   鲁智深 -.敬畏的徒弟.-> 武松
```

**去重策略：** 若 A→B 与 B→A 同时存在且描述相同 → 合并为无向实线；描述不同 → 保留双向虚线。避免视觉噪声。

**渲染：** 复用 `MermaidDiagram` 组件渲染生成的 graph 源码。

### 5. `src/web/views/CharacterGraphView.tsx`

**职责：** 角色关系图视图页，与「故事脉络」timeline tab 同级。

- `GET /api/projects/:id/state` 读取 state.json
- 传给 `CharacterGraph` 渲染
- 空状态提示：「逆向拆书或正常写作后，角色关系将自动出现在此」

### 6. `src/web/pages/HomePage.tsx` UI 变更

- 「导入项目」按钮 → 改名「打开项目」（原 `/import` 逻辑不变）
- 新增「导入项目」按钮 → 弹出逆向拆书表单：
  - 源文本路径输入框（文件或目录）
  - 标题（可选，留空则 agent 自动识别）
  - 类型（可选，留空则 agent 自动识别）
  - 「开始拆书」按钮 → `POST /import-text`
- 提交后跳转项目页，接 SSE 流显示 agent 进度

## 数据流

```
[源文本] → text-chunker → chapters/第N章.md
                                    ↓
                        launchAgent(reverseDecomposePrompt)
                                    ↓ SSE
            agent 逐步写：config.json, concept.md,
            outline-detailed.md, profiles.md, profiles/{name}.md,
            state.json, foreshadow.json, 第N章.summary.md
                                    ↓
              state.json.relationships → CharacterGraphView → Mermaid graph
              outline-detailed.md → StoryArcView → timeline（已有，自动可用）
```

## 错误处理

| 场景 | 处理 |
|------|------|
| 路径不存在 | 400 "路径不存在" |
| 无可识别文本文件（空目录 / 非 txt/md） | 400 "未找到 .txt 或 .md 文件" |
| 章节切分失败（检测不到章节标记） | 降级为单章处理（不报错），config.chapterCount=1 |
| 目录已有 `.novel/` | 400 "该目录已是 open-novel 项目，请用「打开项目」" |
| Agent 中断 | 保留已生成的文件；项目仍可用，缺失文件按现有优雅降级处理 |
| state.json 无 relationships | 角色关系图显示空状态提示 |
| 原文超大（>50 万字） | agent 自行分块；不预设硬上限 |

## 测试策略

| 测试文件 | 覆盖 |
|----------|------|
| `tests/unit/shared/text-chunker.test.ts` | 单文件中文切分、英文切分、数字编号切分、无标记降级、中文数字归一化、目录排序、文件名数字提取、边界（空文件/单行） |
| `tests/unit/agent/reverse-decomposer.test.ts` | prompt 含五步指令、章节路径正确、title/genre 可选注入 |
| `tests/unit/shared/character-graph.test.ts` | `buildRelationshipGraph` 纯函数：空 state、双向合并、多角色、循环关系 |
| `tests/unit/api/import-text.test.ts` | 路径校验、切章结果落盘、.novel 骨架创建、已存在项目拒绝 |

## 不做的事（YAGNI）

- **不新建 `relationships.json`** —— 复用 `state.json.relationships`，与正向写作一致
- **不做后端多轮编排** —— agent 自主多步已足够；若大文本效果差再加
- **不做章节切分的 AI 辅助** —— 纯正则足够覆盖常见格式；罕见格式降级为单章
- **不修改 timeline 视图** —— outline-detailed.md 一旦生成，timeline 自动可用
