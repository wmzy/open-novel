/**
 * Markdown ⇄ contentEditable HTML 转换测试：
 * 渲染结构、往返稳定性、中文/场景分隔线保持、HTML/XSS 清洗。
 */
import { describe, it, expect } from 'vitest';
import {
  editorHtmlToMarkdown,
  markdownToEditorHtml,
  sanitizeEditorHtml,
} from '../../../src/shared/rich-markdown';

describe('markdownToEditorHtml', () => {
  it('渲染标题、段落、粗体、斜体', () => {
    const html = markdownToEditorHtml('# 第一章 起风\n\n段落有**粗体**和*斜体*。');
    expect(html).toContain('<h1>第一章 起风</h1>');
    expect(html).toContain('<p>段落有<strong>粗体</strong>和<em>斜体</em>。</p>');
  });

  it('渲染引用、无序列表、有序列表与分隔线', () => {
    const html = markdownToEditorHtml('> 引用一句。\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n***');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>甲</li>');
    expect(html).toContain('<hr>');
  });

  it('空输入得到空串，而不是空段落', () => {
    expect(markdownToEditorHtml('')).toBe('');
    expect(markdownToEditorHtml('   \n\n')).toBe('');
  });

  it('丢弃原始 HTML：script 与带 onerror 的 img 都不进入 DOM', () => {
    const html = markdownToEditorHtml(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n安全段落',
    );
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert');
    expect(html).not.toContain('<img');
    expect(html).toContain('<p>安全段落</p>');
  });

  it('拒绝 javascript: / data: 链接，安全链接保留 href', () => {
    const unsafe = markdownToEditorHtml('[点我](javascript:alert(1))');
    expect(unsafe).not.toContain('href');
    expect(unsafe).not.toContain('javascript');

    const data = sanitizeEditorHtml('<p><a href="data:text/html,alert(1)">数据</a></p>');
    expect(data).toBe('<p>数据</p>');

    const safe = markdownToEditorHtml('[正常](https://example.com)');
    expect(safe).toContain('<a href="https://example.com">正常</a>');
  });

  it('清洗属性：只保留 a[href] 与 ol[start]', () => {
    const html = sanitizeEditorHtml(
      '<p onclick="alert(1)" class="x">正文<a href="https://e.com" target="_blank" onclick="x">链接</a></p><ol start="3" type="A"><li>丙</li></ol>',
    );
    expect(html).toBe('<p>正文<a href="https://e.com">链接</a></p><ol start="3"><li>丙</li></ol>');
  });

  it('规范化浏览器产生的标签与内联样式', () => {
    expect(sanitizeEditorHtml('<p><b>粗</b><i>斜</i><s>删</s></p>')).toBe(
      '<p><strong>粗</strong><em>斜</em><del>删</del></p>',
    );
    expect(sanitizeEditorHtml('<p><span style="font-weight: bold;">粗</span></p>')).toBe(
      '<p><strong>粗</strong></p>',
    );
    expect(sanitizeEditorHtml('<div>第一行</div><div><br></div><div>第二行</div>')).toBe(
      '<p>第一行</p><p>第二行</p>',
    );
  });
});

describe('editorHtmlToMarkdown', () => {
  it('标题/段落/粗体/斜体往返稳定', () => {
    const md = '# 第一章 起风\n\n段落有**粗体**和*斜体*。';
    expect(editorHtmlToMarkdown(markdownToEditorHtml(md))).toBe(md);
  });

  it('引用与列表往返稳定（- 项目符号、1. 序号）', () => {
    const md = '> 引用一句。\n\n- 甲\n- 乙\n\n1. 一\n2. 二';
    expect(editorHtmlToMarkdown(markdownToEditorHtml(md))).toBe(md);
  });

  it('中文散文语义不变（引号、全角标点、段落）', () => {
    const md = '夜色压下来，风从窗缝里钻进来。\n\n「你来了。」他说。\n\n她没有回头。';
    expect(editorHtmlToMarkdown(markdownToEditorHtml(md))).toBe(md);
  });

  it('场景分隔线 *** / --- 不会被当成正文转义', () => {
    expect(editorHtmlToMarkdown(markdownToEditorHtml('***'))).toBe('***');
    expect(editorHtmlToMarkdown(markdownToEditorHtml('---'))).toBe('***');
    const md = '上半场结束。\n\n***\n\n下半场开始。';
    expect(editorHtmlToMarkdown(markdownToEditorHtml(md))).toBe(md);
  });

  it('清理 CRLF、多余空行与行尾空白', () => {
    expect(editorHtmlToMarkdown('<p>第一段</p>\r\n<p>第二段</p>')).toBe('第一段\n\n第二段');
    expect(editorHtmlToMarkdown('<p>第一段</p><p><br></p><p><br></p><p>第二段</p>')).toBe(
      '第一段\n\n第二段',
    );
  });

  it('常见章节 Markdown 往返幂等', () => {
    const md = [
      '# 第7章 夜行',
      '',
      '风从山口灌下来，带着**湿冷的土腥气**。',
      '',
      '> 「别回头。」她压低声音。',
      '',
      '## 一',
      '',
      '- 火折子',
      '- 干粮',
      '',
      '1. 灭灯',
      '2. 关门',
      '',
      '***',
      '',
      '他们走进黑暗里。',
    ].join('\n');

    const first = markdownToEditorHtml(md);
    const back = editorHtmlToMarkdown(first);
    expect(back).toBe(md);
    expect(markdownToEditorHtml(back)).toBe(first);
  });

  it('空 HTML / 仅空行 HTML 得到空串', () => {
    expect(editorHtmlToMarkdown('')).toBe('');
    expect(editorHtmlToMarkdown('<p><br></p>')).toBe('');
    expect(editorHtmlToMarkdown('<br>')).toBe('');
  });
});
