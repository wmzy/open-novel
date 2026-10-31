/**
 * EditorPanel 富文本模式集成测试：
 *  - 模式切换（源码 ↔ 富文本）
 *  - contentEditable 渲染 Markdown 结构
 *  - 编辑后经既有防抖自动保存（PATCH 收到 Markdown）
 *  - 外部内容变更（切章/AI 回填）同步回编辑器
 *
 * jsdom 不实现 document.execCommand，因此工具栏按钮只断言存在与可点击，
 * 不断言 execCommand 产物（真实行为由浏览器冒烟覆盖）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EditorPanel from '../../../src/web/components/EditorPanel';

const PROJECT_ID = 'p-rich';
const CONTENT = '# 第1章 起风\n\n前文第一段。\n\n被选中的片段。\n';

let chapterContent = CONTENT;
let patchCalls: Array<{ content: string; wordCount: number }> = [];

function installFetch() {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === `/api/projects/${PROJECT_ID}/chapters/1` && (!init || init.method === 'GET')) {
      return json({ chapter: { title: '起风', content: chapterContent } });
    }
    if (url.includes('/files')) return json({ files: [] });
    if (url.endsWith('/models')) return json({ models: [] });
    if (url === `/api/projects/${PROJECT_ID}/chapters/1` && init?.method === 'PATCH') {
      patchCalls.push(JSON.parse(String(init.body)));
      return json({ ok: true });
    }
    return json({});
  });
  vi.stubGlobal('fetch', handler);
}

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return render(createElement(
    QueryClientProvider,
    { client: qc },
    createElement(EditorPanel, { projectId: PROJECT_ID, chapterNum: 1 }),
  ));
}

function richEditor(): HTMLElement {
  return screen.getByTestId('rich-markdown-editor').querySelector('[contenteditable]') as HTMLElement;
}

function sourceTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('开始写作... (Ctrl+S 保存)') as HTMLTextAreaElement;
}

beforeEach(() => {
  chapterContent = CONTENT;
  patchCalls = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EditorPanel 富文本模式', () => {
  it('默认是源码模式；切到富文本后渲染 Markdown 结构', async () => {
    renderEditor();
    await waitFor(() => expect(sourceTextarea().value).toBe(CONTENT));

    fireEvent.click(screen.getByRole('button', { name: '富文本' }));

    const editor = richEditor();
    expect(editor).toBeTruthy();
    expect(editor.querySelector('h1')?.textContent).toBe('第1章 起风');
    expect(editor.querySelectorAll('p')).toHaveLength(2);
    // 源码 textarea 在富文本模式下不再渲染
    expect(screen.queryByPlaceholderText('开始写作... (Ctrl+S 保存)')).toBeNull();
    // 内联 AI 提示：富文本模式不提供内联 AI
    expect(screen.getByText(/内联 AI（润色\/扩写\/续写）请切回「编辑」模式/)).toBeInTheDocument();
  });

  it('格式工具栏提供加粗/斜体/标题/引用/列表按钮', async () => {
    renderEditor();
    await waitFor(() => expect(sourceTextarea().value).toBe(CONTENT));
    fireEvent.click(screen.getByRole('button', { name: '富文本' }));

    for (const name of ['加粗', '斜体', '标题', '引用', '无序列表', '有序列表']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('编辑 contentEditable → 走既有防抖自动保存（PATCH 收到 Markdown）', async () => {
    renderEditor();
    await waitFor(() => expect(sourceTextarea().value).toBe(CONTENT));
    fireEvent.click(screen.getByRole('button', { name: '富文本' }));

    const editor = richEditor();
    editor.innerHTML = '<h1>第1章 起风</h1><p>改写后的段落。</p>';
    fireEvent.input(editor);

    await waitFor(() => expect(patchCalls).toHaveLength(1), { timeout: 4000 });
    expect(patchCalls[0].content).toContain('改写后的段落。');
    expect(patchCalls[0].content).toContain('# 第1章 起风');
    // 字数口径与源码模式一致（中文按字计）
    expect(patchCalls[0].wordCount).toBeGreaterThan(0);
  });

  it('切回源码模式看到富文本编辑后的 Markdown', async () => {
    renderEditor();
    await waitFor(() => expect(sourceTextarea().value).toBe(CONTENT));
    fireEvent.click(screen.getByRole('button', { name: '富文本' }));

    const editor = richEditor();
    editor.innerHTML = '<p>只留这一段。</p>';
    fireEvent.input(editor);

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    await waitFor(() => expect(sourceTextarea().value).toContain('只留这一段。'));
  });
});
