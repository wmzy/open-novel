/**
 * outline-meta 章节卡片元数据解析与索引自愈测试。
 *
 * 来源：滚动式大纲改造新增 parseChapterCard / regenerateOutlineIndex /
 * COMMITMENT_LABELS（章节卡片引用行元数据 + outline/index.md 自愈重建）。
 * parseOutlineMeta 的解析用例在 diagram-builders.test.ts 既有 describe 中。
 *
 * 归并建议：diagram-builders.test.ts 中 describe('parseOutlineMeta') 未来可并入本文件，
 * 使 outline-meta 的用例集中一处。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseChapterCard,
  regenerateOutlineIndex,
  COMMITMENT_LABELS,
} from '../../../src/shared/outline-meta';

describe('parseChapterCard', () => {
  it('解析标题（截掉「｜」后的幕/字数标注）与 committed 等级', () => {
    const card = [
      '## 第 3 章：夜袭 ｜ 第一幕·设置 ｜ 目标约 3000 字',
      '> commitment: committed',
      '',
      '- **主要场景**：粮仓夜袭',
    ].join('\n');
    const meta = parseChapterCard(card);
    expect(meta.title).toBe('夜袭');
    expect(meta.commitment).toBe('committed');
    expect(meta.openQuestions).toEqual([]);
  });

  it('解析 open 等级与 open-questions 列表项', () => {
    const card = [
      '# 第 12 章：分岔',
      '',
      '> commitment: open',
      '> open-questions:',
      '>   - 结局走向选 A 还是 B',
      '>   - 配角是否在此离队',
      '',
      '- **幕级骨架**：主角抵达分岔口。',
    ].join('\n');
    const meta = parseChapterCard(card);
    expect(meta.title).toBe('分岔');
    expect(meta.commitment).toBe('open');
    expect(meta.openQuestions).toEqual(['结局走向选 A 还是 B', '配角是否在此离队']);
  });

  it('支持 open-questions 单行形式（分号分隔）', () => {
    const card = ['## 第 5 章：抉择', '> commitment: open', '> open-questions: 问题一；问题二'].join('\n');
    const meta = parseChapterCard(card);
    expect(meta.openQuestions).toEqual(['问题一', '问题二']);
  });

  it('无元数据 / 非法等级 / 无标题行时回退安全中间态', () => {
    expect(parseChapterCard('## 第 1 章：起程\n- **主要场景**：x').commitment).toBe('tentative');
    expect(parseChapterCard('## 第 1 章\n> commitment: 已锁定').commitment).toBe('tentative');
    const noTitle = parseChapterCard('> commitment: open\n正文');
    expect(noTitle.title).toBeNull();
    expect(noTitle.commitment).toBe('open');
    expect(parseChapterCard('')).toEqual({ title: null, commitment: 'tentative', openQuestions: [] });
  });
});

describe('regenerateOutlineIndex', () => {
  let novelDir: string;
  beforeEach(async () => {
    novelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-omi-'));
  });
  afterEach(async () => {
    await fs.rm(novelDir, { recursive: true, force: true });
  });

  async function writeCard(chapter: number, content: string) {
    await fs.mkdir(path.join(novelDir, 'outline', 'chapters'), { recursive: true });
    await fs.writeFile(path.join(novelDir, 'outline', 'chapters', `第${chapter}章.md`), content, 'utf-8');
  }

  it('从卡片重建 index：三幕表 + 每章行（章号|标题|承诺等级|文件名），无 ? 占位', async () => {
    await writeCard(1, '## 第 1 章：起程\n> commitment: committed\n- **主要场景**：出山');
    await writeCard(2, '## 第 2 章：遇敌\n> commitment: open\n> open-questions:\n>   - 敌人身份是否揭穿');
    await writeCard(3, '## 第 3 章：无元数据章');

    const index = await regenerateOutlineIndex(novelDir);

    expect(index).toContain('| 幕 | 章节范围 |');
    expect(index).toContain(`| 1 | 起程 | ${COMMITMENT_LABELS.committed} | chapters/第1章.md |`);
    expect(index).toContain(`| 2 | 遇敌 | ${COMMITMENT_LABELS.open} | chapters/第2章.md |`);
    // 章号取自文件名、承诺等级缺省 tentative，绝不出现 ? 占位
    expect(index).toContain(`| 3 | 无元数据章 | ${COMMITMENT_LABELS.tentative} | chapters/第3章.md |`);
    expect(index).not.toContain('?');

    // index.md 确实落盘
    const written = await fs.readFile(path.join(novelDir, 'outline', 'index.md'), 'utf-8');
    expect(written).toBe(index);
    expect(index).toContain('并非未完成');
  });

  it('乱序/无关文件稳健：按章号升序输出，忽略不可解析文件', async () => {
    await writeCard(10, '## 第 10 章：远期\n> commitment: open');
    await writeCard(2, '## 第 2 章：中段\n> commitment: tentative');
    await writeCard(1, '## 第 1 章：开局\n> commitment: committed');
    await fs.writeFile(path.join(novelDir, 'outline', 'chapters', '笔记.md'), '无关文件', 'utf-8');
    await fs.writeFile(path.join(novelDir, 'outline', 'chapters', '草稿.txt'), '非 md', 'utf-8');

    const index = await regenerateOutlineIndex(novelDir);
    const rows = index.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('| 1 |');
    expect(rows[1]).toContain('| 2 |');
    expect(rows[2]).toContain('| 10 |');
  });

  it('outline-meta.json 缺失时按最大章号比例推断三幕分界', async () => {
    for (const ch of [1, 2, 3, 4]) {
      await writeCard(ch, `## 第 ${ch} 章：章${ch}`);
    }
    const index = await regenerateOutlineIndex(novelDir);
    // 4 章 → act1End=1、act2End=3：第一幕 第 1 章、第二幕 第 2–3 章、第三幕 第 4 章
    expect(index).toContain('| 第一幕·设置 | 第 1 章 |');
    expect(index).toContain('| 第二幕·对抗 | 第 2–3 章 |');
    expect(index).toContain('| 第三幕·解决 | 第 4 章 |');
  });

  it('outline-meta.json 存在时优先采用其 actBreaks（超出实际章数时截断）', async () => {
    await writeCard(1, '## 第 1 章：a');
    await writeCard(2, '## 第 2 章：b');
    await fs.writeFile(
      path.join(novelDir, 'outline-meta.json'),
      JSON.stringify({ actBreaks: [1, 3], chapters: [{ chapter: 1, pov: '甲' }] }),
      'utf-8',
    );
    const index = await regenerateOutlineIndex(novelDir);
    expect(index).toContain('| 第一幕·设置 | 第 1 章 |');
    expect(index).toContain('| 第二幕·对抗 | 第 2 章 |');
    expect(index).not.toContain('| 第三幕');
  });

  it('无 chapters 目录时不覆盖现有 index，返回其原文', async () => {
    await fs.mkdir(path.join(novelDir, 'outline'), { recursive: true });
    const existing = '# 既有索引\n人工维护内容';
    await fs.writeFile(path.join(novelDir, 'outline', 'index.md'), existing, 'utf-8');

    const index = await regenerateOutlineIndex(novelDir);
    expect(index).toBe(existing);
    expect((await fs.readFile(path.join(novelDir, 'outline', 'index.md'), 'utf-8'))).toBe(existing);
  });

  it('目录整体缺失时返回空串且不创建文件', async () => {
    const index = await regenerateOutlineIndex(novelDir);
    expect(index).toBe('');
    await expect(fs.stat(path.join(novelDir, 'outline'))).rejects.toThrow();
  });
});
