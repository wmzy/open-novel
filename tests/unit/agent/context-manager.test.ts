import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  generateChapterSummaryPath,
  getChapterSummaries,
  buildRollingSummaryContext,
  getStateTable,
  updateStateTable,
  initStateTable,
  ensureContextArtifacts,
} from '../../../src/agent/context-manager';

async function seedProfiles(dir: string, names: string[]) {
  await fs.mkdir(path.join(dir, '.novel', 'characters'), { recursive: true });
  const body = names.map((n, i) => `## 角色${i + 1}\n- 姓名：${n}\n- 年龄：20`).join('\n\n');
  await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles.md'), body);
}

async function writeSummary(dir: string, chapter: number, text: string) {
  const chaptersDir = path.join(dir, '.novel', 'chapters');
  await fs.mkdir(chaptersDir, { recursive: true });
  await fs.writeFile(path.join(chaptersDir, `第${chapter}章.summary.md`), text);
}

async function writeChapterBody(dir: string, relPath: string, text: string) {
  const full = path.join(dir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, text);
}

describe('context-manager', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'on-ctx-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('chapter summaries', () => {
    it('generateChapterSummaryPath returns the 第N章 path and ensures the dir', async () => {
      const p = await generateChapterSummaryPath(dir, 7);
      expect(p).toBe(path.join(dir, '.novel', 'chapters', '第7章.summary.md'));
      // 目录应已被创建
      const stat = await fs.stat(path.join(dir, '.novel', 'chapters'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('getChapterSummaries reads and sorts by chapter number', async () => {
      await writeSummary(dir, 3, 'three');
      await writeSummary(dir, 1, 'one');
      await writeSummary(dir, 2, 'two');
      const out = await getChapterSummaries(dir);
      expect(out.map((s) => s.chapter)).toEqual([1, 2, 3]);
      expect(out[0].summary).toBe('one');
    });

    it('getChapterSummaries ignores non-summary chapter files', async () => {
      const chaptersDir = path.join(dir, '.novel', 'chapters');
      await fs.mkdir(chaptersDir, { recursive: true });
      await fs.writeFile(path.join(chaptersDir, 'ch1.md'), 'chapter body'); // 正文，不是摘要
      await writeSummary(dir, 1, 'summary one');
      const out = await getChapterSummaries(dir);
      expect(out).toHaveLength(1);
      expect(out[0].summary).toBe('summary one');
    });

    it('getChapterSummaries returns [] when chapters dir missing', async () => {
      expect(await getChapterSummaries(dir)).toEqual([]);
    });

    it('buildRollingSummaryContext: recent detailed, earlier compressed to <=50 chars', async () => {
      const long = '一二三四五六七八九十'.repeat(10); // 100 字
      await writeSummary(dir, 1, long);
      await writeSummary(dir, 2, long);
      await writeSummary(dir, 3, long);
      await writeSummary(dir, 4, 'recent four'); // 最近 3 章为 2,3,4
      const text = await buildRollingSummaryContext(dir);
      // 第1章进入简摘区，应被压缩到 50 字 + 省略号
      expect(text).toContain('第1章：');
      const briefLine = text.split('\n').find((l) => l.startsWith('- 第1章：'))!;
      expect(briefLine.length).toBeLessThanOrEqual(60);
      expect(briefLine.endsWith('…')).toBe(true);
      // 最近章节使用详摘，保留全文
      expect(text).toContain('recent four');
      expect(text).toContain('##### 第4章');
    });

    it('buildRollingSummaryContext returns empty string when no summaries', async () => {
      expect(await buildRollingSummaryContext(dir)).toBe('');
    });
  });

  describe('state table', () => {
    it('getStateTable returns empty state when file missing', async () => {
      const s = await getStateTable(dir);
      expect(s.characters).toEqual([]);
      expect(s.timeline).toBe('');
      expect(s.activeForeshadows).toEqual([]);
      expect(s.lastUpdatedChapter).toBe(0);
    });

    it('updateStateTable writes merged state and updates timestamp', async () => {
      await updateStateTable(dir, { timeline: '第三天清晨', lastUpdatedChapter: 3 });
      let s = await getStateTable(dir);
      expect(s.timeline).toBe('第三天清晨');
      expect(s.lastUpdatedChapter).toBe(3);
      expect(s.updatedAt).not.toBe('');

      // 二次更新为浅合并：timeline 保留
      await updateStateTable(dir, { activeForeshadows: [1, 2] });
      s = await getStateTable(dir);
      expect(s.timeline).toBe('第三天清晨');
      expect(s.activeForeshadows).toEqual([1, 2]);
    });

    it('updateStateTable accepts partial characters array', async () => {
      await updateStateTable(dir, {
        characters: [
          {
            name: '林青',
            location: '客栈',
            emotion: '警觉',
            knows: ['密道位置'],
            relationships: { 苏晚: '盟友' },
            lastAppearance: 3,
          },
        ],
      });
      const s = await getStateTable(dir);
      expect(s.characters).toHaveLength(1);
      expect(s.characters[0].name).toBe('林青');
      expect(s.characters[0].knows).toEqual(['密道位置']);
    });

    it('getStateTable tolerates corrupt JSON', async () => {
      await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
      await fs.writeFile(path.join(dir, '.novel', 'state.json'), '{ not valid json');
      const s = await getStateTable(dir);
      expect(s.characters).toEqual([]);
    });

    it('initStateTable seeds characters from profiles and does not overwrite', async () => {
      await seedProfiles(dir, ['林青', '苏晚']);
      await initStateTable(dir);
      let s = await getStateTable(dir);
      expect(s.characters.map((c) => c.name)).toEqual(['林青', '苏晚']);
      expect(s.characters[0].lastAppearance).toBe(0);

      // 再次调用不应覆盖已有状态
      await updateStateTable(dir, { timeline: 'changed' });
      await initStateTable(dir);
      s = await getStateTable(dir);
      expect(s.timeline).toBe('changed');
    });
  });

  describe('ensureContextArtifacts (兜底补全)', () => {
    it('为缺失摘要的章节生成占位摘要（含 [自动生成] 标记，去掉标题行）', async () => {
      const body = '# 第一章 启程\n主角林青踏上了前往北境的旅途，风雪交加。';
      await writeChapterBody(dir, '.novel/chapters/chapter-1.md', body);

      await ensureContextArtifacts(dir, new Set(['.novel/chapters/chapter-1.md']));

      const summaries = await getChapterSummaries(dir);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].chapter).toBe(1);
      expect(summaries[0].summary.startsWith('[自动生成]')).toBe(true);
      // 标题行被去掉，正文内容保留
      expect(summaries[0].summary).toContain('林青');
      expect(summaries[0].summary).not.toContain('启程');
    });

    it('也识别中文命名 第N章.md', async () => {
      await writeChapterBody(dir, '.novel/chapters/第2章.md', '正文内容摘要。');
      await ensureContextArtifacts(dir, new Set(['.novel/chapters/第2章.md']));
      const summaries = await getChapterSummaries(dir);
      expect(summaries.map((s) => s.chapter)).toEqual([2]);
    });

    it('已存在的摘要不被覆盖', async () => {
      await writeSummary(dir, 1, '手写的语义摘要');
      await writeChapterBody(dir, '.novel/chapters/chapter-1.md', '# 标题\n正文');

      await ensureContextArtifacts(dir, new Set(['.novel/chapters/chapter-1.md']));

      const summaries = await getChapterSummaries(dir);
      expect(summaries).toHaveLength(1);
      expect(summaries[0].summary).toBe('手写的语义摘要');
      expect(summaries[0].summary.startsWith('[自动生成]')).toBe(false);
    });

    it('writtenPaths 中包含的摘要文件不会触发覆盖', async () => {
      // agent 已写摘要：摘要路径在 writtenPaths 中，不应被当作正文处理
      await writeSummary(dir, 1, '已有摘要');
      await ensureContextArtifacts(
        dir,
        new Set(['.novel/chapters/第1章.summary.md']),
      );
      const summaries = await getChapterSummaries(dir);
      expect(summaries[0].summary).toBe('已有摘要');
    });

    it('无章节文件时安全 no-op（不生成任何摘要）', async () => {
      // 预置 state.json，使初始化也无副作用
      await updateStateTable(dir, { timeline: 'keep' });
      await expect(
        ensureContextArtifacts(dir, new Set<string>()),
      ).resolves.toBeUndefined();
      expect(await getChapterSummaries(dir)).toEqual([]);
    });

    it('state.json 不存在时初始化状态表', async () => {
      await seedProfiles(dir, ['林青', '苏晚']);
      await writeChapterBody(dir, '.novel/chapters/chapter-1.md', '正文');
      // 确保 state.json 尚不存在
      await expect(fs.access(path.join(dir, '.novel', 'state.json'))).rejects.toThrow();

      await ensureContextArtifacts(dir, new Set(['.novel/chapters/chapter-1.md']));

      const s = await getStateTable(dir);
      expect(s.characters.map((c) => c.name)).toEqual(['林青', '苏晚']);
    });

    it('正文字符超过上限时截断并补省略号', async () => {
      const long = '甲'.repeat(300); // 300 字
      await writeChapterBody(dir, '.novel/chapters/chapter-1.md', long);
      await ensureContextArtifacts(dir, new Set(['.novel/chapters/chapter-1.md']));
      const summaries = await getChapterSummaries(dir);
      // [自动生成](6) + 空格(1) + 200字 + '…'(1) = 208
      expect(summaries[0].summary.endsWith('…')).toBe(true);
      expect(summaries[0].summary.length).toBe(6 + 1 + 200 + 1);
    });

    it('state.json 损坏（键含冒号）时自动修复', async () => {
      const stateDir = path.join(dir, '.novel');
      await fs.mkdir(stateDir, { recursive: true });
      // 写入损坏的 JSON：relationships 键含冒号
      const broken = `{\n  "characters": [],\n  "timeline": "test",\n  "activeForeshadows": [],\n  "lastUpdatedChapter": 5,\n  "updatedAt": "2026-07-03T00:00:00Z"\n}`;
      await fs.writeFile(path.join(stateDir, 'state.json'), broken);
      await ensureContextArtifacts(dir, new Set<string>());
      const s = await getStateTable(dir);
      expect(s.lastUpdatedChapter).toBe(5);
      expect(s.timeline).toBe('test');
    });

    it('state.json 损坏（时间戳拆分）时自动修复', async () => {
      const stateDir = path.join(dir, '.novel');
      await fs.mkdir(stateDir, { recursive: true });
      // 写入损坏的 JSON：时间戳被拆成 key:value 对
      const broken = `{\n  "characters": [],\n  "timeline": "test",\n  "activeForeshadows": [],\n  "lastUpdatedChapter": 3,\n  "updatedAt": "2026-07-03T18": "00:00Z"\n}`;
      await fs.writeFile(path.join(stateDir, 'state.json'), broken);
      await ensureContextArtifacts(dir, new Set<string>());
      const s = await getStateTable(dir);
      expect(s.lastUpdatedChapter).toBe(3);
      expect(s.updatedAt).toContain('2026-07-03');
    });

    it('state.json 含未转义控制字符时自动修复', async () => {
      const stateDir = path.join(dir, '.novel');
      await fs.mkdir(stateDir, { recursive: true });
      // 字符串值内含裸换行符
      const broken = '{\n  "characters": [],\n  "timeline": "第一行\\n第二行",\n  "activeForeshadows": [],\n  "lastUpdatedChapter": 1,\n  "updatedAt": "2026-07-03T00:00:00Z"\n}';
      await fs.writeFile(path.join(stateDir, 'state.json'), broken);
      await ensureContextArtifacts(dir, new Set<string>());
      const s = await getStateTable(dir);
      expect(s.lastUpdatedChapter).toBe(1);
      expect(s.timeline).toContain('第一行');
    });

    it('state.json 严重损坏时备份为 .corrupted.bak 并重新初始化', async () => {
      const stateDir = path.join(dir, '.novel');
      await fs.mkdir(stateDir, { recursive: true });
      await seedProfiles(dir, ['林青']); // 提供 profiles 供 initStateTable 读取
      // 严重损坏：单引号闭合 JSON 字符串值
      const broken = `{ "timeline": '错误闭合', broken }`;
      await fs.writeFile(path.join(stateDir, 'state.json'), broken);
      await ensureContextArtifacts(dir, new Set<string>());
      // 损坏文件被备份
      const bak = await fs.readFile(path.join(stateDir, 'state.json.corrupted.bak'), 'utf-8');
      expect(bak).toContain('错误闭合');
      // state.json 被重新初始化为有效 JSON
      const s = await getStateTable(dir);
      expect(s.characters.map((c) => c.name)).toEqual(['林青']);
    });

    it('.degraded.md 文件被归档到 _discarded/', async () => {
      const chaptersDir = path.join(dir, '.novel', 'chapters');
      await fs.mkdir(chaptersDir, { recursive: true });
      await fs.writeFile(path.join(chaptersDir, '第12章.degraded.md'), '退化内容');
      await fs.writeFile(path.join(chaptersDir, '第12章.summary.md'), '摘要');
      await ensureContextArtifacts(dir, new Set<string>());
      // .degraded.md 被移走
      await expect(fs.access(path.join(chaptersDir, '第12章.degraded.md'))).rejects.toThrow();
      // 移入 _discarded/
      const discarded = path.join(chaptersDir, '_discarded', '第12章.degraded.md');
      const content = await fs.readFile(discarded, 'utf-8');
      expect(content).toBe('退化内容');
      // 正常摘要文件不受影响
      const sum = await fs.readFile(path.join(chaptersDir, '第12章.summary.md'), 'utf-8');
      expect(sum).toBe('摘要');
    });

    it('过大的正文文件被归档到 _discarded/', async () => {
      const chaptersDir = path.join(dir, '.novel', 'chapters');
      await fs.mkdir(chaptersDir, { recursive: true });
      // 35KB 正文（超过 30KB 上限）
      const big = '正文'.repeat(18000);
      await fs.writeFile(path.join(chaptersDir, '第14章.md'), big);
      await ensureContextArtifacts(dir, new Set<string>());
      // 过大文件被移走
      await expect(fs.access(path.join(chaptersDir, '第14章.md'))).rejects.toThrow();
      // 移入 _discarded/ 并标记 .oversized
      await expect(fs.access(path.join(chaptersDir, '_discarded', '第14章.md.oversized'))).resolves.toBeUndefined();
    });

    it('正常大小的正文文件不受清理影响', async () => {
      const chaptersDir = path.join(dir, '.novel', 'chapters');
      await fs.mkdir(chaptersDir, { recursive: true });
      await fs.writeFile(path.join(chaptersDir, '第1章.md'), '正常正文内容');
      await ensureContextArtifacts(dir, new Set<string>());
      // 文件仍在原位
      const content = await fs.readFile(path.join(chaptersDir, '第1章.md'), 'utf-8');
      expect(content).toBe('正常正文内容');
    });
  });
});
