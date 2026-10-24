/**
 * 里程碑回顾（retrospective）提示词与产物约定。
 *
 * 自动里程碑在每 K 章/卷末创建带标签快照后，会以「正常 run」的形式触发
 * 一次回顾生成（stage=retro）。回顾报告写入 .novel/retro/ 目录，与既有
 * 回溯影响分析（POST /retro）共用产物目录，但报告内容是阶段复盘而非
 * 设定修订影响面。
 */

/** 回顾/回溯报告产物目录（相对 .novel/）。 */
export const RETRO_DIR = 'retro';

export interface MilestoneRetrospectiveInput {
  /** 'chapter' 或 'volume'。 */
  kind: 'chapter' | 'volume';
  /** 里程碑边界章号（K 的倍数或卷末章）。 */
  chapter: number;
  /** 快照标签（chapter-50 / volume-60）。 */
  label: string;
  /** 卷名（kind=volume 时可选）。 */
  volumeName?: string;
  /** 当前全书已写完章节数。 */
  finalizedChapters: number;
}

/** 回顾报告文件名：里程碑-chapter-50.md。 */
export function retrospectiveReportFileName(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `里程碑-${safe}.md`;
}

/** 生成回顾 run 的 user message（composePrompt 的 stage=retro）。 */
export function buildMilestoneRetrospectivePrompt(input: MilestoneRetrospectiveInput): string {
  const boundary =
    input.kind === 'volume'
      ? `第 ${input.chapter} 章（卷末${input.volumeName ? `：${input.volumeName}` : ''}）`
      : `第 ${input.chapter} 章`;
  const report = `.novel/${RETRO_DIR}/${retrospectiveReportFileName(input.label)}`;

  return [
    `【里程碑回顾】${boundary} 已完成，全书累计 ${input.finalizedChapters} 章有效正文。请生成一份阶段回顾报告。`,
    '',
    '执行步骤：',
    '1. 读取 .novel/state.json、.novel/foreshadow.json，以及最近 10 章的 .novel/chapters/*.summary.md（不存在时读正文节选）。',
    '2. 梳理：本阶段剧情推进、主要角色状态与弧线变化、伏笔埋设/推进/回收情况、前后矛盾或待修正点、下一阶段的写作建议。',
    `3. 将回顾写入 ${report}（Markdown，使用清晰小节；只新增该报告）。`,
    '4. 不要修改正文章节、大纲、角色档案或 state.json——本任务只产出回顾报告，供作者决定后续修订。',
    '5. 完成后用简短清单汇报本次回顾的关键结论与报告路径。',
  ].join('\n');
}
