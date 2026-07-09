/**
 * 单阶段深度迭代（Deepen）共享模块 v3 —— Writer-Judge 双相循环
 *
 * 核心改进（基于 RSI Survey / LLM Review / Dramaturge 调研）：
 * - 双相循环：奇数轮=Critique（独立审查），偶数轮=Revise（按批评修订）
 *   打破自确认循环——审查者和修订者角色分离
 * - 盲审信息隔离：Critique 轮不读 deepen-log，形成独立判断（LLM Review 核心发现）
 * - 轮替审查视角：每个 Critique 轮用不同专家视角（Dramaturge 分层审查 + Sudowrite Beta Readers）
 * - 改进验证饱和检测：连续 2 个 Critique 轮报告"无实质改进"才饱和（RSI grounding step）
 *
 * 调研依据：
 * - RSI Survey (arXiv 2607.07663)：intrinsic self-assessment 是最弱信号，需 external verification
 * - LLM Review (arXiv 2601.08003)：盲审信息不对称可让小模型超越大模型单 agent
 * - Dramaturge (arXiv 2510.05188)：分层多 agent 审查（全局→局部→协调修订）提升 53.2%
 * - Sudowrite Feedback：多类型针对性批评 + Beta Read 多读者视角
 */

/** 视图 → ChatPanel 的事件名（dispatch CustomEvent） */
export const DEEPEN_TO_CHAT_EVENT = 'open-novel:deepen-to-chat';

/** 强制最低轮数：在此之前忽略饱和信号 */
export const DEEPEN_MIN_ROUNDS = 6;

/**
 * 改进验证饱和信号。
 * Critique 轮在 critique 文件中写入此信号，表示"与上一次审查相比无实质改进"。
 * 前端检测到连续 2 次此信号才真正停止（改进验证 grounding step）。
 */
export const NO_IMPROVEMENT_SIGNAL = '[审查结论：与上一次审查相比无实质改进]';

/** 事件 detail 类型 */
export interface DeepenToChatDetail {
  stage: string;
}

/**
 * 各阶段的结构化质量维度。
 */
export const DEEPEN_DIMENSIONS: Record<string, string[]> = {
  characters: [
    '动机清晰度：每个主要角色的驱动力三角（外在目标/内在需求/核心缺陷）是否具体、独特？',
    '关系丰富度：角色间关系是否有层次（对立/同盟/暧昧/转变）？',
    '弧光完整性：主角是否有清晰的变化轨迹（起点→转折→终点）？',
    '差异化程度：角色声音/行事风格是否可区分，避免千人一面？',
    '功能性覆盖：是否缺少叙事必需的功能性角色（导师/镜像/催化剂）？',
  ],
  world: [
    '体系自洽性：力量/社会/经济体系内部是否有矛盾？',
    '历史纵深：世界是否有可信的历史背景和因果链？',
    '文化丰富度：不同地域/阶层是否有差异化的文化特征？',
    '冲突潜力：世界设定是否孕育了多种潜在冲突源？',
    '感官沉浸：环境描写是否有视听嗅味触的多感官细节？',
  ],
  outline: [
    '三幕结构：起承转合是否清晰、节奏是否合理？',
    '因果链紧密度：事件之间是否有因果驱动而非巧合？',
    '伏笔密度：埋设与回收是否成对且分布合理？',
    '情感节奏：高低潮交替是否张弛有度？',
    '主题贯穿：核心主题是否在各幕中得到递进体现？',
  ],
  scenes: [
    '场景目的性：每个场景是否推进了情节或揭示了角色？',
    '主动被动交替：Scene/Sequel 是否合理交替？',
    '冲突烈度：场景内冲突是否有升级和转折？',
    '感官落地：场景是否有具体的感官细节而非纯对话？',
    '信息节制：是否避免了信息倾泻（info-dump）？',
  ],
  concept: [
    '核心冲突锐度：故事的核心矛盾是否清晰、有力？',
    '主题深度：道德前提是否有探讨价值，非说教？',
    '独特性：概念是否有区别于同类作品的差异化点？',
    '情感钩子：开头是否能抓住读者情感？',
    '可展开性：概念是否支撑长篇叙事的体量？',
  ],
};

/** 阶段中文名 */
const STAGE_LABELS: Record<string, string> = {
  characters: '角色',
  world: '世界观',
  outline: '大纲',
  scenes: '场景',
  concept: '概念',
};

/**
 * 审查视角轮替表（Dramaturge 分层审查 + Sudowrite Beta Readers）。
 * 每个 Critique 轮用不同视角，覆盖所有维度但每次聚焦不同切面。
 * 视角按 index % length 循环。
 */
const CRITIQUE_PERSPECTIVES: Record<string, string[]> = {
  characters: [
    '心理分析师：你是文学心理分析师。审查每个角色的心理一致性——动机是否经得起推敲？行为是否源于明确的内在需求？弧光转折点是否 psychologically earned（心理上合理）而非生硬安排？找出"知道角色会怎么做但不知道为什么"的薄弱处。',
    '戏剧冲突专家：你是戏剧结构分析师。审查角色间关系的冲突张力——对立面是否足够强？同盟是否有裂痕可能？是否存在未被利用的暧昧/背叛/转变潜力？找出"关系太平淡、缺乏戏剧燃料"的薄弱处。',
    '读者代入测试：你是三位不同类型的读者（共情型/批判型/休闲型）。测试能否真正代入每个角色——声音是否可区分？读者会在哪里出戏？哪个角色让人想翻页跳过？找出"读者体验断裂"的薄弱处。',
    '叙事功能审计师：你是叙事结构审计师。审查角色群的功能性覆盖——是否缺少导师/镜像/催化剂/障碍者？是否有冗余角色（功能重叠）？主角的对手是否足够匹配？找出"角色生态不完整"的薄弱处。',
  ],
  world: [
    '体系自洽审计师：你是世界观审计师。逐条检查力量/社会/经济体系的内部矛盾——规则有没有被自己打破？谁在执行规则？违规后果是什么？找出"体系漏洞"。',
    '历史与因果链审查者：你是历史叙事审查者。检查世界的历史纵深——重大事件的因果链是否可信？当前设定是否有历史根源？找出"历史断裂、设定悬空"的薄弱处。',
    '感官沉浸测试者：你是沉浸感测试者。检查世界的感官落地——环境描写是否只有视觉？气味/触感/声音是否缺失？读者能否"闻到"这个世界？找出"感官单薄"的薄弱处。',
    '冲突潜力勘探者：你是冲突勘探者。检查世界设定中未被挖掘的冲突源——阶层矛盾/资源争夺/信仰冲突是否被留白？找出"冲突浪费"的薄弱处。',
  ],
  outline: [
    '结构建筑师：你是三幕结构审计师。检查起承转合的节奏——第一幕是否太长？中点转折是否有力？高潮是否 earned？找出"结构失衡"。',
    '因果链追踪者：你是因果逻辑追踪者。逐事件检查因果驱动——哪些是巧合推动？哪些转折缺乏铺垫？找出"巧合代替因果"的薄弱处。',
    '伏笔审计师：你是伏笔审计师。检查埋设与回收——哪些伏笔只有埋设没有回收？哪些回收缺乏铺垫？分布是否均匀？找出"伏笔断裂"。',
    '情感节奏分析师：你是情感节奏分析师。检查高低潮交替——连续低潮是否太长？高潮是否密集到麻木？找出"节奏失控"。',
  ],
  scenes: [
    '场景目的审计师：你是场景效率审计师。逐场景检查目的——哪些场景不推进情节也不揭示角色？哪些可以删除或合并？找出"空转场景"。',
    '冲突升级追踪者：你是冲突升级追踪者。检查场景内冲突是否有升级和转折——哪些场景冲突平淡？哪些一上来就到顶没有层次？找出"冲突扁平"。',
    '感官落地审查者：你是感官落地审查者。检查场景的感官细节——哪些场景只有对话没有环境？哪些场景适合 info-dump 但未处理？找出"场景悬空"。',
  ],
  concept: [
    '核心冲突锐度审查者：你是概念锐度审查者。检查核心矛盾是否清晰有力——读者能用一句话说出冲突吗？冲突双方是否势均力敌？找出"冲突模糊"。',
    '独特性审计师：你是独创性审计师。检查概念的差异化——与同类作品相比有什么独特之处？哪些元素是 generic 的？找出"概念平庸"。',
    '读者钩子测试者：你是钩子测试者。检查开头能否抓住读者——前 500 字是否制造了好奇/共情/紧张？找出"钩子薄弱"。',
  ],
};

/** 判断某轮是 Critique（审查）还是 Revise（修订）。奇数轮=Critique，偶数轮=Revise */
export function isCritiqueRound(round: number): boolean {
  return round % 2 === 1;
}

/**
 * 获取某轮的审查视角描述（仅 Critique 轮有意义）。
 */
function getCritiquePerspective(stage: string, round: number): string {
  const perspectives = CRITIQUE_PERSPECTIVES[stage] || [];
  if (perspectives.length === 0) return '审查者';
  // 每 2 轮一个 Critique 轮，视角索引 = (round-1)/2 % length
  const critiqueIndex = Math.floor((round - 1) / 2) % perspectives.length;
  return perspectives[critiqueIndex];
}

/**
 * 构造 Critique 轮 message（审查者角色）。
 *
 * 核心设计（LLM Review 盲审）：
 * - 不读 deepen-log（信息隔离，形成独立判断）
 * - 以指定专家视角审查产出文件
 * - 产出结构化批评写入 .novel/deepen-critique.md
 * - 若与上次审查无实质改进，写 NO_IMPROVEMENT_SIGNAL
 */
function buildCritiqueMessage(stage: string, round: number, userHint?: string): string {
  const label = STAGE_LABELS[stage] || stage;
  const dimensions = DEEPEN_DIMENSIONS[stage] || [];
  const perspective = getCritiquePerspective(stage, round);

  const hintBlock = userHint?.trim()
    ? `\n## 用户特别指导\n${userHint.trim()}\n`
    : '';

  return `⚠️ 这是「${label}」阶段深化循环的第 ${round} 轮——**审查轮**。
你的角色是独立审查者，不是作者。你只审查不修改文件内容。
${hintBlock}
## 铁律
- **不要调用 PATCH /api/projects 更新阶段**——始终停留在「${label}」阶段
- **不要修改产出文件**（如 profiles.md / world-building.md）——你只读不写
- **不要读 .novel/deepen-log.md**——盲审要求：你不看之前的自我评估和改进记录，形成独立判断
- **不要用 question 工具提问**

## 你的审查视角
${perspective}

## 审查流程
1. 读取当前阶段的产出文件（如 .novel/characters/profiles.md）
2. 以上述专家视角独立审查，逐维度评估：
${dimensions.map((d, i) => `   ${i + 1}. ${d}`).join('\n')}
3. 对每个维度打 1-5 分（5=优秀，1=严重不足）
4. 找出最薄弱的 2-3 个具体问题（不是泛泛的"可以更好"，而是"第X段的Y角色动机不明，因为Z"）
5. 对每个问题给出具体的改进建议（"应该补充X背景，因为Y"）
6. 将审查结果写入 .novel/deepen-critique.md（覆盖旧内容），格式：
   # 审查报告（第${round}轮）
   **视角**：${perspective.split('：')[0]}
   **维度评分**：<维度名 分分, ...>
   ## 问题1：<具体问题描述>
   - 根因：<为什么这是问题>
   - 建议：<具体怎么改>
   ## 问题2：...
   ## 问题3：...

## 改进验证（饱和检测）
如果本轮审查发现：与你能预期的"高质量产出"相比，当前产出已经很好，
没有值得指出的实质性问题（不是因为"差不多了"，而是确实找不到具体问题），
在 deepen-critique.md 末尾另起一行写：${NO_IMPROVEMENT_SIGNAL}
`;
}

/**
 * 构造 Revise 轮 message（作者角色）。
 *
 * 核心设计（Dramaturge 协调修订）：
 * - 读 deepen-critique.md 获取审查者的具体批评
 * - 读 deepen-log.md 了解历史改进（避免重复）
 * - 按批评逐条修订 + 扩展新内容
 * - 记录改进到 deepen-log.md
 */
function buildReviseMessage(stage: string, round: number, userHint?: string): string {
  const label = STAGE_LABELS[stage] || stage;

  const hintBlock = userHint?.trim()
    ? `\n## 用户特别指导\n${userHint.trim()}\n`
    : '';

  return `⚠️ 这是「${label}」阶段深化循环的第 ${round} 轮——**修订轮**。
你的角色是作者，根据审查者的批评进行修订。
${hintBlock}
## 铁律
- **不要调用 PATCH /api/projects 更新阶段**——始终停留在「${label}」阶段
- **不要用 question 工具提问**

## 修订流程
1. 读取当前阶段的产出文件（如 .novel/characters/profiles.md）
2. 读取 .novel/deepen-critique.md——这是独立审查者对你的产出的批评
3. 读取 .novel/deepen-log.md 了解前几轮的改进历史（避免重复修改）
4. **逐条回应批评**：
   - 对审查者指出的每个问题，分析根因是否成立
   - 若成立：做具体修订（补充/重构/新建），不要表面润色
   - 若不成立：在 deepen-log 中说明为什么不成立（审查者也可能误判）
5. **扩展新内容**：不仅修补审查者指出的问题，还要主动识别叙事中缺失的部分——
   如发现缺少关键功能性角色、未展开的关系线、或可补充的新视角，主动创建
6. 在 .novel/deepen-log.md 追加本轮记录，格式：
   ## 第${round}轮（修订）
   **回应的批评**：<问题1→改进 / 问题2→改进 / 问题3→不成立因为...>
   **维度评分变化**：<维度名 旧分→新分, ...>
   **新建内容**：<本轮新建了什么（如有）>
   **下轮建议**：<下一轮审查应关注的方向>
`;
}

/**
 * 构造深化 message。根据轮次奇偶自动选择 Critique 或 Revise。
 */
export function buildDeepenMessage(stage: string, round: number, userHint?: string): string {
  if (isCritiqueRound(round)) {
    return buildCritiqueMessage(stage, round, userHint);
  }
  return buildReviseMessage(stage, round, userHint);
}

/**
 * 检测 critique 文件中是否包含"无实质改进"信号。
 * 调用方应统计连续出现次数——连续 2 次才真正饱和。
 */
export function detectNoImprovement(critiqueContent: string): boolean {
  return critiqueContent.includes(NO_IMPROVEMENT_SIGNAL);
}

/**
 * 将 "HH:MM" 格式的截止时间转为时间戳。
 * 如果今日该时间已过，设为明日同一时间。
 * 空输入或无效格式返回 null。
 */
export function parseDeadlineInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;

  const now = new Date();
  const deadline = new Date(now);
  deadline.setHours(hours, minutes, 0, 0);

  if (deadline.getTime() <= now.getTime()) {
    deadline.setDate(deadline.getDate() + 1);
  }

  return deadline.getTime();
}
