import { describe, it, expect } from 'vitest';

import {
  generateOutlineDetailed,
  generateOutlineBrief,
  generateScenes,
  generateCharacterProfiles,
  TEMPLATE_GENERATORS,
  TEMPLATE_FILE_PATHS,
  type TemplateGenOptions,
} from '../../../src/shared/template-generator';

const base: TemplateGenOptions = {
  chapterCount: 20,
  targetWords: 100000,
  title: '风起长林',
  genre: 'wuxia',
  perspective: 'third-person',
  theme: '家国与抉择',
};

/** 统计每章标题出现的次数（详细大纲 / 场景设计）。 */
function countChapters(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

describe('template-generator', () => {
  describe('generateOutlineDetailed', () => {
    it('按 chapterCount 生成等量章节骨架', () => {
      const out = generateOutlineDetailed(base);
      expect(countChapters(out, /^## 第 \d+ 章：/gm)).toBe(20);
      // 章节序号应连续 1..20
      for (let i = 1; i <= 20; i++) {
        expect(out).toContain(`第 ${i} 章`);
      }
    });

    it('每章包含标题/场景/目标/冲突/结果/伏笔字段', () => {
      const out = generateOutlineDetailed({ ...base, chapterCount: 3 });
      const block = out.split('## 第 1 章：')[1].split('## 第 2 章：')[0];
      expect(block).toContain('结构定位');
      expect(block).toContain('主要场景');
      expect(block).toContain('目标');
      expect(block).toContain('冲突');
      expect(block).toContain('结果');
      expect(block).toContain('伏笔/回调');
    });

    it('正确标注三幕结构（20 章：5/10/5）', () => {
      const out = generateOutlineDetailed(base);
      // 第 1 章属第一幕，第 10 章属第二幕，第 20 章属第三幕
      expect(out).toMatch(/第 1 章：.*第一幕·设置/);
      expect(out).toMatch(/第 10 章：.*第二幕·对抗/);
      expect(out).toMatch(/第 20 章：.*第三幕·解决/);
    });

    it('头部展示每章字数 = 目标字数 / 章节数', () => {
      const out = generateOutlineDetailed({ ...base, targetWords: 80000, chapterCount: 20 });
      expect(out).toContain('每章约 4000 字');
    });

    it('chapterCount <= 0 时回退为 1 章', () => {
      const out = generateOutlineDetailed({ ...base, chapterCount: 0 });
      expect(countChapters(out, /^## 第 \d+ 章：/gm)).toBe(1);
    });

    it('包含标题与类型/主题/视角元信息', () => {
      const out = generateOutlineDetailed(base);
      expect(out).toContain('《风起长林》');
      expect(out).toContain('类型：wuxia');
      expect(out).toContain('主题：家国与抉择');
      expect(out).toContain('第三人称');
    });
  });

  describe('generateOutlineBrief', () => {
    it('包含三幕标题与字数分配', () => {
      const out = generateOutlineBrief(base);
      expect(out).toContain('第一幕：设置');
      expect(out).toContain('第二幕：对抗');
      expect(out).toContain('第三幕：解决');
      // 各幕字数约各占 25% / 50% / 25%
      expect(out).toContain('约 25000 字'); // 第一幕 25%
      expect(out).toContain('约 50000 字'); // 第二幕 50%
    });

    it('标注各幕章节区间', () => {
      const out = generateOutlineBrief(base);
      // 第一幕 1–5，第三幕 16–20
      expect(out).toMatch(/第一幕：设置（第 1–5 章/);
      expect(out).toMatch(/第三幕：解决（第 16–20 章/);
    });

    it('章节过少（2 章）时第二幕为空但有兜底说明', () => {
      const out = generateOutlineBrief({ ...base, chapterCount: 2 });
      expect(out).toContain('第二幕：对抗');
      expect(out).toContain('章节数较少');
    });
  });

  describe('generateScenes', () => {
    it('每章生成主动场景与被动场景一对', () => {
      const out = generateScenes({ ...base, chapterCount: 5 });
      expect(countChapters(out, /^## 第 \d+ 章场景/gm)).toBe(5);
      // 每章应含「主动场景（Scene）」与「被动场景（Sequel）」
      const activeCount = (out.match(/主动场景（Scene）/g) ?? []).length;
      const passiveCount = (out.match(/被动场景（Sequel）/g) ?? []).length;
      expect(activeCount).toBe(5);
      expect(passiveCount).toBe(5);
    });

    it('主动场景含目标/冲突/灾难，被动场景含反应/困境/决定', () => {
      const out = generateScenes({ ...base, chapterCount: 1 });
      expect(out).toContain('**目标**');
      expect(out).toContain('**冲突**');
      expect(out).toContain('**灾难**');
      expect(out).toContain('**反应**');
      expect(out).toContain('**困境**');
      expect(out).toContain('**决定**');
    });
  });

  describe('generateCharacterProfiles', () => {
    it('包含主角（驱动三角）、反派、至少 2 个配角', () => {
      const out = generateCharacterProfiles(base);
      expect(out).toContain('主角（驱动三角：欲望 / 需求 / 创伤）');
      expect(out).toContain('反派');
      // 配角至少 2 个（标题出现「### 」角色块）
      const supportMatches = out.match(/配角 \d 姓名/g) ?? [];
      expect(supportMatches.length).toBeGreaterThanOrEqual(2);
    });

    it('主角含欲望/需求/创伤三要素', () => {
      const out = generateCharacterProfiles(base);
      expect(out).toContain('欲望（Want，外在目标）');
      expect(out).toContain('需求（Need，内在成长）');
      expect(out).toContain('创伤（Ghost/Wound，过往阴影）');
    });

    it('每个角色块含 3 句典型台词、外貌锚点、行为习惯', () => {
      const out = generateCharacterProfiles(base);
      // 至少 4 个角色（主角 + 反派 + 2 配角）× 3 句台词 = 12 条编号台词
      const sampleLines = (out.match(/^\s*\d\. "\{ \}"$/gm) ?? []).length;
      expect(sampleLines).toBeGreaterThanOrEqual(12);
      expect(out).toContain('外貌锚点');
      expect(out).toContain('行为习惯');
    });

    it('反派含动机/手段/弱点', () => {
      const out = generateCharacterProfiles(base);
      expect(out).toContain('**动机**');
      expect(out).toContain('**手段**');
      expect(out).toContain('**弱点**');
    });
  });

  describe('常量映射', () => {
    it('TEMPLATE_GENERATORS 与 TEMPLATE_FILE_PATHS 键一致', () => {
      expect(Object.keys(TEMPLATE_GENERATORS).sort()).toEqual(
        Object.keys(TEMPLATE_FILE_PATHS).sort(),
      );
    });

    it('每个生成器均可调用并返回非空中文内容', () => {
      for (const [name, gen] of Object.entries(TEMPLATE_GENERATORS)) {
        const out = gen(base);
        expect(out.length, `${name} 应非空`).toBeGreaterThan(0);
        expect(TEMPLATE_FILE_PATHS[name]).toMatch(/\.md$/);
      }
    });
  });
});
