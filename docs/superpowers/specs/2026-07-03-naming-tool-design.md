# 命名工具设计 spec

> 日期：2026-07-03
> 状态：待实现

## 一、概述与目标

### 问题

起名是小说创作中投入产出比极高的一环：一个好名字能省掉大量后续修补，一个坏名字（谐音社死、撞名、撕裂世界观）能毁掉读者沉浸感。当前 open-novel 没有任何命名辅助工具，作者完全靠自己。

### 目标

提供一个**生成器为核心、检查器为安全网**的命名工具，帮助作者快速获得贴合世界观的好名字候选，同时自动拦截坏名字。

### 核心原则

1. **名字是世界观的投影，不是凭空的字**——姓氏跟着地域走，名跟着文化走
2. **出处必须真实**——绝不靠 LLM 幻觉编造古典出处
3. **反 AI 腔**——生成器本身不直接用 LLM 造名，而是从结构化素材库采样组合；LLM 只负责推导意象方向
4. **联网扩充素材，不替代引擎**——联网搜的是意象字素材，入库后由本地引擎组合，绝不联网直接生成名字

### 非目标

- 不做自动改名/重命名（find-replace 称谓连锁是独立的大功能，不在本期范围）
- 不做名字评分/排名（"好"是作者的判断，工具只保证"不坏"并提供足够候选）
- 不做 AI 一键起名（不经过素材库的 LLM 直生成违背反 AI 腔原则）

## 二、已确认的设计约束

| 决策项 | 选择 | 理由 |
|---|---|---|
| 覆盖范围 | 全类目（人名/地名/门派/武功/兵器/章节名） | 一次性覆盖所有命名需求 |
| 候选输出 | 名字 + 古典出处 | 出处真实是对抗 AI 腔的最强武器；需建真实素材库 |
| 用户输入 | 类目 + 角色设定描述 | 需要 LLM 推导意象方向，名字贴合角色 |
| 架构 | 混合引擎（方案 C） | 人名用素材库精确匹配，门派/武功用 LLM+genre 约束，检查器统一兜底 |
| 联网模式 | 自动兜底 | 本地库候选 < 阈值时自动联网搜意象入临时库 |

## 三、命名四维模型

一个中文名 = 姓氏（出身锁定）+ 名（文化+个人）。四个维度共同决定：

### 姓氏维度

- **地域 → 姓氏池**：中国姓氏有显著地域分布。江南多顾/陆/沈/钱（衣冠南渡后世族），江北多王/张/李/赵（中原大姓），岭南多陈/林/黄。
- **家族 → 具体姓氏 + 字辈**：同族同姓；可选字辈排行约束名的某个字（如"伯仲叔季"或家族字辈诗）。

### 名维度

- **地域 → 风格基调**：江南文人→雅致用典（墨渊、清弦）；塞北武人→刚健直白（长风、铁衣）；中原世家→礼制排行（伯安、仲文）。
- **时代 → 命名习俗**：先秦尚单字名；汉唐尚吉祥字（安、平、远）；宋明尚理学问理字（理、道、渊）。武侠可模糊时代但有风格倾向。
- **阶层 → 雅俗程度**：世家用典引经；市井豪侠直白朴素；僧道用法号道号。
- **命运 → 意象暗示**：名字暗示角色命运走向（墨渊→深沉如渊；归鸿→漂泊之雁）。

### 生成器的核心任务

读项目世界观（`world-building.md`）→ 提取地域/时代/阶层基调 → 在四维约束下采样组合 → 检查器过滤 → 输出候选。

## 四、素材库架构

### 目录结构

```
src/shared/naming/                       （共享层，跨 genre）
├── surnames-by-region.json              区域 → [(姓氏, 频率等级), ...]
├── imagery-core.json                    核心意象字库
├── naming-customs.json                  时代 → 命名规律
└── awkward-pinyin.json                  尴尬谐音表

plugins/<genre>/naming/                  （genre 专属层）
├── imagery-<genre>.json                 genre 特有意象字
└── naming-rules-<genre>.json            genre 特有命名规则
```

### 姓氏地理分布库（surnames-by-region.json）

```jsonc
{
  "江南": [
    { "surname": "沈", "tier": 1 },   // tier 1=高频, 2=常见, 3=少见
    { "surname": "顾", "tier": 1 },
    { "surname": "陆", "tier": 1 },
    { "surname": "钱", "tier": 2 },
    { "surname": "秦", "tier": 2 }
  ],
  "江北": [
    { "surname": "王", "tier": 1 },
    { "surname": "张", "tier": 1 },
    { "surname": "李", "tier": 1 },
    { "surname": "赵", "tier": 2 }
  ],
  "岭南": [
    { "surname": "陈", "tier": 1 },
    { "surname": "林", "tier": 1 },
    { "surname": "黄", "tier": 1 }
  ]
  // ... 塞北、巴蜀、中原、关中、闽越
}
```

初始覆盖 8 个大区，每区 15-30 个姓氏。来源：《中华姓氏大辞典》地理分布数据 + 各地方志姓氏统计。

### 核心意象字库（imagery-core.json）

```jsonc
[
  {
    "char": "渊",
    "pinyin": "yuān",
    "imagery": ["深沉", "幽暗", "包容", "神秘"],
    "source": { "text": "《诗经·小雅》", "quote": "如临深渊，如履薄冰" },
    "gender": "male",
    "connotation": "positive"
  },
  {
    "char": "锦",
    "pinyin": "jǐn",
    "imagery": ["华美", "精致", "繁华", "江南"],
    "source": { "text": "《诗经·卫风》", "quote": "锦衣狐裘" },
    "gender": "female",
    "connotation": "positive"
  },
  {
    "char": "寂",
    "pinyin": "jì",
    "imagery": ["孤独", "空旷", "清冷", "禅意"],
    "source": { "text": "《楚辞·九辩》", "quote": "寂兮寥兮" },
    "gender": "neutral",
    "connotation": "melancholy"
  }
]
```

初始规模：300-500 字。来源：诗经、楚辞、唐诗三百首、宋词精选、正史人物名高频字。手工精选，每字附真实出处。

字段说明：
- `imagery`：意象标签数组，用于匹配角色设定推导出的关键词
- `source`：真实古典出处（文本+原句），生成候选时附带展示
- `gender`：male/female/neutral，按角色性别过滤
- `connotation`：positive/melancholy/dark/neutral，按角色命运基调过滤

### 命名习俗库（naming-customs.json）

```jsonc
{
  "先秦": { "nameLength": "single", "style": "朴素单字" },
  "汉唐": { "nameLength": "any", "style": "吉祥字、德行字" },
  "宋明": { "nameLength": "any", "style": "理学问理字" },
  "模糊古代": { "nameLength": "any", "style": "可混合，以意象优先" }
}
```

### 尴尬谐音表（awkward-pinyin.json）

```jsonc
{
  "shǐ": ["屎"],
  "jiān": ["奸"],
  "wáng": ["亡"],
  "sǐ": ["死"]
}
```

名字拼音命中此表时标记警告。

## 五、生成流程

### 主流程

```
输入：类目 + 角色设定描述 + 出身地（可选）
  │
  ├─ 1. 上下文构建
  │    读 world-building.md → 解析地域/时代/文化基调
  │    读 characters/profiles.md → 获取已有名字列表（组内相似检查用）
  │
  ├─ 2. 意象推导（LLM）
  │    角色设定 → 意象关键词数组
  │    例："沉默寡言、家道中落、背负秘密" → ["深沉", "衰败", "隐忍", "孤独"]
  │    约束：LLM 只输出关键词，不输出名字（防 AI 腔）
  │
  ├─ 3. 本地匹配
  │    姓氏：出身地 → surnames-by-region 取候选（或家族姓氏约束）
  │    名：意象关键词 → imagery-core 匹配 → 文化风格过滤 → 性别过滤
  │    组合：姓 × 名 → 候选集
  │
  ├─ 4. 自动兜底判断
  │    if 候选集 < 10:
  │      联网搜意象关键词 → 提取字+出处 → 入临时库 → 重匹配
  │
  ├─ 5. 检查器过滤
  │    谐音 / 撞名 / 音韵 / 组内相似 / 生僻字
  │
  └─ 6. 输出
       候选列表，每个 = {
         name, surname, givenName,
         source: { text, quote },     // 古典出处
         imageryTags: [...],           // 匹配到的意象
         pinyin,
         checks: { homophone, collision, phonetics, similarity, rarity }
       }
```

### 意象推导的 LLM 约束

意象推导是唯一使用 LLM 的生成环节。严格约束：

- 输入：角色设定描述（用户提供）+ 地域/时代上下文（从 world-building 提取）
- 输出：**仅意象关键词数组**，如 `["深沉", "衰败", "隐忍"]`
- **禁止输出名字**——名字由本地素材库组合生成，LLM 不参与造名
- 这确保了反 AI 腔：LLM 负责理解"这个角色该有什么气质"，素材库负责"用有出处的字表达"

### 联网兜底机制

触发条件：本地匹配候选 < 10 个。

流程：
1. 构造搜索查询：意象关键词 + "古诗词 意象" / "诗经 楚辞 意象"
2. 联网搜索（通过后端 fetch 调用搜索 API，轻量级，不启动 agent 进程）
3. 提取搜索结果中的意象字 + 出处
4. 结构化入临时素材库（`<project>/.novel/naming-cache.json`）
5. 用扩充后的库重新匹配组合

关键约束：
- 联网搜的是**意象字素材**，不是完整名字
- 搜到的素材必须经过出处结构化（字→出处）才入库
- 如果搜索结果无法可靠结构化，跳过该结果（宁可候选少，不要假出处）

## 六、各类目生成策略

### 人名（核心类目）

- **姓氏**：出身地 → surnames-by-region 候选；支持家族姓氏约束（如"必须是萧姓"）；支持字辈约束
- **名**：意象库匹配 + 文化风格过滤 + 性别过滤 + 命名习俗（单字/双字）
- **出处**：精确古典出处（来自素材库的 source 字段）

### 地名

- 无姓氏
- **主体**：地貌特征词（山/川/谷/渡/镇/楼）+ 意象修饰
- **风格**：按地域文化基调过滤（江南地名多水/桥/雨意象；塞北多风/沙/铁意象）
- **出处**：风格说明（非古典出处，地名本质是创作而非引用）

### 门派/势力

- **主体**：genre SKILL 约束 + 五行/道家/江湖意象
- 武侠：多用道/清/玄/真/虚（道家）或 铁/血/骨/锋（江湖）
- **出处**：风格解读（如"清取自道家'清静无为'"）

### 武功/兵器

- **主体**：武学典籍意象 + genre 约束
- 武功：动宾结构（如"落英剑法"）或单意象（如"归鸿"）
- 兵器：材质 + 意象（如"寒铁剑""陨星刀"）
- **出处**：风格解读

### 章节名

- **独立逻辑**，不走意象库
- 读 outline-detailed.md / outline-meta.json → 提取本章 beats/伏笔/视点
- 生成模式：回目体（"夜雨识剑"）/ 单字（"剑"）/ 对联（"三指之约，半幅残图"）
- 按用户选择的模式生成

## 七、检查器（统一安全网）

所有类目共用，在生成后、输出前运行。

### 检查规则

| 规则 | 检测方法 | 处理 |
|---|---|---|
| **谐音检查** | 名字 → 拼音 → 比对 awkward-pinyin.json | 命中则标记 `homophone: true` + 具体谐音字 |
| **撞名检查** | 比对本项目已有角色（profiles.md）+ 可选的知名虚构角色库（MVP 后扩展） | 命中则标记 `collision: true` + 撞名对象 |
| **音韵检查** | 姓+名的声调组合分析 | 全组同声调（如全是四声）标记 `phonetics: true` |
| **组内相似** | 新名字与已有名字的编辑距离 | 编辑距离 ≤ 1 标记 `similarity: true`（如"林冲"与"萧言"） |
| **生僻字过滤** | 字超出常用字表（GB2312 一级字） | 标记 `rarity: true` + 生僻字位置 |

### 处理策略

- `homophone: true` 或 `collision: true` → **直接剔除该候选**
- `phonetics` / `similarity` / `rarity` → **保留但标记警告**，前端展示警告图标

## 八、API 设计

### 路由

新增 `src/api/routes/naming.ts`：

```
POST /api/projects/:projectId/naming/generate
  body: {
    category: "person" | "place" | "faction" | "martial" | "weapon" | "chapter",
    description: string,          // 角色设定描述
    region?: string,              // 出身地（可选，默认从 world-building 推断）
    gender?: "male" | "female" | "neutral",
    surnameConstraint?: string,   // 家族姓氏约束（可选）
    count?: number                // 候选数量，默认 15
  }
  response: {
    candidates: [{
      name, surname, givenName,
      source: { text, quote } | null,
      imageryTags: string[],
      pinyin,
      checks: { homophone, collision, phonetics, similarity, rarity },
      warnings: string[]
    }],
    context: { region, era, imageryKeywords, networkUsed: boolean }
  }
```

```
POST /api/projects/:projectId/naming/check
  body: { name: string }
  response: { checks: {...}, warnings: string[] }
```

检查器独立暴露，用户可以对已有名字单独跑检查。

### 复用现有模式

- 路由注册方式同 `check.ts`（Hono Router，projectId 参数，resolveProjectDir）
- 文件读取复用 `context-manager.ts` 的 `readNovelFile`
- 角色档案解析复用 `quality-checker.ts` 的 `parseCharacterProfiles`

## 九、前端交互

### 入口

在角色视图（CharacterView）和写作面板（WritingPanel）中加入命名入口：

- **CharacterView**：角色卡片旁加"起名"按钮 → 弹出命名面板
- **侧边工具栏**：独立的"命名"入口，支持全类目

### 命名面板组件（NamingPanel.tsx）

```
┌─────────────────────────────────────────┐
│  命名工具                          [×]  │
├─────────────────────────────────────────┤
│  类目：[人名 ▾]                         │
│  设定：[沉默寡言、家道中落...]          │
│  出身地：[江南 ▾]（从世界观自动推断）    │
│  性别：[男/女/不限]                     │
│  姓氏约束：[可选，如"萧"]               │
│  ─────────────────────────              │
│  [生成候选]                             │
├─────────────────────────────────────────┤
│  候选（15）            ⚠=有警告         │
│  ┌─────────────────────────────────┐    │
│  │ 宋江  shěn mò yuān           │    │
│  │ 出自《文心雕龙》"深于墨渊"      │    │
│  │ 意象：深沉·幽暗·包容           │    │
│  │ [检查通过] [复制] [用于角色]    │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │ 萧寂寒  ⚠ 音韵：全组去声       │    │
│  │ 出自《楚辞·九辩》"寂兮寥兮"     │    │
│  │ ...                            │    │
│  └─────────────────────────────────┘    │
│  联网扩充：✓ 已自动补充 8 个意象字     │
└─────────────────────────────────────────┘
```

### 复用现有组件模式

- 卡片样式复用 `viewShared.tsx` 的 `card` / `cardTitle`
- 加载状态复用现有 react-query 模式
- 警告标记复用 QualityCheckPanel 的严重度图标

## 十、素材库初始内容方案

### 姓氏地理分布库

手工整理 8 个大区（江南/江北/岭南/巴蜀/中原/关中/塞北/闽越），每区 15-30 个姓氏。一次性投入，后续可通过联网兜底补充。

### 核心意象字库

分两批建设：

1. **首批（手工精选）**：诗经/楚辞/唐诗三百首的高频意象字，约 200 字。每字附真实出处和原句。
2. **扩充（agent 辅助）**：用 agent 联网搜索 + 典籍解析，扩充到 500+ 字。扩充结果经人工审核后入库。

首批 200 字是 MVP 的最小可用集——覆盖最常见的意象方向（深沉/雅致/刚健/孤独/繁华/衰败/自然/品格）。

### 尴尬谐音表

手工整理 50-100 个常见尴尬谐音（屎/奸/亡/死/娼/贱等）。

## 十一、模块划分

```
src/shared/naming/
├── imagery-store.ts          素材库加载与查询（姓氏/意象/习俗/谐音）
├── name-generator.ts         生成器核心（组合逻辑 + 文化过滤）
├── name-checker.ts           检查器（谐音/撞名/音韵/组内相似/生僻字）
├── imagery-deriver.ts        LLM 意象推导（角色设定 → 意象关键词）
├── network-enricher.ts       联网兜底（搜意象 → 结构化入库）
└── pinyin.ts                 拼音工具（名字 → 拼音 → 声调分析）

src/api/routes/naming.ts       API 路由（generate / check）

src/web/components/NamingPanel.tsx   前端命名面板

src/shared/naming/data/        内置素材库数据
├── surnames-by-region.json
├── imagery-core.json
├── naming-customs.json
└── awkward-pinyin.json
```

### 依赖关系

```
naming.ts (路由)
  ├→ name-generator.ts
  │    ├→ imagery-store.ts (素材库)
  │    ├→ imagery-deriver.ts (LLM 推导)
  │    └→ pinyin.ts
  ├→ name-checker.ts
  │    ├→ imagery-store.ts (谐音表 + 已有名字)
  │    └→ pinyin.ts
  └→ network-enricher.ts (联网兜底)
       └→ imagery-store.ts (入临时库)
```

每个模块单一职责，可独立测试。

## 十二、测试策略

### 素材库测试

- 姓氏地理库：每区至少 15 个姓氏，无跨区重复高频姓
- 意象字库：每字有完整 source 字段（text + quote 非空）
- 谐音表：覆盖最常见的尴尬音

### 生成器测试（name-generator.ts）

- 按意象关键词匹配返回相关候选
- 性别过滤生效（male 角色不返回 female 倾向字）
- 家族姓氏约束生效
- 候选数量符合预期
- 组合不重复

### 检查器测试（name-checker.ts）

- 谐音检测："史珍" → 命中 shǐ→屎
- 撞名检测：与 profiles.md 已有名字碰撞
- 音韵检测：全组同声调
- 组内相似：编辑距离 ≤ 1
- 生僻字检测

### 意象推导测试（imagery-deriver.ts）

- 输入角色设定 → 输出意象关键词数组
- 输出不含完整名字（格式约束）

### 联网兜底测试（network-enricher.ts）

- 搜索查询构造正确
- 结果结构化入库（字→出处）
- 无法结构化的结果被跳过

### 集成测试

- POST /naming/generate 端到端：输入设定 → 返回带出处的候选
- POST /naming/check：输入已有名字 → 返回检查报告
- 自动兜底触发：本地库不足时联网扩充标记 `networkUsed: true`

## 十三、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 素材库初始规模不足 | 候选少，频繁触发联网 | 首批 200 字覆盖核心意象；联网兜底自动补充 |
| 联网搜索结果不可靠 | 假出处入库 | 结构化失败的结果跳过；宁可少不造假 |
| 意象推导 LLM 输出不可控 | 推导出无关关键词 | 格式约束 + 关键词白名单校验 |
| world-building.md 解析不稳定 | 提取地域失败 | 降级到默认地域（"模糊古代"）；不阻塞生成 |
| 拼音库体积 | 增加 bundle | 用轻量拼音库或按需加载 |

## 十四、实现优先级

1. **P0：检查器 + 人名生成**（name-checker.ts + name-generator.ts + imagery-store.ts + 素材库首批）
2. **P1：API 路由 + 前端面板**（naming.ts + NamingPanel.tsx）
3. **P2：地名/门派/武功/兵器扩展**（name-generator.ts 扩展 + genre 素材）
4. **P3：联网兜底**（network-enricher.ts）
5. **P4：章节名生成**（独立逻辑，吃大纲数据）

P0+P1 是 MVP：用户能输入角色设定，获得带古典出处的人名候选，并通过检查器安全网。
