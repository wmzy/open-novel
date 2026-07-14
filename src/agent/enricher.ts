/**
 * 数据补全 agent prompt 构建器。
 *
 * 与 buildReverseDecomposePrompt（/import）同构，差异：
 * - 输入源：当前项目已有的结构化文件（大纲/档案/世界观），而非外部章节正文
 * - 核心约束：只增不覆盖——已有内容绝不修改，仅创建缺失产物、填充空字段、或向文件末尾追加新 `##` 节
 *
 * 适用场景：
 * - 旧工具迁移来的项目缺 state.json / outline-meta.json
 * - 工具版本升级后新增的结构化字段需要回填
 * - 角色关系图数据（state.json.relationships）从未生成
 * - 插件模板新增 `##` 维度节后，旧项目需补充缺失维度（如 wuxia 新增江湖经济/情报网络等节）
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getPlugin } from '../plugins/registry';

export interface EnrichMeta {
  /** 项目根目录的绝对路径。agent 仅可读写此目录下的 .novel/ 子目录。 */
  projectDir: string;
  /** 插件 ID（如 'wuxia'）。用于对比模板，检测缺失的 `##` 维度节。 */
  skillId?: string;
}

/** 从 markdown 文本中提取 `##` 节标题（去除前缀，不含 `###` 及以下）。 */
function extractSectionTitles(md: string): string[] {
  return md
    .split('\n')
    .filter((l) => l.startsWith('## ') && !l.startsWith('### '))
    .map((l) => l.replace(/^##\s+/, '').trim());
}

/** 模板与项目文件 diff 的单条结果。 */
interface MissingSection {
  /** 项目内相对路径（如 world-building.md、characters/profiles.md）。 */
  file: string;
  /** 缺失的 `##` 节标题。 */
  titles: string[];
}

/**
 * 对比插件模板与项目文件，找出模板有但项目缺少的 `##` 节。
 * 同步遍历 templates/ 目录下所有 .md 文件，逐文件做标题 diff。
 * 无 skillId 或无 templates 目录时返回空数组（跳过维度补充）。
 */
function detectMissingSections(projectDir: string, skillId?: string): MissingSection[] {
  if (!skillId) return [];
  const plugin = getPlugin(skillId);
  if (!plugin) return [];
  const templatesDir = path.join(plugin.path, 'templates');
  if (!existsSync(templatesDir)) return [];

  const results: MissingSection[] = [];
  const walk = (dir: string, base: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = base ? path.join(base, entry.name) : entry.name;
      const srcPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, relPath);
      } else if (entry.name.endsWith('.md')) {
        const templateTitles = extractSectionTitles(readFileSync(srcPath, 'utf-8'));
        if (templateTitles.length === 0) continue;
        const projectFile = path.join(projectDir, '.novel', relPath);
        let projectTitles: string[] = [];
        if (existsSync(projectFile)) {
          projectTitles = extractSectionTitles(readFileSync(projectFile, 'utf-8'));
        }
        const missing = templateTitles.filter((t) => !projectTitles.includes(t));
        if (missing.length > 0) {
          results.push({ file: relPath, titles: missing });
        }
      }
    }
  };
  walk(templatesDir, '');
  return results;
}

export function buildEnrichPrompt(meta: EnrichMeta): string {
  const missingSections = detectMissingSections(meta.projectDir, meta.skillId);
  const dimensionStep = missingSections.length > 0
    ? `\n## 第五步·模板维度补充（追加，不覆盖）\n以下文件相比插件模板缺少 \`##\` 维度节，须补充：\n${missingSections.map((s) => `- .novel/${s.file}：缺少「${s.titles.join('」「')}」`).join('\n')}\n\n为每个缺失节生成内容，**追加**到对应文件末尾：\n1. 先读取该文件已有内容，理解当前世界观/角色/情节上下文\n2. 参考 SKILL.md 中对应的附录框架（如附录七江湖经济、附录十情报网络等）获取设计指引\n3. 在文件末尾先加一行 \`---\` 分隔线，再写 \`## 节标题\` 和具体内容\n4. **追加而非覆盖**——绝不修改文件中的已有内容，仅在末尾添加新节\n5. 内容须与已有节风格一致——具体、有细节、有例子，而非泛泛而谈\n`
    : '';

  return `你是一位资深文学分析师。请扫描当前 open-novel 项目，识别并补全缺失的结构化数据。

项目目录：${meta.projectDir}
所有内容读写仅限项目目录下的 .novel/ 子目录。绝不访问项目目录之外的任何文件。

## 核心原则：只增不覆盖
已有内容**绝不修改**——仅在文件末尾追加新 \`##\` 节（模板维度补充）、创建缺失文件、或向已有文件中的空字段填写数据。

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
${dimensionStep}
## 完成后报告
列出本次创建/补充了哪些文件，以及哪些已有文件被跳过（受"只增不覆盖"保护）。`;
}
