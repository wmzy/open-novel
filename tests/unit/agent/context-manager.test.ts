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
  readCharacterNames,
  getProgressMarkdown,
  getCharacterStatesMarkdown,
  getStyleRefs,
  parseStyleIndex,
  readIntentTable,
  writeIntentTable,
  splitPlanningPollution,
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
      await writeSummary(dir, 4, '第四章真正的语义摘要，林冲进入山坛后发现令牌，与孙二娘正面对峙，哑叔在旁沉默。'); // 最近 3 章为 2,3,4
      const text = await buildRollingSummaryContext(dir);
      // 第1章进入简摘区，应被压缩到 50 字 + 省略号
      expect(text).toContain('第1章：');
      const briefLine = text.split('\n').find((l) => l.startsWith('- 第1章：'))!;
      expect(briefLine.length).toBeLessThanOrEqual(60);
      expect(briefLine.endsWith('…')).toBe(true);
      // 最近章节使用详摘，保留全文
      expect(text).toContain('林冲进入山坛');
      expect(text).toContain('##### 第4章');
    });

    it('buildRollingSummaryContext returns empty string when no summaries', async () => {
      expect(await buildRollingSummaryContext(dir)).toBe('');
    });

    it('buildRollingSummaryContext 跳过含 [自动生成] 标记的摘要', async () => {
      await writeSummary(dir, 1, '[自动生成] 这是从正文截取的前面两百字不是真正的语义摘要。'.repeat(2));
      await writeSummary(dir, 2, '第二章真正的语义摘要，林冲进入山坛发现令牌，与孙二娘对峙，哑叔在旁沉默。'.repeat(2));
      const text = await buildRollingSummaryContext(dir);
      // 第1章的无效摘要应被跳过
      expect(text).not.toContain('自动生成');
      // 第2章的有效摘要保留
      expect(text).toContain('林冲进入山坛');
    });

    it('buildRollingSummaryContext 跳过与正文逐字复制的摘要', async () => {
      const bodyText = '山道从坟场一路下到山坛，八里路。林冲走在前面，孙二娘走在后面，两人之间只听见脚步声。'.repeat(3);
      await writeChapterBody(dir, '.novel/chapters/第1章.md', bodyText);
      // 摘要是正文前40字的逐字复制
      await writeSummary(dir, 1, bodyText.slice(0, 40));
      const text = await buildRollingSummaryContext(dir);
      // 应被跳过（唯一摘要无效，返回空串）
      expect(text).toBe('');
    });

    it('buildRollingSummaryContext 最近章节附加首尾句', async () => {
      await writeSummary(dir, 1, '第一章的语义摘要，内容足够长可以通过校验检测。'.repeat(3));
      await writeChapterBody(dir, '.novel/chapters/第1章.md', '# 第1章 令牌\n这是首句内容描写。中间还有更多叙事文字展开。这是最后一句结尾。');
      const text = await buildRollingSummaryContext(dir);
      expect(text).toContain('[首句]');
      expect(text).toContain('这是首句内容');
      expect(text).toContain('[尾句]');
      expect(text).toContain('这是最后一句结尾');
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

    it('readIntentTable 文件不存在或损坏时返回空表，writeIntentTable 覆盖写回', async () => {
      // 不存在
      expect(await readIntentTable(dir)).toEqual({ characters: [], updatedAt: '' });
      // 损坏
      await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
      await fs.writeFile(path.join(dir, '.novel', 'state-intent.json'), '{ broken');
      expect((await readIntentTable(dir)).characters).toEqual([]);

      await writeIntentTable(dir, {
        characters: [
          { name: '林青', expectedRole: '主角', notes: '期望位置：北境' },
          { name: '', notes: '非法条目应被丢弃' },
        ],
        updatedAt: '',
      });
      const intent = await readIntentTable(dir);
      expect(intent.characters).toHaveLength(1);
      expect(intent.characters[0].name).toBe('林青');
      expect(intent.characters[0].expectedRole).toBe('主角');
      expect(intent.updatedAt).not.toBe('');
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

    it('规划期污染在末尾自动分离（自愈）', async () => {
      // state.json 带污染角色：lastAppearance=0 但 emotion/location 非空
      await updateStateTable(dir, {
        timeline: '第三日',
        lastUpdatedChapter: 0,
        characters: [
          {
            name: '林青',
            location: '北境',
            emotion: '警惕',
            knows: [],
            relationships: {},
            lastAppearance: 0,
          },
        ],
      });

      await ensureContextArtifacts(dir, new Set<string>());

      // state.json 已重置为骨架
      const s = await getStateTable(dir);
      expect(s.characters[0].location).toBe('');
      expect(s.characters[0].emotion).toBe('');
      expect(s.timeline).toBe('第三日'); // 非角色字段保留
      // 期望已移入 state-intent.json
      const intent = await readIntentTable(dir);
      expect(intent.characters.map((i) => i.name)).toEqual(['林青']);
      expect(intent.characters[0].notes).toContain('期望位置：北境');
      expect(intent.characters[0].notes).toContain('期望情绪：警惕');
    });
  });

  describe('readCharacterNames (table index)', () => {
    it('parses names from table-style profiles.md', async () => {
      const profiles = `# 角色档案索引

## 核心角色

| 角色 | 文件 | 定位 |
|------|------|------|
| 🗡️ 武松 | [武松.md](profiles/武松.md) | 主角 |
| 👴 武大郎 | [武大郎.md](profiles/武大郎.md) | 祖父 |`;
      await fs.mkdir(path.join(dir, '.novel', 'characters'), { recursive: true });
      await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles.md'), profiles);

      const names = await readCharacterNames(dir);
      expect(names).toContain('武松');
      expect(names).toContain('武大郎');
      expect(names.length).toBe(2);
    });

    it('still parses legacy field format', async () => {
      const profiles = `- 姓名：林冲\n- 姓名：孙二娘`;
      await fs.mkdir(path.join(dir, '.novel', 'characters'), { recursive: true });
      await fs.writeFile(path.join(dir, '.novel', 'characters', 'profiles.md'), profiles);

      const names = await readCharacterNames(dir);
      expect(names).toContain('林冲');
      expect(names).toContain('孙二娘');
    });
  });

  describe('progress.md / character-states.md 读取', () => {
    it('getProgressMarkdown 返回文件内容', async () => {
      await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
      await fs.writeFile(path.join(dir, '.novel', 'progress.md'), '# 写作进度\n已写到第3章');
      const md = await getProgressMarkdown(dir);
      expect(md).toContain('写作进度');
      expect(md).toContain('已写到第3章');
    });

    it('getProgressMarkdown 文件不存在时返回空串', async () => {
      expect(await getProgressMarkdown(dir)).toBe('');
    });

    it('getCharacterStatesMarkdown 返回文件内容', async () => {
      await fs.mkdir(path.join(dir, '.novel'), { recursive: true });
      await fs.writeFile(path.join(dir, '.novel', 'character-states.md'), '# 角色状态\n林冲在客栈');
      const md = await getCharacterStatesMarkdown(dir);
      expect(md).toContain('角色状态');
      expect(md).toContain('林冲在客栈');
    });

    it('getCharacterStatesMarkdown 文件不存在时返回空串', async () => {
      expect(await getCharacterStatesMarkdown(dir)).toBe('');
    });
  });

  describe('文风参考索引', () => {
    it('parseStyleIndex 解析标准格式', () => {
      const content = [
        '## 全局文风参考',
        '- name: 紧凑散文 | description: 短句、高信息密度 | path: tight-prose.md',
        '- name: 场景：战斗 | description: 快节奏动作 | path: action.md',
      ].join('\n');
      const refs = parseStyleIndex(content);
      expect(refs).toHaveLength(2);
      expect(refs[0]).toEqual({
        name: '紧凑散文',
        description: '短句、高信息密度',
        path: 'tight-prose.md',
      });
      expect(refs[1]).toEqual({
        name: '场景：战斗',
        description: '快节奏动作',
        path: 'action.md',
      });
    });

    it('parseStyleIndex 丢弃缺失 path 或 name 的条目', () => {
      const content = [
        '## 文风参考',
        '- name: 无路径 | description: 只有名字',
        '- description: 没有 name | path: orphan.md',
        '- name: 有效 | description: ok | path: ok.md',
      ].join('\n');
      const refs = parseStyleIndex(content);
      expect(refs).toHaveLength(1);
      expect(refs[0].name).toBe('有效');
      expect(refs[0].path).toBe('ok.md');
    });

    it('parseStyleIndex 去重相同 path', () => {
      const content = [
        '- name: 第一 | path: same.md',
        '- name: 第二 | path: same.md',
      ].join('\n');
      const refs = parseStyleIndex(content);
      expect(refs).toHaveLength(1);
      expect(refs[0].name).toBe('第一');
    });

    it('getStyleRefs 从 index.md 正确解析', async () => {
      await fs.mkdir(path.join(dir, '.novel', 'styles'), { recursive: true });
      const index = [
        '## 全局文风参考',
        '- name: 抒情 | description: 长句、意象丰富 | path: lyrical.md',
        '- name: 硬汉 | description: 简短、干脆 | path: hardboiled.md',
      ].join('\n');
      await fs.writeFile(path.join(dir, '.novel', 'styles', 'index.md'), index);
      const refs = await getStyleRefs(dir);
      expect(refs).toHaveLength(2);
      expect(refs[0].name).toBe('抒情');
      expect(refs[1].path).toBe('hardboiled.md');
    });

    it('getStyleRefs index.md 不存在时扫描目录', async () => {
      const stylesDir = path.join(dir, '.novel', 'styles');
      await fs.mkdir(stylesDir, { recursive: true });
      // 创建若干文风文件（index.md 和 README.md 应被排除）
      await fs.writeFile(
        path.join(stylesDir, 'tight-prose.md'),
        '# 紧凑散文\n短句为主，高信息密度，拒绝冗余修饰。',
      );
      await fs.writeFile(
        path.join(stylesDir, 'action.md'),
        '# 动作场景\n快节奏，动词密集，句子短促有力。',
      );
      await fs.writeFile(path.join(stylesDir, 'README.md'), '# 说明\n本目录存放文风参考。');
      const refs = await getStyleRefs(dir);
      expect(refs).toHaveLength(2);
      const names = refs.map((r) => r.name);
      expect(names).toContain('tight-prose');
      expect(names).toContain('action');
      // description 应从首段正文提取
      const tight = refs.find((r) => r.name === 'tight-prose');
      expect(tight?.description).toContain('短句为主');
    });

    it('getStyleRefs 目录不存在时返回空数组', async () => {
      const refs = await getStyleRefs(dir);
      expect(refs).toEqual([]);
    });
  });

  describe('规划态/运行态分离 (splitPlanningPollution)', () => {
    it('识别污染特征：lastAppearance=0 但 emotion/location 非空的角色被移动，其余不动', async () => {
      await updateStateTable(dir, {
        timeline: '第五日',
        lastUpdatedChapter: 3,
        characters: [
          {
            // 污染：从未出场却有运行态字段
            name: '林青',
            location: '北境关隘',
            emotion: '警惕',
            knows: ['密道位置'],
            relationships: { 苏晚: '盟友' },
            lastAppearance: 0,
          },
          {
            // 正常运行态：已出场，字段保留
            name: '苏晚',
            location: '临安城',
            emotion: '平静',
            knows: [],
            relationships: {},
            lastAppearance: 3,
          },
          {
            // 干净骨架：从未出场且无字段，不算污染
            name: '赵歧',
            location: '',
            emotion: '',
            knows: [],
            relationships: {},
            lastAppearance: 0,
          },
        ],
      });

      const result = await splitPlanningPollution(dir);

      expect(result).toEqual({ moved: ['林青'] });
      const s = await getStateTable(dir);
      const lin = s.characters.find((c) => c.name === '林青')!;
      expect(lin).toEqual({
        name: '林青',
        location: '',
        emotion: '',
        knows: [],
        relationships: {},
        lastAppearance: 0,
      });
      // 非污染角色不受影响
      const su = s.characters.find((c) => c.name === '苏晚')!;
      expect(su.location).toBe('临安城');
      expect(su.lastAppearance).toBe(3);
      expect(s.characters.find((c) => c.name === '赵歧')!.emotion).toBe('');
      // 非角色字段保留
      expect(s.timeline).toBe('第五日');
      expect(s.lastUpdatedChapter).toBe(3);
    });

    it('期望归档进 intent：knows/relationships 一并入 notes，数据不丢失', async () => {
      await updateStateTable(dir, {
        characters: [
          {
            name: '林青',
            location: '北境',
            emotion: '',
            knows: ['密道位置'],
            relationships: { 苏晚: '盟友' },
            lastAppearance: 0,
          },
        ],
      });

      await splitPlanningPollution(dir);

      const intent = await readIntentTable(dir);
      expect(intent.characters).toHaveLength(1);
      const notes = intent.characters[0].notes ?? '';
      expect(notes).toContain('期望位置：北境');
      expect(notes).toContain('期望已知：密道位置');
      expect(notes).toContain('期望关系：苏晚=盟友');
      expect(intent.updatedAt).not.toBe('');
    });

    it('intent 累积：同名角色合并 notes，异名角色追加条目', async () => {
      // 预置一条既有 intent
      await writeIntentTable(dir, {
        characters: [{ name: '林青', expectedRole: '主角', notes: '弧线：由疑到信' }],
        updatedAt: '',
      });

      // 第一轮：林青 污染
      await updateStateTable(dir, {
        characters: [
          { name: '林青', location: '北境', emotion: '', knows: [], relationships: {}, lastAppearance: 0 },
        ],
      });
      await splitPlanningPollution(dir);

      // 第二轮：苏晚 污染
      await updateStateTable(dir, {
        characters: [
          { name: '林青', location: '', emotion: '', knows: [], relationships: {}, lastAppearance: 0 },
          { name: '苏晚', location: '临安', emotion: '不安', knows: [], relationships: {}, lastAppearance: 0 },
        ],
      });
      await splitPlanningPollution(dir);

      const intent = await readIntentTable(dir);
      expect(intent.characters.map((i) => i.name).sort()).toEqual(['林青', '苏晚']);
      const lin = intent.characters.find((i) => i.name === '林青')!;
      // 既有字段保留，notes 累积拼接
      expect(lin.expectedRole).toBe('主角');
      expect(lin.notes).toContain('弧线：由疑到信');
      expect(lin.notes).toContain('期望位置：北境');
      const su = intent.characters.find((i) => i.name === '苏晚')!;
      expect(su.notes).toContain('期望情绪：不安');
    });

    it('干净的 state 返回 null 且不产生 state-intent.json', async () => {
      await updateStateTable(dir, {
        characters: [
          // 已出场角色带字段：正常运行态，不是污染
          { name: '林青', location: '北境', emotion: '警惕', knows: [], relationships: {}, lastAppearance: 2 },
        ],
      });

      const result = await splitPlanningPollution(dir);

      expect(result).toBeNull();
      // 无写盘副作用
      await expect(fs.access(path.join(dir, '.novel', 'state-intent.json'))).rejects.toThrow();
      const s = await getStateTable(dir);
      expect(s.characters[0].location).toBe('北境');

      // state.json 不存在时同样返回 null
      const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'on-ctx-'));
      try {
        await expect(splitPlanningPollution(dir2)).resolves.toBeNull();
      } finally {
        await fs.rm(dir2, { recursive: true, force: true });
      }
    });
  });
});
