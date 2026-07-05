/**
 * 视图修订接线冒烟测试。
 * 验证 ConceptView/WorldView/CharacterView 正确挂载了「✎ 修订」按钮，
 * 且点击后能打开 RevisionDialog（标题含目标文件）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';

// mock useAgentSelection（useFileRevision 依赖）
vi.mock('@/web/hooks/useAgents', () => ({
  useAgentSelection: () => ['agent_x', vi.fn()],
}));

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

const fetchSpy = vi.fn();
globalThis.fetch = fetchSpy as unknown as typeof fetch;

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async (url: string) => {
    // RevisionDialog rename 模式 / CharacterView 关系图会拉 state.json
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
  it('ConceptView 渲染「✎ 修订」按钮', () => {
    wrap(createElement(ConceptView, { projectId: 'proj_1' }));
    expect(screen.getByText('✎ 修订')).toBeInTheDocument();
    cleanup();
  });

  it('WorldView 渲染「✎ 修订」按钮', () => {
    wrap(createElement(WorldView, { projectId: 'proj_1' }));
    expect(screen.getByText('✎ 修订')).toBeInTheDocument();
    cleanup();
  });

  it('CharacterView 渲染「✎ 修订」按钮', () => {
    wrap(createElement(CharacterView, { projectId: 'proj_1' }));
    expect(screen.getByText('✎ 修订')).toBeInTheDocument();
    cleanup();
  });

  it('点击 ConceptView「✎ 修订」打开 RevisionDialog（标题含 concept.md）', async () => {
    wrap(createElement(ConceptView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getByText('✎ 修订'));
    await waitFor(() => {
      expect(screen.getByText(/修订 · concept\.md/)).toBeInTheDocument();
    });
    cleanup();
  });

  it('点击 WorldView「✎ 修订」打开 RevisionDialog（标题含 world-building.md）', async () => {
    wrap(createElement(WorldView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getByText('✎ 修订'));
    await waitFor(() => {
      expect(screen.getByText(/修订 · world-building\.md/)).toBeInTheDocument();
    });
    cleanup();
  });

  it('点击 CharacterView「✎ 修订」打开 RevisionDialog（标题含 characters/profiles.md）', async () => {
    wrap(createElement(CharacterView, { projectId: 'proj_1' }));
    fireEvent.click(screen.getByText('✎ 修订'));
    await waitFor(() => {
      expect(screen.getByText(/修订 · characters\/profiles\.md/)).toBeInTheDocument();
    });
    cleanup();
  });
});
