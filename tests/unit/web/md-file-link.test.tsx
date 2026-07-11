import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isValidElement, createElement } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import {
  isMarkdownRef,
  normalizeMdPath,
  extractText,
  MarkdownFileDialog,
} from '../../../src/web/components/MarkdownFileDialog';

describe('isMarkdownRef', () => {
  it('识别项目内 .md 文件引用', () => {
    expect(isMarkdownRef('world-building.md')).toBe(true);
    expect(isMarkdownRef('./characters/profiles.md')).toBe(true);
    expect(isMarkdownRef('outline-detailed.md#大纲')).toBe(true);
    expect(isMarkdownRef('scenes.md?v=2')).toBe(true);
    expect(isMarkdownRef('sub/dir/file.MD')).toBe(true);
  });

  it('排除外部协议与锚点', () => {
    expect(isMarkdownRef('https://example.com/a.md')).toBe(false);
    expect(isMarkdownRef('http://example.com/a.md')).toBe(false);
    expect(isMarkdownRef('mailto:a@b.com')).toBe(false);
    expect(isMarkdownRef('#section')).toBe(false);
    expect(isMarkdownRef('data:text/plain,hi')).toBe(false);
  });

  it('排除非 md 文件', () => {
    expect(isMarkdownRef('chapter.txt')).toBe(false);
    expect(isMarkdownRef('image.png')).toBe(false);
    expect(isMarkdownRef('')).toBe(false);
    expect(isMarkdownRef('readme')).toBe(false);
  });
});

describe('normalizeMdPath', () => {
  it('去掉前导 ./', () => {
    expect(normalizeMdPath('./world-building.md')).toBe('world-building.md');
    expect(normalizeMdPath('./a/b.md')).toBe('a/b.md');
  });

  it('去掉查询串和锚点', () => {
    expect(normalizeMdPath('a.md#heading')).toBe('a.md');
    expect(normalizeMdPath('a.md?q=1')).toBe('a.md');
  });

  it('无 ./ / 查询 / 锚点时原样返回', () => {
    expect(normalizeMdPath('characters/profiles.md')).toBe('characters/profiles.md');
  });
});

describe('extractText', () => {
  it('字符串直接返回', () => {
    expect(extractText('hello')).toBe('hello');
  });

  it('数组拼接', () => {
    expect(extractText(['a', 'b'])).toBe('ab');
  });

  it('React 元素递归提取 children', () => {
    const el = createElement('span', null, '内层文字');
    expect(extractText(el)).toBe('内层文字');
  });

  it('嵌套数组与元素混合', () => {
    const el = createElement('strong', null, '加粗');
    expect(extractText(['前', el, '后'])).toBe('前加粗后');
  });

  it('null/boolean/number 处理', () => {
    expect(extractText(null)).toBe('');
    expect(extractText(false)).toBe('');
    expect(extractText(42)).toBe('42');
  });

  it('无效元素兜底空串', () => {
    expect(extractText({} as never)).toBe('');
    expect(isValidElement({})).toBe(false);
  });
});

describe('MarkdownFileDialog 组件', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载后 fetch 文件内容并渲染 Markdown', async () => {
    const md = '# 世界观\n\n这是一个剑与魔法的世界。';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ path: 'world-building.md', content: md })),
    );

    render(
      <MarkdownFileDialog
        projectId="proj_1"
        filePath="world-building.md"
        title="世界观"
        onClose={vi.fn()}
      />,
    );

    // 先出现加载态
    expect(screen.getByText('加载中…')).toBeTruthy();
    // fetch 的内容被渲染为 h1
    expect(await screen.findByText('世界观')).toBeTruthy();
    expect(screen.getByText('这是一个剑与魔法的世界。')).toBeTruthy();
  });

  it('fetch 返回 error 时展示错误信息', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'File not found' })),
    );

    render(
      <MarkdownFileDialog
        projectId="proj_1"
        filePath="missing.md"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('File not found')).toBeTruthy();
  });

  it('Esc 键触发 onClose', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: '' })),
    );
    const onClose = vi.fn();

    render(
      <MarkdownFileDialog
        projectId="proj_1"
        filePath="empty.md"
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(screen.getByText('空文件')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点击弹窗内 .md 链接在同一弹窗内导航', async () => {
    // 第一份文件内容里引用了另一个 .md
    const first = '详见 [详细大纲](outline-detailed.md)';
    const second = '# 详细大纲\n\n三幕结构';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: first })),
    );

    render(
      <MarkdownFileDialog
        projectId="proj_1"
        filePath="concept.md"
        title="概念"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('详细大纲')).toBeTruthy();

    // 第二次 fetch 返回 outline-detailed.md 的内容
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ content: second })),
    );

    fireEvent.click(screen.getByText('详细大纲'));

    expect(await screen.findByText('三幕结构')).toBeTruthy();
    // 确认弹窗没有关闭（仍是单个弹窗）
    expect(document.querySelectorAll('[role=dialog]')).toHaveLength(1);
  });
});
