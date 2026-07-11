import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { extractChapterOutline, identifyCast, buildCastLayer } from '../../../src/agent/chapter-context';

describe('chapter-context', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-cc-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function writeChapter(chapterNum: number, content: string) {
    await fs.mkdir(path.join(dir, '.novel', 'outline', 'chapters'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'outline', 'chapters', `第${chapterNum}章.md`),
      content,
      'utf-8',
    );
  }

describe('extractChapterOutline', () => {

  it('reads a single chapter card file', async () => {
    await writeChapter(1, '## 第 1 章：启程前夜\n- **POV**：武松\n- **核心事件**：备战');
    await writeChapter(2, '## 第 2 章：远行\n- **POV**：武松\n- **核心事件**：远行');
    const block = await extractChapterOutline(dir, 1);
    expect(block).toContain('第 1 章');
    expect(block).toContain('备战');
    expect(block).not.toContain('远行');
  });

  it('returns placeholder when chapter file not found', async () => {
    await writeChapter(1, '## 第 1 章：a\n- **POV**：x');
    const block = await extractChapterOutline(dir, 99);
    expect(block).toContain('未在 outline/chapters/ 中规划');
  });

  it('returns placeholder when outline directory missing', async () => {
    const block = await extractChapterOutline(dir, 1);
    expect(block).toContain('未在 outline/chapters/ 中规划');
  });
});

describe('identifyCast', () => {
  it('level 1: uses outline-meta.json pov', async () => {
    await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.novel', 'outline-meta.json'),
      JSON.stringify({ actBreaks: [5, 15], chapters: [{ chapter: 1, pov: '武松' }] }),
    );
    const cast = await identifyCast(dir, 1, '');
    expect(cast.pov).toBe('武松');
    expect(cast.full).toContain('武松');
  });

  it('level 2: parses 出场角色 row from outline block', async () => {
    const block = `#### 第11章：相遇
| POV | 武松 |
| 出场角色 | 武松、鲁智深 |`;
    const cast = await identifyCast(dir, 11, block);
    expect(cast.pov).toBe('武松');
    expect(cast.full).toContain('武松');
    expect(cast.full).toContain('鲁智深');
  });

  it('level 3: name-matches against character names', async () => {
    const block = `#### 第5章：初阵
武松在渡口遇到老船工和恶霸。`;
    const names = ['武松', '鲁智深', '西门庆'];
    const cast = await identifyCast(dir, 5, block, names);
    expect(cast.full).toContain('武松');
    expect(cast.brief).not.toContain('武松');
    expect(cast.full).not.toContain('鲁智深');
  });

  it('level 3 fallback: matches names mentioned in block', async () => {
    const block = `#### 第12章
武松和鲁智深谈话，提到西门庆。`;
    const names = ['武松', '鲁智深', '西门庆'];
    const cast = await identifyCast(dir, 12, block, names);
    expect(cast.full).toContain('武松');
    expect(cast.full).toContain('鲁智深');
    expect(cast.brief).toContain('西门庆');
  });

  it('all-fail: returns empty cast', async () => {
    const cast = await identifyCast(dir, 1, '');
    expect(cast.pov).toBe('');
    expect(cast.full).toEqual([]);
    expect(cast.brief).toEqual([]);
  });
});

describe('buildCastLayer', () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, '.novel', 'characters', 'profiles'), { recursive: true });
  });

  it('L1: injects key sections of POV profile, skips verbose sections', async () => {
    const profile = `# 武松

## 基本信息
- 姓名：武松

## 出身与经历
幼年家道中落，寄人篱下。

## 驱动力三角
- 外在目标：复仇
- 核心缺陷：太窄

## 性格
沉默寤言，右手虚握。

## 成长弧线
（此处 5000 字弧线详情，不应注入）`;
    await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles', '武松.md'), profile);

    const layer = await buildCastLayer(dir, { pov: '武松', full: ['武松'], brief: [] });
    expect(layer).toContain('武松');
    expect(layer).toContain('出身与经历');
    expect(layer).toContain('驱动力三角');
    expect(layer).toContain('太窄');
    expect(layer).not.toContain('5000 字弧线详情');
  });

  it('L1: truncates profile over 6KB budget', async () => {
    const longSection = 'A'.repeat(7000);
    const profile = `# 西门庆\n\n## 出身与经历\n${longSection}`;
    await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles', '西门庆.md'), profile);
    const layer = await buildCastLayer(dir, { pov: '', full: ['西门庆'], brief: [] });
    expect(layer.length).toBeLessThan(7000);
    expect(layer).toContain('完整档案见');
  });

  it('L2: brief card for minor characters', async () => {
    const profile = `# 鲁智深\n城镇掌柜，门派长辈。温和本性。`;
    await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles', '鲁智深.md'), profile);
    const layer = await buildCastLayer(dir, { pov: '武松', full: ['武松'], brief: ['鲁智深'] });
    expect(layer).toContain('鲁智深');
    expect(layer).toContain('速查');
  });

  it('total budget: degrades to L2 when exceeding 20KB', async () => {
    const big = 'B'.repeat(5900);
    for (const name of ['武松', '西门庆', '世子', '顾琪']) {
      await fs.writeFile(
        path.join(dir, '.novel', 'characters', 'profiles', `${name}.md`),
        `# ${name}\n\n## 出身与经历\n${big}`,
      );
    }
    const layer = await buildCastLayer(dir, {
      pov: '武松',
      full: ['武松', '西门庆', '世子', '顾琪'],
      brief: [],
    });
    expect(layer).toContain('速查');
  });

  it('skips missing profile files gracefully', async () => {
    const layer = await buildCastLayer(dir, { pov: '不存在', full: ['不存在'], brief: [] });
    expect(layer).not.toContain('不存在.md');
  });

  describe('voice samples', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(dir, '.novel', 'characters', 'voices'), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.novel', 'characters', 'profiles', '武松.md'),
        '# 武松\n\n## 出身与经历\n少年。',
      );
    });

    it('appends voice samples when voices file exists', async () => {
      await fs.writeFile(
        path.join(dir, '.novel', 'characters', 'voices', '武松.md'),
        '## 独白\n心绪难平。\n\n## 对话\n"请让一让。"',
      );
      const layer = await buildCastLayer(dir, { pov: '武松', full: ['武松'], brief: [] });
      expect(layer).toContain('声口样本');
      expect(layer).toContain('心绪难平');
    });

    it('skips voice when no voices file', async () => {
      const layer = await buildCastLayer(dir, { pov: '武松', full: ['武松'], brief: [] });
      expect(layer).not.toContain('声口样本');
    });
  });
});
});
