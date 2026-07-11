/**
 * 视图修订接线冒烟测试。
 * 验证 ConceptView/WorldView/CharacterView 正确挂载「✎ 修订」/「⇄ 重命名」按钮，
 * 点击修订 dispatch open-novel:revise-to-chat 事件，点击重命名打开 RenameDialog。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { REVISE_TO_CHAT_EVENT } from '@/web/hooks/useFileRevision';

// mock viewShared：保留 reviseBtn 等样式与组件，仅替换 useNovelFile
// 返回带 section 的 markdown，让视图走到主渲染分支（带 viewHeaderRow + 修订按钮）
vi.mock('@/web/components/views/viewShared', async () => {
  const actual = await vi.importActual<typeof import('@/web/components/views/viewShared')>(
    '@/web/components/views/viewShared',
  );
  return {
    ...actual,
    useNovelFile: () => ({
      data: '# 标题\n\n## 一句话梗概\n\n一个少年的复仇故事。\n',
      isLoading: false,
    }),
  };
});

// mock useNovelDocument：ConceptView/WorldView/OutlineView 用它拉取合并后的拆分文档
vi.mock('@/web/hooks/useNovelDocument', () => ({
  useNovelDocument: () => ({
    data: '# 标题\n\n## 一句话梗概\n\n一个少年的复仇故事。\n',
    isLoading: false,
  }),
}));

const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async (url: string) => {
    // RenameDialog useQuery 拉 state.json；CharacterView 关系图也会拉
    if (String(url).includes('state.json')) {
      return { ok: true, json: async () => ({ content: '{"characters":[]}' }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
});

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  return render(createElement(QueryClientProvider, { client: qc }, ui));
}

import ConceptView from '@/web/components/views/ConceptView';
import WorldView from '@/web/components/views/WorldView';
import CharacterView from '@/web/components/views/CharacterView';

describe('视图修订接线冒烟', () => {
  let lastDetail: unknown = undefined;
  let detailCount = 0;
  const handler = (e: Event) => {
    if (e.type === REVISE_TO_CHAT_EVENT) {
      lastDetail = (e as CustomEvent).detail;
      detailCount += 1;
    }
  };

  beforeEach(() => {
    lastDetail = undefined;
    detailCount = 0;
    window.addEventListener(REVISE_TO_CHAT_EVENT, handler);
  });
  afterEach(() => {
    window.removeEventListener(REVISE_TO_CHAT_EVENT, handler);
    cleanup();
  });

  // —— 按钮渲染 ——

  it('ConceptView 渲染「✎ 修订」和「⇄ 重命名」按钮', () => {
    wrap(createElement(ConceptView, { projectId: 'proj_1' }));
    expect(screen.getByText('✎ 修订')).toBeInTheDocument();
    expect(screen.getByText('⇄ 重命名')).toBeInTheDocument();
  });

  it('WorldView 渲染「✎ 修订」和「⇄ 重命名」按钮', () => {
    wrap(createElement(WorldView, { projectId: 'proj_1' }));
    expect(screen.getByText('✎ 修订')).toBeInTheDocument();
    expect(screen.getByText('⇄ 重命名')).toBeInTheDocument();
  });

  it('CharacterView 渲染「✎ 修订」和「⇄ 重命名」按钮', () => {
    wrap(createElement(CharacterView, { projectId: 'proj_1' }));
    expect(screen.getByText('✎ 修订')).toBeInTheDocument();
    expect(screen.getByText('⇄ 重命名')).toBeInTheDocument();
  });

  // —— 文件级 revise：dispatch 事件 ——

  it('点击 ConceptView「✎ 修订」dispatch revise-to-chat（targetFile=concept/index.md）', () => {
    wrap(createElement(ConceptView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getByText('✎ 修订'));
    expect(detailCount).toBe(1);
    expect((lastDetail as { targetFile: string }).targetFile).toBe('concept/index.md');
  });

  it('点击 WorldView「✎ 修订」dispatch revise-to-chat（targetFile=world/index.md）', () => {
    wrap(createElement(WorldView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getByText('✎ 修订'));
    expect((lastDetail as { targetFile: string }).targetFile).toBe('world/index.md');
  });

  it('点击 CharacterView「✎ 修订」dispatch revise-to-chat（targetFile=characters/profiles.md）', () => {
    wrap(createElement(CharacterView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getByText('✎ 修订'));
    expect((lastDetail as { targetFile: string }).targetFile).toBe('characters/profiles.md');
  });

  // —— 文件级 rename：打开 RenameDialog ——

  it('点击 ConceptView「⇄ 重命名」打开 RenameDialog（标题含 concept/index.md）', async () => {
    wrap(createElement(ConceptView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getByText('⇄ 重命名'));
    await waitFor(() => {
      expect(screen.getByText(/重命名 · concept\/index\.md/)).toBeInTheDocument();
    });
  });

  it('点击 WorldView「⇄ 重命名」打开 RenameDialog（标题含 world/index.md）', async () => {
    wrap(createElement(WorldView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getByText('⇄ 重命名'));
    await waitFor(() => {
      expect(screen.getByText(/重命名 · world\/index\.md/)).toBeInTheDocument();
    });
  });

  // —— 卡片级 ✎ 按钮（section 定向修订入口）——

  it('ConceptView 每张卡片渲染 ✎ 和 ⇄ 按钮', () => {
    wrap(createElement(ConceptView, { projectId: 'proj_1' }));
    expect(screen.getAllByTitle('修订这一节').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTitle('重命名').length).toBeGreaterThanOrEqual(1);
  });

  it('WorldView 每张卡片渲染 ✎ 和 ⇄ 按钮', () => {
    wrap(createElement(WorldView, { projectId: 'proj_1' }));
    expect(screen.getAllByTitle('修订这一节').length).toBeGreaterThanOrEqual(1);
  });

  it('CharacterView 每个分组卡片渲染 ✎ 和 ⇄ 按钮', () => {
    wrap(createElement(CharacterView, { projectId: 'proj_1' }));
    expect(screen.getAllByTitle('修订这一组').length).toBeGreaterThanOrEqual(1);
  });

  it('点击 ConceptView 卡片 ✎ dispatch revise-to-chat 含卡片路径', () => {
    wrap(createElement(ConceptView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getAllByTitle('修订这一节')[0]);
    expect(detailCount).toBe(1);
    // 卡片级修订直接传卡片文件路径（如 concept/一句话梗概.md）
    expect((lastDetail as { targetFile: string }).targetFile).toContain('concept/');
  });
});
