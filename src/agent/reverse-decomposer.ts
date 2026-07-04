/**
 * 逆向拆解 agent prompt 构建器。
 * agent 自主多步：逐章读 → 提取大纲 → 聚合角色 → 识别伏笔 → 写结构化文件。
 */

export interface DecomposeMeta {
  projectDir: string;
  chapterCount: number;
  title?: string;
  genre?: string;
}

export function buildReverseDecomposePrompt(meta: DecomposeMeta): string {
  const hints: string[] = [];
  if (meta.title) hints.push(`参考标题：「${meta.title}」（agent 可调整）`);
  if (meta.genre) hints.push(`参考类型：「${meta.genre}」（agent 可调整）`);
  const hintBlock = hints.length > 0 ? `\n${hints.join('\n')}\n` : '';

  return `你是一位资深文学分析师。请逆向拆解这部小说，逐步生成 open-novel 项目结构。

源章节文件：.novel/chapters/第N章.md（共 ${meta.chapterCount} 章）${hintBlock}
所有内容写入项目目录 ${meta.projectDir} 下的 .novel/ 子目录。绝不访问项目目录之外的文件。

按以下顺序分析并写入：

## 第一步·全局概览
读取第1章与最后1章（.novel/chapters/第1章.md、.novel/chapters/第${meta.chapterCount}章.md）。写入：
- .novel/config.json（补充 title/genre/perspective/chapterCount/targetWords）
- .novel/concept.md（核心立意、故事内核、主题，约 300 字）

## 第二步·逐章大纲
每次读 2-3 章。为每章提取，写入 .novel/outline-detailed.md，每章用此格式：
#### 第N章：标题
| POV | 视点角色 |
| 核心事件 | 本章核心事件 |
| 出场角色 | 角色、角色 |
| 情感弧线 | 情感走向 |
| 写作定位 | 在全书结构中的位置 |

## 第三步·角色档案
汇总全部出场角色。为主要角色（出场≥3次）生成完整档案：
- 驱动力三角（欲望/需求/核心缺陷）
- 性格特征、外貌锚点、行为习惯、3 句典型台词
写入 .novel/characters/profiles.md（表格索引格式）+ .novel/characters/profiles/{name}.md
次要角色写入简表。

## 第四步·状态与伏笔
- .novel/state.json：每个角色的 name/location/emotion/knows/relationships/lastAppearance；
  relationships 字段是角色关系图的唯一数据源，键=对方角色名，值=关系描述（如 "武松":"对手"）；
  timeline 推进到全书终局；activeForeshadows 收集所有 planted 伏笔。
- .novel/foreshadow.json：识别全书的伏笔（status=planted）与回收（status=resolved）。

## 第五步·滚动摘要
逐章读，为每章写约 200 字语义摘要到 .novel/chapters/第N章.summary.md。
摘要包含：本章情节推进、角色状态变化、伏笔兑现或新增。严禁复制原文段落。`;
}
