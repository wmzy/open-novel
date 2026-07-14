# 各阶段定制灵感按钮设计

> 日期：2026-07-15
> 背景：大纲、场景等视图缺少「✎修订」「⇄重命名」「💡灵感」按钮，与角色视图不一致。

## 问题

各视图 header 按钮配置不一致：

| 视图 | ✎修订 | ⇄重命名 | 🔁深化 | 💡灵感 |
|------|:---:|:---:|:---:|:---:|
| CharacterView | ✓ | ✓ | ✓ | ✓ |
| ConceptView | ✓ | ✓ | ✓ | ✗ |
| WorldView | ✓ | ✓ | ✓ | ✗ |
| WuxiaView | ✓ | ✓ | ✓ | ✗ |
| OutlineView | ✗ | ✗ | ✓ | ✗ |
| SceneView | ✗ | ✗ | ✓ | ✗ |

现有 `InspirationPicker` 是**角色专用**硬编码（门派/原型/功能定位/关系张力等维度全围绕角色），无法直接复用到其他阶段。

## 设计决策

用户选择「各阶段定制维度」+「补齐所有缺按钮视图」。

### 架构

1. **`shared/inspiration.ts`** 新增数据驱动的多阶段灵感框架：
   - `INSPIRE_STAGES: Record<InspireStage, InspireStageDef>` —— 6 阶段（character/concept/world/outline/scene/wuxia）的维度定义。
   - 每个 `InspireDimensionDef` 含 `id`/`label`/可选 `params`（text 输入或 select 下拉，标记 required）。
   - `buildStageInspirationMessage(stage, dimensionId, params)` —— 组装消息，复用「跳过采访、直接给 N 个种子」模式。
   - **保留**现有角色专用导出（`Dimension`/`buildInspirationMessage`/`buildCharacterEnrichMessage`）不变，角色阶段维度定义照搬现有逻辑纳入 `INSPIRE_STAGES.character`。

2. **`InspirationPicker`** 改为接收 `stage: InspireStage` prop：
   - 从 `INSPIRE_STAGES[stage]` 读取维度定义，数据驱动渲染（维度下拉 → 动态参数区 → 生成按钮）。
   - 消息构建走 `buildStageInspirationMessage`，dispatch `INSPIRE_TO_CHAT_EVENT`（ChatPanel 已监听，无需改动）。
   - CharacterView 传 `stage="character"`。

3. **卡片级角色丰富**（`InlineInspiration`/`buildCharacterEnrichMessage`）保持不动。

### 各阶段维度

参考 `deepen.ts` 的 `DEEPEN_DIMENSIONS` 质量维度定制：

| 阶段 | 维度 (id: label) | 带参数 |
|------|------------------|--------|
| concept | conflict:冲突锐化 / twist:反转点子 / premise:前提变体 / hook:开头钩子 / random:随机刺激 | premise 可选关键词 |
| world | faction:势力格局 / rule:规则体系 / geography:地理拓展 / culture:文化习俗 / random:随机刺激 | faction 可选势力名, rule 可选体系 |
| outline | turn:剧情转折 / foreshadow:伏笔设计 / pacing:节奏调整 / climax:高潮设计 / random:随机刺激 | turn 可选章节范围 |
| scene | conflict:冲突升级 / atmosphere:氛围营造 / reveal:信息揭露 / transition:转场设计 / random:随机刺激 | — |
| wuxia | sect:门派设计 / martial:武学体系 / jianghu:江湖格局 / artifact:奇物神兵 / random:随机刺激 | sect 可选门派名, martial 类型 select |

### 按钮补齐

| 视图 | 新增按钮 | revision targetFile |
|------|---------|---------------------|
| OutlineView | ✎修订 + ⇄重命名 + 💡灵感(stage=outline) | `outline/index.md` |
| SceneView | ✎修订 + ⇄重命名 + 💡灵感(stage=scene) | `scenes.md` |
| ConceptView | 💡灵感(stage=concept) | 已有 |
| WorldView | 💡灵感(stage=world) | 已有 |
| WuxiaView | 💡灵感(stage=wuxia) | 已有 |

## 不改动

- ChatPanel 的 `INSPIRE_TO_CHAT_EVENT` 监听逻辑。
- `InlineInspiration`、`buildCharacterEnrichMessage`（卡片级角色丰富）。
- 深化按钮、视图数据加载逻辑。

## 验证

- `pnpm tsc --noEmit` typecheck 通过。
- 浏览器 smoke test：各视图灵感按钮可展开维度选择、生成消息注入对话。
