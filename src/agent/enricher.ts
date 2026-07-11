/**
 * 数据补全 agent prompt 构建器。
 *
 * 与 buildReverseDecomposePrompt（/import）同构，差异：
 * - 输入源：当前项目已有的结构化文件（大纲/档案/世界观），而非外部章节正文
 * - 核心约束：只增不覆盖——已有内容的文件绝不修改，仅创建缺失产物或填充空字段
 *
 * 适用场景：
 * - 旧工具迁移来的项目缺 state.json / outline-meta.json
 * - 工具版本升级后新增的结构化字段需要回填
 * - 角色关系图数据（state.json.relationships）从未生成
 */

export interface EnrichMeta {
  /** 项目根目录的绝对路径。agent 仅可读写此目录下的 .novel/ 子目录。 */
  projectDir: string;
}

export function buildEnrichPrompt(meta: EnrichMeta): string {
  return `你是一位资深文学分析师。请扫描当前 open-novel 项目，识别并补全缺失的结构化数据。

项目目录：${meta.projectDir}
所有内容读写仅限项目目录下的 .novel/ 子目录。绝不访问项目目录之外的任何文件。

## 核心原则：只增不覆盖
已有内容的文件（concept/、world/、outline/ 目录、outline-brief.md、characters/profiles/*.md、characters/profiles.md、wuxia/*.md 等）**绝不修改**。
仅创建缺失的文件，或向已有文件中的空字段填写数据。

## 第一步·盘点
列出 .novel/ 下全部文件，识别哪些结构化产物缺失或为空：
- .novel/outline-meta.json（三幕分界 + 每章 POV 映射）
- .novel/state.json（角色状态表 + relationships + timeline + activeForeshadows）
- .novel/chapters/第N章.summary.md（滚动摘要）

## 第二步·outline-meta.json
若文件缺失，或 chapters 数组的 pov 字段为空：
读取 .novel/outline/chapters/ 目录下的章节卡片，从每章的 POV 字段（| POV | 视点角色 | 或 - **POV**：视点角色）提取视点角色。
生成 outline-meta.json，格式：
{
  "actBreaks": [第一幕末章号, 第二幕末章号],
  "chapters": [{ "chapter": 1, "pov": "角色名" }, ...]
}
三幕分界按总章节数的 25%/50%/25% 划分。

## 第三步·state.json
若 .novel/state.json 缺失或 characters 数组为空：

### 3.1 角色名清单
从 .novel/characters/profiles/*.md（独立档案文件名）或 characters/profiles.md（表格索引）提取全部角色名。

### 3.2 角色状态
为每个角色建立状态对象：
{ "name": "角色名", "location": "", "emotion": "", "knows": [], "relationships": {}, "lastAppearance": null }
location/emotion 可从档案中的当前状态推断（若档案无明确信息则留空）。

### 3.3 relationships 反推（角色关系图数据源）
按优先级提取角色间关系，写入每个角色的 relationships 字段（键=对方角色名，值=关系描述）：
1. 若有 .novel/characters/角色关系图.md，从 mermaid 图的边（A -->|关系| B）提取
2. 否则从 profiles/*.md 档案中"关系""敌对""师徒"等段落提取

### 3.4 timeline 与 activeForeshadows
- timeline：若 outline/ 目录有章节卡片，提取关键节点推进到当前进度
- activeForeshadows：若 .novel/foreshadow.json 存在，收集 status=planted 的条目 ID。
  若需新建 foreshadow.json，**必须用标准 schema**：\`{ "foreshadows": [{ "id": 1, "content": "描述", "status": "planted", "plantedIn": null, "resolvedIn": null }] }\`。
  顶层键为 \`foreshadows\`（不是 items），内容字段为 \`content\`（不是 description）。

## 第四步·章节滚动摘要（仅有正文时）
若 .novel/chapters/ 下存在正文文件（第N章.md）但缺对应的 .summary.md：
逐章读正文，写约 200 字语义摘要到 第N章.summary.md（含情节推进、角色状态变化、伏笔动态）。
严禁复制原文段落。

若无章节正文（项目仅有大纲，尚未开始写作），跳过此步。

## 完成后报告
列出本次创建/补充了哪些文件，以及哪些已有文件被跳过（受"只增不覆盖"保护）。`;
}
