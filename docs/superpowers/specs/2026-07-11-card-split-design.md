# 设计：文件按卡牌拆分为独立文件

**日期**：2026-07-11
**范围**：`outline-detailed.md` / `world-building.md` / `concept.md` 三个大单文件拆分为目录 + 独立卡片文件 + 索引文件
**动机**：当前修订模式将整文件全文注入 prompt（`runs.ts:296` `reviseContent = await readFile(...)`），`outline-detailed.md` 达 83KB/180 章。agent 靠 grep 探索 + Read 精准定位 + @ 引用注入工作，大单文件导致：① 修订单卡时全文注入浪费 token 且定位不准；② 会话中 @ 无法引用单张卡；③ agent 的 grep 只返回单文件路径，无法定位到卡。已有成功先例：`characters/profiles/` 目录 + `profiles.md` 索引的模式，每个角色一个独立文件，体验良好。

---

## 1. 设计概览

将三个大单文件拆为「目录 + 索引 + 卡片文件」结构，复用已有的 `characters/profiles/` 模式。不做向后兼容（双读回退），代码只认新格式。现有项目通过迁移端点一次性转换。

```
.novel/
  concept/
    index.md              ← 索引：各要素标题表
    基本信息.md
    一句话梗概.md
    核心主题.md
    ...（13 个文件，对应 13 个 ## 节）
  world/
    index.md              ← 索引：各节标题 + 一句话摘要
    时代背景.md
    地理环境.md
    社会结构.md
    ...（11 个文件，对应 11 个 ## 节）
  outline/
    index.md              ← 索引：三幕结构 + 全部章节标题表
    chapters/
      第1章.md            ← 单章大纲卡
      第2章.md
      ...
      第180章.md
```

**不做的事**：
- ❌ 向后兼容 / 双读回退——只有一个旧项目，迁移即可
- ❌ 虚拟 section 路径——agent 的 grep/Read/@ 建立在真实文件之上，虚拟路径全部失效
- ❌ section 级 prompt 注入——同样绕不过 agent 工具链的真实文件约束

---

## 2. 索引文件格式

索引文件是全局上下文的锚点——agent grep 到卡片后需要全局上下文时，读索引而非读所有卡片。

### 2.1 `outline/index.md`

```markdown
# 详细大纲索引：《项目标题》

> 类型：武侠 ｜ 视角：第三人称 ｜ 目标字数：约 1000000 字 ｜ 共 180 章
> 每章独立文件位于 chapters/第N章.md

## 三幕结构

| 幕 | 章节范围 | 核心任务 |
|---|---|---|
| 第一幕·设置 | 第1–40章 | 建立日常世界，引入主角欲望与缺陷 |
| 第二幕·对抗 | 第41–140章 | 困境升级，主角在对抗中转变 |
| 第三幕·解决 | 第141–180章 | 高潮与解决 |

## 章节索引

| 章 | 幕 | 标题 | 文件 |
|---|---|---|---|
| 1 | 第一幕 | {标题} | chapters/第1章.md |
| 2 | 第一幕 | {标题} | chapters/第2章.md |
| ... | ... | ... | ... |
```

三幕分界来自 `outline-meta.json` 的 `actBreaks`（第一幕末章号、第二幕末章号）。

### 2.2 `world/index.md`

```markdown
# 世界观索引

| 节 | 摘要 | 文件 |
|---|---|---|
| 时代背景 | {首段截断 60 字} | 时代背景.md |
| 地理环境 | {首段截断 60 字} | 地理环境.md |
| ... | ... | ... |
```

### 2.3 `concept/index.md`

```markdown
# 概念索引

| 要素 | 摘要 | 文件 |
|---|---|---|
| 基本信息 | {首段截断 60 字} | 基本信息.md |
| 一句话梗概 | {首段截断 60 字} | 一句话梗概.md |
| ... | ... | ... |
```

---

## 3. 卡片文件格式

单卡内容 = 旧文件中该 `##` 标题下的全部内容（标题行 + 正文），原样保留，不二次加工。

`outline/chapters/第1章.md`：
```markdown
## 第 1 章：{章节标题} ｜ 第一幕·设置 ｜ 目标约 5556 字

- **结构定位**：开篇：建立日常世界，引入主角的欲望与缺陷
- **主要场景**：{一句话概括}
- **目标**：{主角想要达成什么}
- **冲突**：{什么阻碍了目标}
- **结果**：{本章结局}
- **伏笔/回调**：{埋下的伏笔}
```

`world/社会结构.md`：
```markdown
## 社会结构

（原 world-building.md 中 ## 社会结构 下的全部内容）
```

文档级 `#` 标题（如 `# 详细大纲：《愚公剑》`）不写入卡片，由 index.md 承载。

---

## 4. 后端合并读取接口

前端视图（OutlineView / WorldView / ConceptView）依赖 `parseSections()` 渲染卡片，输入是一整份合并 markdown。拆成目录后，需要后端读目录所有卡片 → 按 index.md 顺序拼合 → 返回单个 markdown 字符串，前端 `parseSections` 逻辑零改动。

```
GET /api/projects/:id/document/:type
  type = 'concept' | 'world' | 'outline'
  → 读 index.md + 遍历卡片，按 index 顺序拼合
  → 返回 { content: "# 文档标题\n\n## 节1\n...\n\n## 节2\n..." }
```

拼合规则：
1. 以 index.md 的 `# 标题` 行作为文档标题
2. 按 index 顺序，逐个读卡片文件，拼接内容（卡片本身自带 `##` 标题行）
3. 卡片之间用空行分隔

**为什么后端拼合而非前端逐文件拉取**：180 个卡片前端逐个 fetch 太慢；后端一次拼合并支持缓存。

### 4.1 SSE 文件变更监听适配

`ProjectPage.tsx` 的 `file-changed` path 匹配从精确文件名改为前缀匹配：
- `'concept.md'` → `startsWith('concept/')`
- `'world-building.md'` → `startsWith('world/')`
- `'outline-detailed.md'` → `startsWith('outline/')`

---

## 5. 各层改动详情

### 5.1 模板生成器（`template-generator.ts`）

```typescript
export interface SplitTemplateResult {
  indexContent: string;
  cards: Array<{ relativePath: string; content: string }>;
}
```

- `generateOutlineDetailed(options)` → 返回 `SplitTemplateResult`：index.md 内容 + 180 个章节卡片
- `generateOutlineBrief(options)` → 保持单文件（brief 本身短，无需拆分）
- `generateCharacterProfiles(options)` → 已是 `characters/profiles.md` 单文件，不在本次范围
- `generateScenes(options)` → 保持单文件（通常不长）

`TEMPLATE_GENERATORS` 和 `TEMPLATE_FILE_PATHS` 适配：拆分型的生成器返回结构体而非字符串，落盘逻辑改为逐文件写入。

### 5.2 落盘逻辑（`api/routes/projects.ts` 的 `generate-templates`）

适配 `SplitTemplateResult`：创建目录 → 写 index.md → 逐个写卡片。

### 5.3 上下文注入（`prompt-composer.ts`）

`buildCoreSettingLayer()`（概念+世界观注入层）：

```typescript
// concept：读 concept/index.md（短索引）+ 当前阶段相关卡片
const conceptIndex = await readNovelFile(projectDir, 'concept/index.md');
blocks.push(`#### 故事概念索引 (concept/index.md)\n${conceptIndex}`);

// world：读 world/index.md，替代旧的截断 hack
const worldIndex = await readNovelFile(projectDir, 'world/index.md');
blocks.push(`#### 世界观索引 (world/index.md)\n${worldIndex}`);
blocks.push(`> 如需详细设定，用 Read 工具读取 world/具体节.md`);
```

删掉 `WORLD_FULL_THRESHOLD` / `WORLD_SUMMARY_CHARS` 渐进式加载逻辑——拆分后每个节文件本身就是合理大小，不需要截断。

stage 指令中文件路径提示全部更新：`.novel/concept.md` → `.novel/concept/`，`.novel/world-building.md` → `.novel/world/`，`.novel/outline-detailed.md` → `.novel/outline/`。

### 5.4 章节上下文（`chapter-context.ts`）

```typescript
// 旧：readNovelFile('outline-detailed.md') + 正则定位 ## 第N章
// 新：readNovelFile(`outline/chapters/第${chapter}章.md`)
```

删掉 section 定位正则（`OUTLINE_FILE` 常量、startIdx/endIdx 逻辑）。

### 5.5 时间线（`timeline.ts`）

```typescript
// 旧：readFile('outline-detailed.md') + parseOutlineChapters(全文) + 正则回写
// 新：遍历 outline/chapters/ 目录，逐文件解析 + 逐文件回写
```

`parseOutlineChapters` 改为接收单个卡片内容；`replaceChapterInteraction` 改为读写单文件。

### 5.6 实体提取（`entity-dict.ts` + `useEntityDict.ts`）

`entity-dict.ts` 本身不动（已按 `sources: Array<{path, content}>` 接口设计）。

调用方 `useEntityDict.ts`：候选文件收集范围从 `['world-building.md']` 改为 `world/*.md`（排除 index.md），`concept.md` → `concept/*.md`。

### 5.7 逆向分解（`reverse-decomposer.ts`）

prompt 指令更新：逐章写入 `outline/chapters/第N章.md`，完成后更新 `outline/index.md` 章节索引。

### 5.8 深化（`deepen.ts`）

```typescript
// STAGE_OUTPUT_FILES
// 旧：concept: ['concept.md'], world: ['world-building.md'], outline: ['outline-detailed.md', ...]
// 新：concept: ['concept/'], world: ['world/'], outline: ['outline/']
```

校验逻辑适配目录模式（检查目录下卡片文件而非单文件）。

agent prompt 中 `先读取 .novel/world-building.md` → `先读取 .novel/world/ 目录下相关卡片`。

### 5.9 enricher（`enricher.ts`）

盘点逻辑适配：检查 `concept/` / `world/` / `outline/` 目录而非单文件。`只增不覆盖` 原则不变——对已有卡片文件不改，只创建缺失卡片。

### 5.10 前端视图

`OutlineView` / `WorldView` / `ConceptView` / `WuxiaView`：

```typescript
// 旧：useNovelFile(projectId, stage, 'outline-detailed.md')
// 新：useNovelDocument(projectId, 'outline')
```

新增 `useNovelDocument(projectId, docType)` hook：调用 `GET /api/projects/:id/document/:type`，返回合并后的 markdown 字符串。`parseSections` 逻辑零改动。

`useFileRevision` 的 `targetFile` 改为卡片路径（如 `outline/chapters/第50章.md`），修订注入单卡而非整文件——**这是本次拆分的核心收益**。

**卡片级修订简化**：当前 card-level-revision 用 `openRevise(undefined, sectionTitle)` 前端拼锚点，是因为 `targetFile` 只能指向整文件。拆分后每张卡是真实文件，`openRevise` 直接传卡片路径（如 `openRevise('concept/核心主题.md')`），`sectionTitle` 参数和前缀拼接 hack 全部删除。agent 收到的 `reviseContent` 就是这张卡的内容，天然精准。

### 5.11 导出（`export.ts`）

```typescript
// 旧：readFile('concept.md')
// 新：拼合 concept/ 目录所有卡片
```

### 5.12 迁移端点

```typescript
POST /api/projects/:id/migrate-split
```

逻辑：
1. 检测旧格式文件是否存在（`concept.md` / `world-building.md` / `outline-detailed.md`）
2. 对每个旧文件：readFile → parseSections 切分 → 创建目录 → 写 index.md → 逐个写卡片文件 → 删旧文件
3. 返回迁移结果（拆分了多少文件）

UI：ProjectPage 加「迁移到卡片格式」按钮，仅当检测到旧格式文件存在时显示。

### 5.13 context-manager 兼容

`context-manager.ts` 中涉及 concept/world 文件路径的常量和读取函数更新：
- `readNovelFile(projectDir, 'concept.md')` → `readNovelFile(projectDir, 'concept/index.md')`
- `readNovelFile(projectDir, 'world-building.md')` → `readNovelFile(projectDir, 'world/index.md')`

`ensureContextArtifacts` 的兜底逻辑适配目录结构。

---

## 6. 迁移策略

**手动迁移端点**（已与用户确认）：
- 提供 `POST /api/projects/:id/migrate-split` 端点
- UI 按钮显式触发（仅旧格式项目显示）
- 新项目直接用目录格式
- 不做向后兼容代码，迁移后旧文件删除

---

## 7. 影响文件清单

| 文件 | 改动类型 |
|---|---|
| `src/shared/template-generator.ts` | 拆分型生成器返回 `SplitTemplateResult` |
| `src/api/routes/projects.ts` | 落盘逻辑适配 + 迁移端点 |
| `src/agent/prompt-composer.ts` | 注入层适配目录 + 删截断 hack + stage 指令路径更新 |
| `src/agent/chapter-context.ts` | 读单章卡片文件 |
| `src/api/routes/timeline.ts` | 遍历目录 + 逐文件解析回写 |
| `src/web/hooks/useEntityDict.ts` | 候选文件收集范围改目录 |
| `src/agent/reverse-decomposer.ts` | prompt 指令更新 |
| `src/shared/deepen.ts` | `STAGE_OUTPUT_FILES` + agent prompt 路径 |
| `src/agent/enricher.ts` | 盘点逻辑适配目录 |
| `src/web/components/views/OutlineView.tsx` | 用 `useNovelDocument` |
| `src/web/components/views/WorldView.tsx` | 用 `useNovelDocument` |
| `src/web/components/views/ConceptView.tsx` | 用 `useNovelDocument` |
| `src/web/components/views/WuxiaView.tsx` | 用 `useNovelDocument` |
| `src/web/hooks/useNovelDocument.ts` | **新建**：合并文档读取 hook |
| `src/api/routes/documents.ts` | **新建**：合并读取接口 |
| `src/web/hooks/useFileRevision.ts` | targetFile 改卡片路径 |
| `src/web/pages/ProjectPage.tsx` | SSE 监听前缀匹配 + 迁移按钮 |
| `src/agent/context-manager.ts` | 文件路径常量更新 |
| `src/api/routes/export.ts` | 拼合目录卡片 |
| `src/shared/diagram-builders.ts` | 文件路径引用更新（如有） |

---

## 8. 不做的事（YAGNI）

- ❌ 向后兼容 / 双读回退——只有一个旧项目，迁移即可
- ❌ scenes.md 拆分——通常不长，收益低
- ❌ outline-brief.md 拆分——brief 本身是精简版，无需拆
- ❌ characters/profiles.md 改动——已是目标格式，本次不动
- ❌ diff 预览改造——`RevisionDiffPanel` 全局监听已覆盖，卡片级 diff 天然支持
- ❌ 卡片多选批量操作——超出范围

---

## 9. 验证方式

1. `npm run typecheck` → `npm run test` → `npm run build`
2. 模板生成器：新项目生成后检查目录结构（index.md + 卡片文件齐全）
3. 迁移端点：对旧项目执行迁移，验证卡片数 = section 数，内容无损
4. 上下文注入：写作时检查注入的是 index + 单卡而非整文件
5. 前端视图：三个视图正常渲染，卡片级 ✎ 修订只注入单卡
6. E2E：新项目全流程（concept → world → outline → writing）+ 迁移旧项目
