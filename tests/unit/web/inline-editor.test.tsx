/**
 * EditorPanel 内联 AI 工具条集成测试：选区感知、diff 预览、应用/放弃。
 * 全量 stub fetch（章节正文 / 文件列表 / 模型列表 / inline 端点 / PATCH 保存）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EditorPanel from '../../../src/web/components/EditorPanel';

const PROJECT_ID = 'p1';
const CONTENT = '# 第1章 起风\n\n前文第一段。\n\n被选中的片段。\n\n后文第一段。\n';
const SEL_START = CONTENT.indexOf('被选中的片段。');
const SEL = '被选中的片段。';

const POLISH_REPLY = {
  result: '润色后的片段。',
  plan: { whole: null, replaced: [{ index: 0, from: SEL, to: '润色后的片段。' }], appended: [] },
};
const CONTINUE_REPLY = {
  result: '续写段。',
  plan: { whole: null, replaced: [], appended: ['续写段。'] },
};

let inlineCalls: Array<Record<string, unknown>> = [];
let patchCalls: Array<Record<string, unknown>> = [];
let inlineReply: unknown = POLISH_REPLY;
let inlineStatus = 200;

function installFetch() {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url === `/api/projects/${PROJECT_ID}/chapters/1` && (!init || init.method === 'GET')) {
      return json({ chapter: { title: '起风', content: CONTENT } });
    }
    if (url.includes('/files')) return json({ files: [] });
    if (url.endsWith('/models')) return json({ models: [] });
    if (url === `/api/projects/${PROJECT_ID}/inline` && init?.method === 'POST') {
      inlineCalls.push(JSON.parse(String(init.body)));
      return json(inlineReply, inlineStatus);
    }
    if (url === `/api/projects/${PROJECT_ID}/chapters/1` && init?.method === 'PATCH') {
      patchCalls.push(JSON.parse(String(init.body)));
      return json({ ok: true });
    }
    return json({});
  });
  vi.stubGlobal('fetch', handler);
  return handler;
}

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return render(createElement(
    QueryClientProvider,
    { client: qc },
    createElement(EditorPanel, { projectId: PROJECT_ID, chapterNum: 1 }),
  ));
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText('开始写作... (Ctrl+S 保存)') as HTMLTextAreaElement;
}

function selectRange(start: number, end: number) {
  const ta = textarea();
  ta.setSelectionRange(start, end);
  fireEvent.select(ta);
}

beforeEach(() => {
  inlineCalls = [];
  patchCalls = [];
  inlineReply = POLISH_REPLY;
  inlineStatus = 200;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('EditorPanel 内联 AI 工具条', () => {
  it('无选区时只显示提示，不显示润色/扩写/续写', async () => {
    renderEditor();
    await waitFor(() => expect(textarea().value).toBe(CONTENT));
    expect(screen.queryByRole('button', { name: '润色' })).toBeNull();
    expect(screen.queryByRole('button', { name: '扩写' })).toBeNull();
    expect(screen.queryByRole('button', { name: '续写' })).toBeNull();
    expect(screen.getByText('选中文本可润色/扩写；光标移到文末可续写')).toBeInTheDocument();
  });

  it('润色全流程：选区出按钮 → 调端点 → diff 预览 → 应用写入并触发保存', async () => {
    renderEditor();
    await waitFor(() => expect(textarea().value).toBe(CONTENT));

    selectRange(SEL_START, SEL_START + SEL.length);
    expect(screen.getByRole('button', { name: '润色' })).toBeInTheDocument();
    // 有选区时不显示续写
    expect(screen.queryByRole('button', { name: '续写' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '润色' }));
    await waitFor(() => expect(screen.getByTestId('inline-preview')).toBeInTheDocument());
    // 预览呈现段落前后对照（原文删除线 + 新段落）
    expect(screen.getByText(SEL)).toBeInTheDocument();
    expect(screen.getByText('润色后的片段。')).toBeInTheDocument();
    // 预览期间正文未被覆盖，textarea 隐藏
    expect(screen.queryByPlaceholderText('开始写作... (Ctrl+S 保存)')).toBeNull();

    // 请求体带选区与偏移
    expect(inlineCalls).toHaveLength(1);
    expect(inlineCalls[0]).toMatchObject({ chapter: 1, action: 'polish', selection: SEL, selectionStart: SEL_START });

    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    // 应用后回到编辑态，选区文本被替换，其余正文原样保留
    await waitFor(() => expect(textarea().value).toBe(CONTENT.replace(SEL, '润色后的片段。')));
    expect(screen.queryByTestId('inline-preview')).toBeNull();
    // 走既有防抖保存（1s）→ PATCH
    await waitFor(() => expect(patchCalls).toHaveLength(1), { timeout: 4000 });
    expect(patchCalls[0].content).toBe(CONTENT.replace(SEL, '润色后的片段。'));
  });

  it('放弃：预览丢弃，正文不变、不保存', async () => {
    renderEditor();
    await waitFor(() => expect(textarea().value).toBe(CONTENT));
    selectRange(SEL_START, SEL_START + SEL.length);
    fireEvent.click(screen.getByRole('button', { name: '扩写' }));
    await waitFor(() => expect(screen.getByTestId('inline-preview')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '放弃' }));
    await waitFor(() => expect(textarea().value).toBe(CONTENT));
    await new Promise((r) => setTimeout(r, 1300));
    expect(patchCalls).toHaveLength(0);
  });

  it('光标在文末显示续写；应用后追加到正文末尾', async () => {
    inlineReply = CONTINUE_REPLY;
    renderEditor();
    await waitFor(() => expect(textarea().value).toBe(CONTENT));
    selectRange(CONTENT.length, CONTENT.length);
    expect(screen.getByRole('button', { name: '续写' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '润色' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '续写' }));
    await waitFor(() => expect(screen.getByTestId('inline-preview')).toBeInTheDocument());
    expect(inlineCalls[0]).toMatchObject({ chapter: 1, action: 'continue', selectionStart: CONTENT.length });

    fireEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(textarea().value.endsWith('后文第一段。\n\n续写段。')).toBe(true));
  });

  it('端点失败 → inline 错误提示，正文不变', async () => {
    inlineStatus = 500;
    inlineReply = { error: '内联润色调用失败：超时' };
    renderEditor();
    await waitFor(() => expect(textarea().value).toBe(CONTENT));
    selectRange(SEL_START, SEL_START + SEL.length);
    fireEvent.click(screen.getByRole('button', { name: '润色' }));
    await waitFor(() => expect(screen.getByText('内联润色调用失败：超时')).toBeInTheDocument());
    expect(textarea().value).toBe(CONTENT);
    expect(screen.queryByTestId('inline-preview')).toBeNull();
  });
});
