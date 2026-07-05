# 设计：小说文档实体链接（角色/武器/武功/门派/地名/招式自动链接化）

**日期**：2026-07-05
**范围**：章节正文预览的实体自动识别 + 点击弹窗查看档案详情
**动机**：作者读章节正文时，遇到角色名、武器名、武功名等想快速查看其档案设定，目前只能手动切到角色/世界观视图翻找。在正文里把这些已建档的实体名渲染成可点击链接，点击弹窗展示该实体在档案中的完整设定节，降低上下文切换成本。

---

## 1. 已确认的核心决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 实体识别方式 | **自动识别**（从档案构建词典扫描正文） | 复用项目「数据都在 markdown」惯例，零额外维护 |
| 实体类型覆盖 | **全类型**：角色 + 外号 + 武器 + 武功 + 门派 + 招式 + 地名 | 覆盖武侠最核心实体；非武侠流派自然降级为仅角色 |
| 弹窗内容 | **档案原文渲染**（该实体所属 heading 节的 markdown 原文，react-markdown 渲染） | 信息完整、对所有实体类型统一、复用现有渲染管线 |

**三个技术细节默认值**（spec review 阶段可调）：
- 弹窗 = 档案节原文渲染（不做字段化卡片）——已被「档案原文渲染」决策覆盖
- 匹配边界：实体名前后若是 `[A-Za-z0-9]` 则不匹配（防英文误伤）；汉字不限边界
- 作用范围：仅 `EditorPanel` 的「预览」模式；edit 模式 textarea 不动；其他视图不加

---

## 2. 设计概览

```
档案文件 (profiles.md / world-building.md / wuxia/*.md)
        │  useNovelFile 拉取（已有，react-query 缓存）
        ▼
实体词典 Map<实体名, EntityRef>        ← buildEntityDict() 纯函数（新增）
        │  useMemo 缓存（依赖档案文本）
        ▼
章节正文 content
        │
        ▼
splitTextByEntities(text, dict)        ← 纯函数（新增）
  返回 Array<{ text: string } | { ref: EntityRef }>
        ▼
EntityMarkdown 包装 react-markdown      ← 新组件
  注入自定义 components.text renderer
  把命中片段渲染为 <EntityLink>
        ▼
点击 <EntityLink> → setDialogEntity(ref)
        ▼
<EntityDetailDialog>                   ← 新组件
  按 ref.file 拉档案 → 定位 ref.sectionTitle 节 → react-markdown 渲染 sectionRaw
```

**核心思想**：词典构建和文本扫描都是**纯函数**，可独立单测；UI 层只拼装。实体详情 = 该实体在档案中所属 heading 节的原文（统一逻辑，适用所有实体类型）。

**接入点**：仅 `EditorPanel.tsx` preview 分支（当前第 222 行 `<Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>` 替换为 `<EntityMarkdown ...>`）。零后端，零数据库改动。

---

## 3. 实体源解析规则

### 3.1 实体来源（按优先级）

**关键现实约束**（已查证）：
- `wuxia/` 目录是**可选的**——SKILL.md 明确说武侠设定可全放进 `world-building.md` 的子节，不必另建目录。
- `wuxia/` 内文件名不固定，`WuxiaView.categorizeWuxiaFiles` 用正则 `/martial|功法|武功|武学/`、`/weapon|兵器|神兵|兵刃/`、`/sect|门派|势力|江湖/` 按文件名归类。
- 真实 `profiles.md` 字段值多为**空字符串**（`- 姓名：`），`isPlaceholder` 只检测 `{...}`，不检测空值。

| 实体类型 | 来源 | 提取规则 |
|---|---|---|
| 角色 | `characters/profiles.md`（必有） | 每个角色分组的 `- 姓名：xxx` 字段值；分组 `##`/`###` 标题里括号前的名字（如「一、林冲（主角）」→「林冲」） |
| 外号 | 同上 | `- 外号：xxx` 字段值；角色标题括号内（`（醉仙）`→「醉仙」） |
| 武器 | `wuxia/*.md`（文件名匹配 `/weapon\|兵器\|神兵\|兵刃/`）或 `world-building.md` 的「兵器/神兵」节 | 文件内 `##`/`###` 标题名 |
| 武功 | `wuxia/*.md`（文件名匹配 `/martial\|功法\|武功\|武学/`）或 `world-building.md` 的「武功/武学/功法」节 | 文件内 `##`/`###` 标题名 |
| 门派 | `wuxia/sects.md`、`wuxia/sects/*.md` 或 `world-building.md` 的「门派/势力/江湖」节 | `##`/`###` 标题名 |
| 招式 | 武功节下的列表项 | 子节标题含 `招式`/`招`/`绝招`/`杀招` 时，该子节内 `- xxx`/`* xxx` 列表项首列文本（去 markdown 加粗/链接标记）作为招式实体；子节标题不含上述关键词则不解析 |
| 地名 | `world-building.md` | `## 地理`/`## 地理环境` 节内 `###` 子标题名 |

**降级行为**：非武侠流派无 `wuxia/` 目录、`world-building.md` 也无武功/兵器节 → 词典只含角色+外号+地名，自然降级，无报错。

### 3.2 EntityRef 数据结构

```typescript
export type EntityType = 'character' | 'alias' | 'weapon' | 'martial' | 'sect' | 'move' | 'place';

export interface EntityRef {
  /** 实体显示名（词典 key）。 */
  name: string;
  /** 实体类型。 */
  type: EntityType;
  /** 档案文件相对路径，如 "characters/profiles.md"、"wuxia/weapon.md"、"world-building.md"。 */
  file: string;
  /** 该实体所属 heading 节的标题（用于定位 + 弹窗标题）。 */
  sectionTitle: string;
  /** 该实体所属节的完整 markdown 原文（弹窗直接渲染）。构建词典时即截取。 */
  sectionRaw: string;
}
```

### 3.3 词典构建纯函数签名

```typescript
/**
 * 从若干档案文本构建实体词典。
 * @param sources 档案文件路径 + 内容列表（调用方决定拉哪些文件）
 * @returns Map<实体名, EntityRef>；同名实体保留第一个出现的（角色优先于外号同名）
 *
 * 过滤规则：
 *  - name 长度 < 2 跳过（≥2 字符约束，沿用 rename engine）
 *  - name 是 isPlaceholder（{...} 模板占位）跳过
 *  - name 是空字符串跳过（真实 profiles 字段值常为空）
 *  - name 含「xxx」「姓名」「{」等明显模板词跳过
 */
export function buildEntityDict(
  sources: Array<{ path: string; content: string }>,
): Map<string, EntityRef>;
```

**实现要点**：
- 复用 `parseSections()` 把每个档案切成 `MdSection`（已有，按 `##`/`###` 切节）。
- 每个 section 的 `title` 本身是候选实体名（武器/武功/门派/地名/角色分组）；section 内的 `- 姓名：`/`- 外号：` 字段值是角色/外号实体名。
- `sectionRaw` = 该 section 从其标题行到下一个同级标题之间的原文（含标题行）。
- 调用方（hook）按固定顺序喂 source：profiles.md → world-building.md → wuxia/*.md，确保角色优先于同名其他实体。

### 3.4 同名冲突处理

- 同名不同类型：保留**第一个**出现的（source 喂入顺序决定优先级：角色 > 外号 > 地名 > 武功/武器/门派/招式）。
- 同名同类型不同文件：保留第一个（罕见，武侠档案里不会两个门派同名）。
- EntityRef 只存一个，弹窗只展示一个档案节——简单可预期。

---

## 4. 文本切片纯函数

```typescript
export interface TextSegment {
  /** 普通文本段。 */
  text?: string;
  /** 命中实体（二选一）。 */
  ref?: EntityRef;
}

/**
 * 把正文按实体词典切片。
 * @param text 章节正文（一段纯文本，已由 react-markdown text 节点传入）
 * @param dict 实体词典
 * @returns 有序段数组，普通段与实体段交替
 *
 * 匹配策略：
 *  1. 词典按 name 长度降序排（最长优先，解决「林冲」vs「林冲之」）
 *  2. 单次遍历正文每个字符位置，对每个位置尝试匹配最长词典项
 *  3. 边界规则：命中区间 [start, end) 的前一个字符和后一个字符若为 [A-Za-z0-9] 则拒绝匹配（防英文误伤）；汉字/标点不限
 *  4. 已匹配区间标记占用，后续不再匹配（防嵌套）
 *  5. ≥2 字符（构建词典时已过滤，这里双保险）
 *
 * 性能：n=正文字符数，m=词典大小。O(n·m) 最坏，但 m 通常 <200、n 通常 <1万，实测可忽略。
 * 若未来词典爆炸，改 Aho-Corasick——当前 YAGNI。
 */
export function splitTextByEntities(text: string, dict: Map<string, EntityRef>): TextSegment[];
```

**边界规则示例**（汉字不限边界，英文做边界）：
- 正文「林冲道」「林冲的」「林冲，」→ 匹配「林冲」（前后汉字/标点不限）
- 正文「他叫Lin出战」→ 若词典有「Lin」，匹配（前后是汉字，不拦）
- 正文「Linear algebra」→ 词典有「Lin」，**不匹配**（「Lin」后继「e」是英文字母，拒绝）
- 正文「a Lin b」→ 词典有「Lin」，匹配（前继空格后继空格，非 [A-Za-z0-9]）

> **规则形式化**：仅当实体名**首字符是 `[A-Za-z]`** 时，检查前导字符是否也是 `[A-Za-z0-9]`（是则拒绝）；仅当实体名**末字符是 `[A-Za-z]`** 时，检查后继字符是否也是 `[A-Za-z0-9]`（是则拒绝）。汉字实体名首尾不是 `[A-Za-z]`，不触发检查 → 汉字不限边界。这样既防英文误伤，又不影响中文匹配。

---

## 5. UI 组件

### 5.1 `useEntityDict` hook

```typescript
// src/web/hooks/useEntityDict.ts
export function useEntityDict(projectId: string): {
  dict: Map<string, EntityRef>;
  isLoading: boolean;
};
```

- 用 `useNovelFileList`（已有）列出 `.novel/` 下所有 md 文件。
- 用 `useNovelFile`（已有，react-query 缓存）并行拉取：`characters/profiles.md`、`world-building.md`、所有 `wuxia/*.md`、`characters/*.md`。
- 把结果喂给 `buildEntityDict()`，用 `useMemo`（依赖各文件内容 hash）缓存。
- 档案通过 SSE `file-changed` 事件失效（已有逻辑），自动重建。

### 5.2 `EntityLink` 组件

```tsx
// 点击 span，onClick 回调传出 EntityRef
<span className={entityLink} data-type={ref.type} onClick={() => onPick(ref)}>
  {ref.name}
</span>
```

- `data-type` 用属性选择器着色（角色/武器/武功/门派各一色，复用 WuxiaView DIMENSIONS 配色）。
- 样式：下划虚线 + 主题色，hover 实线 + 浅底，cursor pointer。

### 5.3 `EntityDetailDialog` 组件

```tsx
<EntityDetailDialog ref={dialogEntity} projectId={projectId} onClose={() => setDialogEntity(null)} />
```

- 复用 `RevisionDialog` 的 overlay/dialog 布局风格（已查证：`css` from `@linaria/core`，overlay 全屏遮罩 + dialog 居中卡片）。
- 标题 = `ref.name` + 类型徽标（中文：「角色」「武器」「武功」「门派」「招式」「地名」）。
- 正文 = `ref.sectionRaw` 经 `react-markdown` 渲染（`remarkGfm`，与 EditorPanel preview 一致）。
- 右上角 ✕ 关闭；点 overlay 关闭；Esc 关闭。
- 无需额外 fetch——`sectionRaw` 已在 EntityRef 里（构建词典时截取）。

### 5.4 `EntityMarkdown` 包装组件

```tsx
// 接收 content + dict + projectId，内部管理 dialogEntity state
<EntityMarkdown content={content} dict={dict} projectId={projectId} />
```

**react-markdown v9 关键约束（已查证 docs）**：v9 的 `components` 只映射 HTML 标签名（h1-h6/p/em/a/code/li/blockquote/td/th 等），**没有 `text` key**——直接用 `components.text` 拦截纯文本节点是无效的。

**采用方案：自定义块组件 + 共享 EntityText 包装器**。

- `<Markdown remarkPlugins={[remarkGfm]} components={{ p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th: wrapper }}>`，每个 key 都指向同一个 `wrapper` 工厂。
- `wrapper`：渲染原标签（如 `<p>`），但对其 `children` 调用 `<EntityText>{children}</EntityText>` 处理。
- `EntityText`：递归遍历 React `children`——对**字符串 child** 跑 `splitTextByEntities(child, dict)`，把 segment 数组渲染成「普通文本 + `<EntityLink>`」交替；对**React 元素 child** 递归处理其 children（保留原标签）。
- 顶层块组件捕获 `onPick`（通过 React context 或闭包传 `setDialogEntity`），实体段输出 `<EntityLink onPick={ctx.onPick}>`。
- 组件树底部渲染 `<EntityDetailDialog>`（dialogEntity 非空时）。

**覆盖的块组件**：p、li、h1-h6、blockquote、td、th。这几个覆盖了章节正文里实体名会出现的所有位置（段落、列表、标题、引用、表格）。code/pre **不覆盖**（代码块内的文本不该被链接）。

**为何不用 rehype 插件**：写 rehype 插件用 `unist-util-visit` 改 hast 树也是可行方案，但需引入 `unist-util-visit` 依赖（项目当前未装），而自定义块组件方案零新依赖、逻辑等价、可测性更好（EntityText 是纯渲染函数）。选自定义块组件。

### 5.5 EditorPanel 接线

当前（`EditorPanel.tsx` preview 分支）：
```tsx
<Markdown remarkPlugins={[remarkGfm]}>{content || '*No content*'}</Markdown>
```
改为：
```tsx
<EntityMarkdown content={content || ''} dict={dict} projectId={projectId} />
```
- `EditorPanel` 顶部加 `const { dict, isLoading: dictLoading } = useEntityDict(projectId);`
- dict 为空时（无档案/加载中）退化为普通 Markdown 渲染（无链接，不阻塞阅读）。

---

## 6. 边界情况

| 场景 | 处理 |
|---|---|
| 项目无任何档案（全新项目） | `buildEntityDict` 返回空 Map，`splitTextByEntities` 返回 `[{text}]`，正文无链接——天然降级 |
| 章节正文为空 | `EntityMarkdown` 渲染 `*No content*` 占位（保留现有行为） |
| 词典为空 | text renderer 直接返回原文，零开销 |
| 实体名是常见词（如「剑」「门」） | ≥2 字符约束已过滤单字；两字常见词（「江湖」）若入词典会过度链接——`buildEntityDict` 加一个停用词黑名单（`江湖`、`天下`、`武林` 等泛指词不入词典） |
| 同名实体跨类型 | 见 3.4，保留第一个（角色优先） |
| 实体名含特殊字符 | 词典 key 原样存，`indexOf` 匹配；标题里的 markdown 标记（`**`）已在 `parseSections.cleanTitle` 剥掉 |
| 弹窗打开时切章节 | dialogEntity state 在 EntityMarkdown 内部，章节切换卸载组件，弹窗自然消失 |
| react-markdown text renderer 跨节点 | react-markdown 把连续纯文本作为单个 text 节点传，不会把一个词拆到两个 text 节点；实体名不会跨节点断裂 |

---

## 7. 测试计划

按 AGENTS.md 规范，测试归入已有目录，不建孤岛文件。

### 7.1 单元测试（`tests/unit/entity-dict.test.ts` 新建，纯函数）

> 说明：entity-dict 和 entity-linker 是**新领域纯函数**，无已有 unit 文件可归并，按 AGENTS.md「仅以上都不适用时才新建」规则新建，文件头注明归并建议。

- 各类型档案解析：角色（profiles.md 含 `## 主角` + `- 姓名：林冲`）、外号、武器（wuxia/weapon.md）、武功、门派、地名
- 降级：非武侠项目（无 wuxia/ 目录、world-building 无武功节）只识别角色+地名
- 占位符过滤：`{姓名}` 模板值不入词典
- 空值过滤：`- 姓名：`（空值）不入词典
- ≥2 字符过滤：单字「剑」不入词典
- 停用词过滤：「江湖」「天下」不入词典
- 同名冲突：角色「林冲」与地名「林冲」（假设）冲突，保留角色
- sectionRaw 截取正确性：含标题行 + 到下一同级标题前的全部内容

### 7.2 单元测试（`tests/unit/entity-linker.test.ts` 新建，纯函数）

- 最长优先：「林冲」与「林冲之」并存，正文「林冲之道」匹配「林冲之」
- 边界规则：实体名 `Lin`，正文 `Linear` 不匹配；正文 `a Lin b` 匹配
- 汉字不限边界：「林冲道」「林冲的」匹配「林冲」
- 重叠区间：正文「林冲之」，词典有「林冲」「林冲之」，匹配后者，前者不重复匹配
- 空词典：返回 `[{text}]`
- 空文本：返回 `[]`
- 多实体密集：正文「林冲与宋江」，词典含两者，返回 3 段（前+中+后文本 + 2 实体段）

### 7.3 集成测试（`tests/integration/entity-link.test.tsx` 新建）

> 说明：实体链接渲染是**新领域**，无已有 integration 文件可归并，按 AGENTS.md 规则新建，文件头注明归并建议（未来若有 markdown 渲染相关集成测可合并）。

- 渲染含实体名的章节 markdown，断言链接 DOM 存在（`data-type` 属性正确）
- 点击链接触发弹窗，弹窗内容含 sectionRaw 文本
- dict 为空时不渲染任何链接（回归）

---

## 8. 不做的事（YAGNI）

- ❌ 实体数据库表——档案 markdown 是单一数据源，建表会引入双向同步问题
- ❌ 手动 `[[wiki link]]` 语法——自动识别已满足需求，手动标注是额外心智负担
- ❌ AI 识别实体——纯前端解析足够，调 LLM 成本高、速度慢，与项目纯函数倾向冲突
- ❌ 字段化卡片弹窗——档案原文渲染统一且信息完整，字段化要为每类实体写解析+布局，过度工程
- ❌ 章节 edit 模式链接——textarea 是原始文本，不可注入 React 组件
- ❌ Aho-Corasick 多模式匹配——当前词典规模 O(n·m) 足够，未来词典爆炸再优化
- ❌ 跨章节实体统计/索引——超出本功能范围

---

## 9. 影响文件清单

| 文件 | 改动类型 |
|---|---|
| `src/shared/entity-dict.ts` | **新增** 纯函数 + 类型 |
| `src/shared/entity-linker.ts` | **新增** 纯函数 |
| `src/web/hooks/useEntityDict.ts` | **新增** hook |
| `src/web/components/EntityLink.tsx` | **新增** 组件 + 样式 |
| `src/web/components/EntityDetailDialog.tsx` | **新增** 组件 + 样式 |
| `src/web/components/EntityMarkdown.tsx` | **新增** 包装组件 |
| `src/web/components/EditorPanel.tsx` | **改** preview 分支接线 + 加 hook |
| `tests/unit/entity-dict.test.ts` | **新增** 纯函数单测 |
| `tests/unit/entity-linker.test.ts` | **新增** 纯函数单测 |
| `tests/integration/entity-link.test.tsx` | **新增** 集成测（归并建议：未来若有 markdown 渲染相关集成测可合并） |

零后端改动，零数据库改动。

---

## 10. 验证方式

1. `npm run typecheck` → `npm run test` → `npm run build`（项目铁律）
2. 7.1 / 7.2 / 7.3 测试全绿
3. 手动 E2E（在含真实档案数据的项目上）：
   - 打开任一章节 → 切「预览」模式 → 正文中角色名应显示为虚线下划链接
   - 点击角色名 → 弹窗显示该角色的档案节原文
   - 武侠项目：武器/武功/门派名也应可链接
   - 全新空项目：正文无链接，无报错（降级验证）
   - edit 模式：textarea 保持原始文本，无链接
   - 打开任一档案/设定视图（角色/世界观/概念/大纲/场景/武侠）卡片 → 卡片 markdown 中提及的他实体名也应可点击
   - 打开文件预览器看任意 `.md` 档案 → 预览模式中实体名可点击

---

## 11. 扩展到档案/设定视图（2026-07-05 增补）

**动机**：初版仅章节正文预览支持实体链接。作者在浏览「角色」「世界观」「概念」「大纲」「场景」「武侠」等视图卡片、以及「文件预览器」看任意 `.md` 档案时，同样会遇到跨实体的相互引用（如角色档案里提到某武功、世界观里提到某门派），希望这些地方也能点击查看档案。

### 11.1 范围

| 位置 | 纳入 | 说明 |
|---|---|---|
| `viewShared.CardContent`（6 视图共用：Character/Concept/World/Outline/Scene/Wuxia） | ✅ | 单点接入，一处改动覆盖所有档案/设定视图卡片 |
| `FilePreview`（任意 `.md` 文件预览） | ✅ | 预览分支（非源码分支）生效 |
| `EditorPanel` 章节预览 | ✅（初版已做） | 不变 |
| `EntityDetailDialog` 弹窗内档案原文 | ❌ | 递归链接暂不做，避免弹窗层级复杂化；YAGNI |
| `AgentMessage` AI 对话消息 | ❌ | AI 可能提及未建档名字，点击无反馈体验差；YAGNI |

### 11.2 方案

**复用已有的 `EntityMarkdown`**，组件内自助 hook（与 `EditorPanel` 已有模式一致）：

- `viewShared.CardContent` 加 `projectId` 参数；`mode==='md'` 分支由 `<Markdown>` 改为 `<EntityMarkdown>`；`source` 模式不变（保持源码显示）。
- `FilePreview` 加 `projectId` 参数；`isMarkdown && !raw` 预览分支由 `<Markdown>` 改为 `<EntityMarkdown>`；源码分支不变。
- 各组件内部 `useEntityDict(projectId)` → react-query 按 queryKey 全局缓存（与 EditorPanel 共享同一份档案拉取请求，零重复拉取）。

### 11.3 为什么不用 React Context 统一注入词典

项目现有模式是「组件内调 `useEntityDict`」（EditorPanel 如此）；react-query 缓存已消除重复请求，Context 的抽象收益不抵引入跨组件层级的复杂度。保持一致。

### 11.4 边界处理

- **空词典**（无档案项目）：`EntityMarkdown` 退化为普通 markdown 渲染，零链接零报错（与初版一致）。
- **`source` 模式**：卡片/文件预览器的源码模式显示原始 markdown 文本，不链接（保持既有行为）。
- **非 `.md` 文件**（FilePreview）：不受影响。
- **CardContent 空内容**：仍显示「暂无内容」占位，不调用 EntityMarkdown。

### 11.5 改动文件清单（增补）

| 文件 | 改动 |
|---|---|
| `src/web/components/views/viewShared.tsx` | **改** `CardContent` 加 `projectId` 参数，`md` 模式换 `EntityMarkdown` |
| `src/web/components/FilePreview.tsx` | **改** 加 `projectId` 参数，预览分支换 `EntityMarkdown` |
| 6 个视图组件（Character/Concept/World/Outline/Scene/Wuxia） | **改** `<CardContent>` 调用点传 `projectId`（各组件已有 `projectId`） |
| `FilePreview` 调用点 | **改** 传 `projectId` |
| `tests/integration/entity-link.test.tsx` | **增** CardContent + FilePreview 各 1-2 个集成测试（渲染含实体文本→出现链接→点击弹窗） |

零新增组件、零新增依赖、零后端改动。
