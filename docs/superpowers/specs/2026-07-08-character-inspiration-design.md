# 角色灵感维度：卡角色时按维度定向生成候选种子

**日期**：2026-07-08
**状态**：设计中
**背景**：写小说最大的痛点之一是「想不出具体内容」。open-novel 已有结构化脚手架（template-generator）、采访式引导（INTERVIEW_PROTOCOL）、命名器意象库，但都覆盖不了「我在这个环节卡住了，给我几个能用的候选」这一类需求。第一批先做角色——它维度最丰富（门派/势力、历史原型、功能定位、驱动力三角、关系张力、随机刺激）、上下文依赖最重、机制验证最彻底。模式跑通后横向复制到伏笔/场景/世界观等结构点。

## 目标

- 角色阶段（及写作途中）卡住时，用户选一个「灵感维度」+ 填少量参数，一键获得 3 个轻量角色种子（姓名 + 一句话定位 + 记忆点）
- 候选在右侧 ChatPanel 流式呈现，用户可在 chat 里追问/调整/「换一组」/「展开第 N 个」
- 用户满意后让 agent 直接落盘 `profiles.md`——复用现有 agent runtime 的文件读写能力
- **零后端改动**：复用现有 `/api/runs` + `composePrompt` 的 stage 上下文注入

## 非目标（YAGNI）

- 不新建独立 API 路由（不做 `/api/projects/:id/inspire`）
- 不提取 `callAgentOnce` 到共享位置（不需要轻量 AI 调用）
- 不在 CharacterView 内部建独立「候选区」组件——chat 本身就是交互区
- 不做前端状态机管理两阶段（种子→展开）——chat 多轮对话自然完成
- 不在本次覆盖伏笔/场景/世界观/大纲/概念——横向复制是后续工作
- 不引入 React Context 层（事件总线足够，已有 `REVISE_TO_CHAT_EVENT` 先例）

## 设计

### 核心决策：chat 注入而非独立路由

三条路径对比：

| 方案 | AI 调用 | 候选展示 | 两阶段管理 | 后端改动 | 新文件 |
|------|---------|----------|------------|----------|--------|
| **A. 独立路由**（放弃） | 新建 inspire 路由 + 提取 callAgentOnce | CharacterView 自建候选区 | 前端状态机 | 新路由 + 提取 quick-call | 4+ |
| **B. chat 注入**（采用） | 复用 `/api/runs` + agent runtime | chat 本身 | chat 多轮对话 | **零** | 2 |

**选 B**：灵感本质是「我要和 AI 聊一聊，但要先帮我起个头」。把维度+参数组装成一句自然语言消息注入 chat，用户后续的追问/调整/展开全部在对话流里完成，不需要独立基础设施。与 `REVISE_TO_CHAT_EVENT` 的跨组件注入模式完全一致。

### 数据流

```
[CharacterView 💡 灵感按钮]
   → 弹维度选择器（选维度 + 填参数）
   → buildInspirationMessage(dimension, params) 组装自然语言消息
   → dispatch INSPIRE_TO_CHAT_EVENT { message }
       ↓
[ChatPanel 监听] → sendMessage({ stage: 当前 stage, message })
       ↓
[现有 /api/runs] → composePrompt(stage='characters') 注入 stage 指令 + 项目文件清单（agent 自行 Read concept.md / world-building.md）
       ↓
[Agent 在 chat 给出 3 个种子]
   → 用户在 chat 追问 / 「换一组」 / 「展开第 2 个」
       ↓
[用户满意] → 「把第 2 个写进角色档案」 → Agent 落盘 profiles.md → SSE file-changed → 视图刷新
```

### 消息组装：`buildInspirationMessage`

核心纯函数，放在 `src/shared/inspiration.ts`。签名：

```ts
type Dimension =
  | 'faction'        // 门派/势力
  | 'archetype'      // 历史/现实原型
  | 'role'           // 功能定位
  | 'triangle'       // 驱动力三角组合
  | 'tension'        // 关系张力
  | 'random';        // 随机刺激

interface DimensionParams {
  faction?: string;                              // 门派/势力名
  archetype?: string;                            // 原型人物名
  role?: '盟友' | '导师' | '镜面' | '障碍' | '叛徒' | '救星';
  tension?: { target: string; type: '敌对' | '暧昧' | '师徒' | '利用' };
  // triangle / random 无参数
}

export function buildInspirationMessage(dimension: Dimension, params?: DimensionParams): string;
```

#### 六个维度的消息模板

所有维度共用一组指令片段（确保覆盖 INTERVIEW_PROTOCOL 的「先问后做」）：

```
共用片段 =
  "我在卡角色，需要灵感刺激。"
+ "请**跳过采访流程**，直接给我 3 个角色灵感种子——"
+ "每个只要：姓名、一句话定位、一个记忆点（为什么读者会记住他）。"
+ "结合现有的 concept 和 world-building，避免和已有角色重名。"
+ "**不要写完整档案，我挑中后再展开。**"
```

各维度在共用片段前插入维度特定的定向指令：

| 维度 | 额外指令（前缀） |
|------|------------------|
| **faction** | `这 3 个角色都隶属「{faction}」——` |
| **archetype** | `这 3 个角色都以「{archetype}」为蓝本，抽取其核心特质转译到本世界，不要照搬历史事迹——` |
| **role** | `这 3 个角色都承担「{role}」的叙事功能，说明此刻故事为什么需要这个功能——` |
| **triangle** | `这 3 个角色的驱动力三角（Want/Need/Wound）各不相同，每个标注三角组合——` |
| **tension** | `这 3 个角色都与「{target}」产生「{type}」关系，说明冲突点——` |
| **random** | `（无额外指令）这 3 个角色风格差异最大、来自不同维度——` |

完整消息示例（faction 维度，params: `{ faction: '明教' }`）：

> 我在卡角色，需要灵感刺激。这 3 个角色都隶属「明教」——请**跳过采访流程**，直接给我 3 个角色灵感种子——每个只要：姓名、一句话定位、一个记忆点（为什么读者会记住他）。结合现有的 concept 和 world-building，避免和已有角色重名。**不要写完整档案，我挑中后再展开。**

### 前端组件

#### 1. `InspirationPicker`（`src/web/components/InspirationPicker.tsx`，新文件）

维度选择器 + 动态参数输入区 + 生成按钮。可折叠（与 CharacterView 的「起名工具」行为一致）。

```
┌──────────────────────────────────────────────┐
│ 维度：[门派/势力 ▾]                            │
│ 参数：[明教___________________]      [生成灵感] │
└──────────────────────────────────────────────┘
```

维度切换 → 参数输入区动态变化：
- `faction` / `archetype` → 单行文本框
- `role` → 下拉（盟友/导师/镜面/障碍/叛徒/救星）
- `tension` → 角色名文本框 + 关系下拉（敌对/暧昧/师徒/利用）
- `triangle` / `random` → 无参数区，只显示「生成灵感」按钮

点击「生成灵感」：
1. `buildInspirationMessage(dimension, params)` 组装消息
2. `window.dispatchEvent(new CustomEvent('open-novel:inspire-to-chat', { detail: { message } }))`
3. 折叠选择器

#### 2. CharacterView 工具栏改造（`src/web/components/views/CharacterView.tsx`）

在现有 `✎ 修订 / ⇄ 重命名 / ▸ 起名工具 / ViewToolbar` 之间插入 **`💡 灵感`** 按钮。点击展开 `InspirationPicker`（与 `showNaming` 控制的 NamingPanel 平级，用 `showInspiration` state 控制）。

```tsx
<button className={inspireToggleBtn} onClick={() => setShowInspiration(v => !v)}>
  {showInspiration ? '▾ 收起灵感' : '💡 灵感'}
</button>
{showInspiration && <InspirationPicker />}
```

#### 3. ChatPanel 监听（`src/web/components/ChatPanel.tsx`）

新增 `INSPIRE_TO_CHAT_EVENT` 监听，与现有 `REVISE_TO_CHAT_EVENT` 监听并列：

```ts
export const INSPIRE_TO_CHAT_EVENT = 'open-novel:inspire-to-chat';

useEffect(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { message: string };
    sendMessage({
      projectId, agentId, skillId, stage,
      message: detail.message,
    });
  };
  window.addEventListener(INSPIRE_TO_CHAT_EVENT, handler);
  return () => window.removeEventListener(INSPIRE_TO_CHAT_EVENT, handler);
}, [sendMessage, projectId, agentId, skillId, stage]);
```

与 revise 的区别：灵感消息已完整组装，**直接 sendMessage**，不需要用户手写补充。发送后 chat 流式渲染 agent 响应，用户继续在 chat 里对话。

### stage 传递

sendMessage 的 `stage` 用 ChatPanel 当前的 `stage` prop（即 ProjectPage 传入的活动 stage）。理由：

- 灵感不分阶段——用户可能写作途中也需要角色灵感
- 传当前 stage 让 composePrompt 注入的上下文与对话历史连贯
- 若用户在 character 阶段用灵感，stage='characters'，composePrompt 注入 INTERVIEW_PROTOCOL（被消息里的「跳过采访」覆盖）

## 文件清单

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/shared/inspiration.ts` | **新建** | `buildInspirationMessage(dimension, params)` 纯函数 + `Dimension`/`DimensionParams` 类型 |
| `src/web/components/InspirationPicker.tsx` | **新建** | 维度选择器 + 动态参数输入 + dispatch 事件 |
| `src/web/components/views/CharacterView.tsx` | 改 | 工具栏加 `💡 灵感` 按钮 + 挂载 InspirationPicker |
| `src/web/components/ChatPanel.tsx` | 改 | 加 `INSPIRE_TO_CHAT_EVENT` 监听 → sendMessage |
| `tests/unit/shared/inspiration.test.ts` | **新建** | 纯函数测试（6 维度消息组装 + 参数注入 + 共用指令模式） |

## 测试策略

### 纯函数测试（`tests/unit/shared/inspiration.test.ts`）

`buildInspirationMessage` 的 6 个维度各一条断言：

1. **faction**：消息含「隶属「明教」」+ 共用片段全部关键指令
2. **archetype**：消息含「以「诸葛亮」为蓝本」+「不要照搬历史事迹」+ 共用片段
3. **role**：消息含「承担「导师」的叙事功能」+ 共用片段
4. **triangle**：消息含「驱动力三角（Want/Need/Wound）各不相同」+ 共用片段
5. **tension**：消息含「与「林冲」产生「敌对」关系」+ 共用片段
6. **random**：消息含「风格差异最大」+ 共用片段（无参数注入）

共用片段断言（所有维度都校验）：
- 含「跳过采访流程」
- 含「不要写完整档案」
- 含「避免和已有角色重名」
- 含「我挑中后再展开」

参数校验（`buildInspirationMessage` 内部，抛 `Error`）：
- faction 缺参数 → `throw new Error('faction 维度需要 faction 参数')`
- archetype 缺参数 → `throw new Error('archetype 维度需要 archetype 参数')`
- role 缺参数 → `throw new Error('role 维度需要 role 参数')`
- tension 缺 target 或 type → `throw new Error('tension 维度需要 target 和 type 参数')`
- triangle / random 无必填参数

前端 InspirationPicker 在必填参数为空时禁用「生成灵感」按钮，避免调用抛错。

### 回归验证

- typecheck 通过
- ChatPanel 现有 revise 监听不受影响（两个监听独立）
- CharacterView 现有功能（修订/重命名/起名工具）不受影响

## 风险

1. **agent 不遵守「跳过采访」指令**：INTERVIEW_PROTOCOL 是 STAGE_INSTRUCTIONS 里硬编码的「先示范→选择题→追问→落盘」流程，agent 可能优先走流程而非响应灵感消息。缓解：消息里用粗体强调「**跳过采访流程**」，且消息明确指定输出格式（3 个种子、每个三字段），给 agent 明确的替代行为。
2. **agent 直接落盘完整档案**：消息明确说「不要写完整档案」，但 agent 可能习惯性落盘。缓解：消息用粗体强调「**不要写完整档案，我挑中后再展开**」。即使落盘了，用户可用「修订」功能删减——这是可接受的降级。
3. **消息注入后用户看不到组装逻辑**：用户点「生成灵感」后 chat 里出现一条长消息，可能困惑「我没打这些字」。缓解：这条消息本身就是可读的自然语言，用户看到能理解「这是按我的选择组装的灵感请求」。不需要额外 UI 标记。
4. **横向复制时维度定义膨胀**：后续结构点（伏笔/场景/世界观）各有自己的维度，`inspiration.ts` 会持续增长。缓解：当前 YAGNI——先把角色跑通，横向复制时若文件过大再按结构点拆分（如 `inspiration/character.ts`、`inspiration/foreshadow.ts`）。

## 后续横向复制路径

角色跑通后，其余结构点的扩展模式：

1. `inspiration.ts` 加该结构点的 `Dimension` 值 + 消息模板
2. 对应 View 工具栏加 `💡 灵感` 按钮 + InspirationPicker（props 传入可选维度列表）
3. ChatPanel 监听不变（事件通用，不区分结构点）

预期维度（待角色跑通后细化）：
- **伏笔**：埋设章号 + 回收章号 + 主题类型
- **场景**：冲突类型 + 情感走向 + 场景类型
- **世界观要素**：要素类别（经济/宗教/历法/禁忌）+ 文化基调
- **大纲节点**：幕结构位置 + 转折类型
- **概念**：类型×母题×冲突内核×情感基调组合
