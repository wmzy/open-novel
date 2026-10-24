import { describe, expect, it } from 'vitest';
import {
  countManuscriptChars,
  decodeManuscriptBytes,
  makePreviewText,
  splitManuscript,
} from '../../../src/shared/manuscript-splitter';

/** 生成一段足够长的中文正文（不含章节标题）。 */
function cjkText(chars: number): string {
  return '风起于青萍之末浪成于微澜之间'.repeat(Math.ceil(chars / 14)).slice(0, chars);
}

describe('splitManuscript', () => {
  it('识别中文「第N章/回/节」并连续重编号', () => {
    const text = [
      '书名：山河入梦',
      '作者：某某',
      '',
      '第一章 少年',
      '少年正文甲。',
      '',
      '第二十三章 重逢',
      '重逢正文乙。',
      '',
      '第105回 结局',
      '结局正文丙。',
    ].join('\n');

    const result = splitManuscript(text);

    expect(result.mode).toBe('headings');
    expect(result.chapters).toHaveLength(3);
    expect(result.chapters.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(result.chapters.map((c) => c.title)).toEqual(['少年', '重逢', '结局']);
    expect(result.chapters[0].heading).toBe('第一章 少年');
    expect(result.chapters[0].content).toContain('少年正文甲。');
    // 首个标题前的前言并入第 1 章，不额外生成章节
    expect(result.chapters[0].content).toContain('书名：山河入梦');
    expect(result.warnings.some((w) => w.includes('前言'))).toBe(true);
  });

  it('容忍中文数字（含百位）与全角数字', () => {
    const text = [
      '第一章 开端',
      '甲。',
      '第十二章 转折',
      '乙。',
      '第一百零五章 终局',
      '丙。',
      '第３章 插曲',
      '丁。',
    ].join('\n');

    const result = splitManuscript(text);
    expect(result.chapters.map((c) => c.title)).toEqual(['开端', '转折', '终局', '插曲']);
    expect(result.chapters.map((c) => c.number)).toEqual([1, 2, 3, 4]);
  });

  it('识别英文 Chapter N', () => {
    const text = [
      'Chapter 1: Dawn',
      'The first morning.',
      '',
      'Chapter 2: Dusk',
      'The last evening.',
    ].join('\n');

    const result = splitManuscript(text);
    expect(result.mode).toBe('headings');
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters.map((c) => c.title)).toEqual(['Dawn', 'Dusk']);
  });

  it('同篇混用中英文章节标记', () => {
    const text = [
      '第一章 起',
      '甲。',
      '',
      'Chapter 2: Middle',
      '乙。',
      '',
      '第3节 终',
      '丙。',
    ].join('\n');
    const result = splitManuscript(text);
    expect(result.mode).toBe('headings');
    expect(result.chapters.map((c) => c.title)).toEqual(['起', 'Middle', '终']);
  });

  it('无强章节标记时按 Markdown # 标题切分', () => {
    const text = ['# 风起', '正文一。', '', '## 小节', '小节内容。', '', '# 云涌', '正文二。'].join('\n');

    const result = splitManuscript(text);
    expect(result.mode).toBe('markdown');
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters.map((c) => c.title)).toEqual(['风起', '云涌']);
    // 二级标题保留在第 1 章正文里
    expect(result.chapters[0].content).toContain('## 小节');
  });

  it('仅有 ## 标题时按二级标题切分', () => {
    const text = ['## 第一折', '甲。', '', '## 第二折', '乙。'].join('\n');
    const result = splitManuscript(text);
    expect(result.mode).toBe('markdown');
    expect(result.chapters.map((c) => c.title)).toEqual(['第一折', '第二折']);
  });

  it('识别数字标题（1. / 2、），并归一化标题', () => {
    const text = ['1. 开端', '甲。', '', '2、发展', '乙。'].join('\n');
    const result = splitManuscript(text);
    expect(result.mode).toBe('numeric');
    expect(result.chapters.map((c) => c.title)).toEqual(['开端', '发展']);
  });

  it('无标题时降级为固定大小切分并给出 warning', () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `${cjkText(300)}（段落${i}）`);
    const text = paragraphs.join('\n\n');

    const result = splitManuscript(text, { fallbackChunkChars: 1500 });

    expect(result.mode).toBe('fixed');
    expect(result.chapters.length).toBeGreaterThan(1);
    expect(result.warnings.some((w) => w.includes('未识别到章节标题'))).toBe(true);
    expect(result.chapters.every((c) => c.content.length > 0)).toBe(true);
    expect(result.chapters.map((c) => c.number)).toEqual(
      result.chapters.map((_, i) => i + 1),
    );
    // 内容不丢失：所有段落编号都应出现
    const joined = result.chapters.map((c) => c.content).join('\n');
    expect(joined).toContain('（段落0）');
    expect(joined).toContain('（段落29）');
  });

  it('正文中提及「第一章」但不在行首时不误判', () => {
    const text = `他翻开书，看到第一章标题时愣了一下。${cjkText(7000)}`;
    const result = splitManuscript(text);
    expect(result.mode).toBe('fixed');
    expect(result.chapters.length).toBeGreaterThanOrEqual(1);
  });

  it('丢弃只有标题没有正文的空章节并提示', () => {
    const text = ['第一章 空章', '', '第二章 有内容', '正文。'].join('\n');
    const result = splitManuscript(text);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0].title).toBe('有内容');
    expect(result.warnings.some((w) => w.includes('只有标题'))).toBe(true);
  });

  it('预览包含标题、字数与前 80 字', () => {
    const body = `第一章 少年\n${cjkText(200)}`;
    const result = splitManuscript(body);
    const preview = result.preview[0];
    expect(preview.number).toBe(1);
    expect(preview.title).toBe('少年');
    expect(preview.charCount).toBe(200);
    expect(preview.preview.length).toBeLessThanOrEqual(80);
    expect(preview.preview.startsWith('风起于青萍之末')).toBe(true);
  });

  it('章节标题过多时降级为固定切分，避免生成海量章节', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) {
      lines.push(`第${i}章 标题${i}`, '正文。');
    }
    const result = splitManuscript(lines.join('\n'), { maxChapters: 10 });
    expect(result.chapters.length).toBeLessThanOrEqual(10);
    expect(result.warnings.some((w) => w.includes('超过上限'))).toBe(true);
  });

  it('拒绝空书稿', () => {
    expect(() => splitManuscript('   \n\n  ')).toThrow('书稿内容为空');
  });
});

describe('decodeManuscriptBytes', () => {
  it('去除 UTF-8 BOM', () => {
    const text = '第一章 你好\n正文。';
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text, 'utf-8')]);
    const decoded = decodeManuscriptBytes(bytes);
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.text.startsWith('第一章')).toBe(true);
    expect(decoded.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('GBK 书稿回退 GB18030 且不乱码', () => {
    // 「第一章 你好\n这是正文。\n第二章 再见\n结束。」的 GBK 字节
    const bytes = new Uint8Array([
      181, 218, 210, 187, 213, 194, 32, 196, 227, 186, 195, 10,
      213, 226, 202, 199, 213, 253, 206, 196, 161, 163, 10,
      181, 218, 182, 254, 213, 194, 32, 212, 217, 188, 251, 10,
      189, 225, 202, 248, 161, 163,
    ]);
    const decoded = decodeManuscriptBytes(bytes);
    expect(decoded.encoding).toBe('gb18030');
    expect(decoded.text).toContain('第一章 你好');
    expect(decoded.text).toContain('结束。');
    expect(decoded.warning).toContain('GB18030');
  });
});

describe('countManuscriptChars / makePreviewText', () => {
  it('中文按 CJK 字符计数，忽略 markdown 标记', () => {
    expect(countManuscriptChars('# 标题\n**正文**一二三')).toBe(2 + 5);
  });

  it('纯英文按空白分词计数', () => {
    expect(countManuscriptChars('Hello brave new world.')).toBe(4);
  });

  it('预览折叠空白并截断', () => {
    const text = `${'甲'.repeat(50)}\n\n${'乙'.repeat(50)}`;
    const preview = makePreviewText(text);
    expect(preview).toHaveLength(80);
    expect(preview.includes('\n')).toBe(false);
  });
});
