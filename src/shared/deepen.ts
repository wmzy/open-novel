/**
 * 单阶段深度迭代（Deepen）共享模块
 *
 * 提供：各阶段结构化质量维度、深化消息构造、饱和检测、事件常量。
 * 被 ChatPanel（监听事件 + 驱动循环）和各视图（dispatch 事件）共用。
 *
 * 调研依据：
 * - Self-Refine (NeurIPS 2023)：多维度结构化评分优于泛泛反思
 * - R2-Write (ICML)：写作需触发验证（Verification）和回溯（Backtracking）思维
 * - Semantic Early-Stopping：饱和检测避免低效空转
 */

/** 视图 → ChatPanel 的事件名（dispatch CustomEvent） */
export const DEEPEN_TO_CHAT_EVENT = 'open-novel:deepen-to-chat';

/** 饱和信号标记——agent 写入 deepen-log 表示各维度已达标，前端检测后停止循环 */
export const SATURATION_SIGNAL = '[饱和信号：各维度已达 4+ 分，无明显可改进项]';

/** 事件 detail 类型 */
export interface DeepenToChatDetail {
  /** 深化的阶段：concept / world / characters / outline / scenes */
  stage: string;
}

/**
 * 各阶段的结构化质量维度（1-5 分自评框架）。
 * 来源：Self-Refine（结构化评分 > 泛泛反思）+ R2-Write（写作需触发验证/回溯）。
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

/** 阶段中文名（用于消息展示） */
const STAGE_LABELS: Record<string, string> = {
  characters: '角色',
  world: '世界观',
  outline: '大纲',
  scenes: '场景',
  concept: '概念',
};

/**
 * 构造深化 message。融合三个调研优化：
 * - 结构化维度评分（优化 1）
 * - 验证→回溯→修订思维引导（优化 2）
 * - 饱和信号指令（优化 3）
 */
export function buildDeepenMessage(stage: string, round: number): string {
  const label = STAGE_LABELS[stage] || stage;
  const dimensions = DEEPEN_DIMENSIONS[stage] || [];

  return `你在做「${label}」阶段的深化打磨，这是第 ${round} 轮迭代。

## 评估维度
${dimensions.map((d, i) => `${i + 1}. ${d}`).join('\n')}

## 流程（验证→回溯→修订）
1. 读取当前阶段的产出文件
2. 读取 .novel/deepen-log.md 了解前几轮的评分和改进历史
3. **验证**：逐维度检查当前产出是否满足质量标准，给每个维度打 1-5 分
4. **回溯**：对最低分维度，分析根因（是缺少信息？逻辑断裂？还是深度不够？）
5. **修订**：针对根因做具体补充，而非表面润色
6. 修改完后在 .novel/deepen-log.md 追加本轮记录，格式：
   ## 第${round}轮
   **维度评分**：<维度名 旧分→新分, ...>
   - 发现：<本轮识别的最低分维度及其根因>
   - 改进：<做了什么具体修改>
   - 下轮建议：<下一轮值得关注的方向>
7. 不要用 question 工具提问，不要推进到下一阶段

## 饱和信号
如果本轮评估后发现所有维度已达 4 分以上，且没有明显可改进项，
在 deepen-log 本轮记录末尾另起一行写：${SATURATION_SIGNAL}
系统将自动停止循环。`;
}

/**
 * 检测 deepen-log 内容中是否包含饱和信号。
 * 用于 run 完成后决定是否提前停止循环。
 */
export function detectSaturation(logContent: string): boolean {
  return logContent.includes(SATURATION_SIGNAL);
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

  // 如果今日该时间已过，设为明日
  if (deadline.getTime() <= now.getTime()) {
    deadline.setDate(deadline.getDate() + 1);
  }

  return deadline.getTime();
}
