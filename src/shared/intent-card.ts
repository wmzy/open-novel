/**
 * 意图卡：作者创作偏好的单一权威文档（.novel/intent.md）。
 *
 * - buildIntentSkeleton：表单数据 → markdown 骨架（新建项目向导落盘用）。
 * - mergeIntentSections：按维度标题合并写回（agent 追问结果落盘用，不覆盖其他小节）。
 *
 * 消费方：prompt-composer（注入 prompt）、projects 路由（创建时落盘）。
 */

/** 新建项目表单可采集的 4 个高频维度。 */
export interface IntentInput {
  /** 节奏偏好 */
  pacing?: string;
  /** 角色权重 */
  characterWeight?: string;
  /** 伏笔风格 */
  foreshadowStyle?: string;
  /** 文风锚点 */
  styleAnchor?: string;
}

/** 全部 8 个维度定义：标题 → 表单键（可选）→ 未设定时的条目骨架。 */
export const INTENT_DIMENSIONS: ReadonlyArray<{
  title: string;
  inputKey?: keyof IntentInput;
  items: string[];
}> = [
  { title: '节奏偏好', inputKey: 'pacing', items: ['每章字数：未设定', '张弛密度：未设定', '断章钩子：未设定'] },
  { title: '角色权重', inputKey: 'characterWeight', items: ['核心角色（弧线优先）：未设定', '不可死亡角色：未设定', '配角戏份上限：未设定'] },
  { title: '伏笔风格', inputKey: 'foreshadowStyle', items: ['长线/短线配比：未设定', '埋设密度：未设定', '回收节奏：未设定'] },
  { title: '文风锚点', inputKey: 'styleAnchor', items: ['语言密度：未设定', '对话/描写比例：未设定', '用词禁区：未设定'] },
  { title: '理念冲突偏好', items: ['理念冲突 vs 武力冲突比重：未设定', '说教容忍度：未设定', '理念呈现方式：未设定'] },
  { title: '多线叙事规则', items: ['单章视角数上限：未设定', '线路切换频率：未设定'] },
  { title: '结局方向', items: ['基调：未设定', '开放/闭合程度：未设定'] },
  { title: '叙事手法', items: ['倒叙/插叙容忍度：未设定', '时间跳跃：未设定'] },
];

const INTENT_HEADER = [
  '# 作者意图卡',
  '',
  '> 本文件记录作者的创作意图与偏好。AI 生成、修订、评审均以此为准。',
  '> 可随时手动编辑；缺失维度用「未设定」标注。',
].join('\n');

/** 单个维度的自由文本长度上限（规格 §5.1：表单字段超长时后端截断）。 */
const MAX_DIMENSION_CHARS = 500;

/**
 * 生成意图卡骨架。表单提供的维度以自由文本写入该节；未提供的维度输出条目骨架（「未设定」）。
 * 所有输入都会 trim；空串按未提供处理；超长值截断到 500 字。
 */
export function buildIntentSkeleton(input?: IntentInput): string {
  const sections = INTENT_DIMENSIONS.map((dim) => {
    const value = dim.inputKey ? input?.[dim.inputKey]?.trim() : undefined;
    if (value) {
      return `## ${dim.title}\n${value.slice(0, MAX_DIMENSION_CHARS)}`;
    }
    return `## ${dim.title}\n${dim.items.map((item) => `- ${item}`).join('\n')}`;
  });
  return [INTENT_HEADER, ...sections].join('\n\n') + '\n';
}

/**
 * 按 `## 标题` 行切分 markdown 文档。第一个 `##` 之前的内容归入 header。
 */
function splitSections(doc: string): { header: string; sections: Array<{ title: string; body: string }> } {
  const sections: Array<{ title: string; body: string }> = [];
  let header = '';
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  for (const line of doc.split('\n')) {
    const match = /^## (.+)$/.exec(line);
    if (match) {
      if (currentTitle !== null) {
        sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
      }
      currentTitle = match[1].trim();
      currentBody = [];
    } else if (currentTitle === null) {
      header += (header ? '\n' : '') + line;
    } else {
      currentBody.push(line);
    }
  }
  if (currentTitle !== null) {
    sections.push({ title: currentTitle, body: currentBody.join('\n').trim() });
  }
  return { header, sections };
}

/**
 * 合并写回：updates 的 key 为维度标题（如「角色权重」），只更新对应 `##` 小节，
 * 其他小节原样保留；目标小节不存在时追加到文档末尾。
 * 用于 agent 追问结果落盘——不覆盖用户已设定的其他维度。
 * 空值（空串/仅空白）的条目被忽略；updates 全为空时返回原文。
 */
export function mergeIntentSections(current: string, updates: Record<string, string>): string {
  const entries = Object.entries(updates).filter(([, value]) => typeof value === 'string' && value.trim());
  if (entries.length === 0) return current;

  const { header, sections } = splitSections(current);
  for (const [title, content] of entries) {
    const index = sections.findIndex((section) => section.title === title);
    if (index >= 0) {
      sections[index] = { title, body: content.trim() };
    } else {
      sections.push({ title, body: content.trim() });
    }
  }

  const body = sections.map((section) => `## ${section.title}\n\n${section.body}`).join('\n\n');
  return (header.trim() ? header.trim() + '\n\n' : '') + body + '\n';
}
