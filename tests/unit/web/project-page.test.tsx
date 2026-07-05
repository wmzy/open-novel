/**
 * ProjectPage 加载状态测试。
 *
 * 来源：修一个 UX bug——当项目 id 不存在（API 返回 404）时，旧代码把
 * `{ error: 'Not found' }` 当成成功返回 `undefined`，导致页面永远显示
 * 「加载中...」。修复后 queryFn 检查 res.ok，404 进入 error 态并渲染
 * 「项目不存在」。
 *
 * 归并建议：未来若有更多 ProjectPage 测试（侧边栏联动、SSE 失效等），
 * 直接追加到本文件的现有 describe 内。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// ProjectPage 依赖大量子组件与 lazy chunk；这里全量 mock，只保留页面自身的
// 加载状态分支逻辑——这正是本次修复的目标。
vi.mock('@/web/components/Sidebar', () => ({ default: () => <div data-testid="sidebar" /> }));
vi.mock('@/web/components/WorkflowProgress', () => ({ default: () => null }));
vi.mock('@/web/components/ChatPanel', () => ({ default: () => null }));
vi.mock('@/web/components/EditorPanel', () => ({ default: () => null }));
vi.mock('@/web/components/RewritePanel', () => ({ default: () => null }));
vi.mock('@/web/components/QualityCheckPanel', () => ({ default: () => null }));
vi.mock('@/web/components/FilePreview', () => ({ default: () => null }));
vi.mock('@/web/hooks/useFilePreview', () => ({
  useFilePreview: () => ({ readFile: vi.fn(), loading: false }),
}));
vi.mock('@/web/hooks/useAgents', () => ({
  useAgentSelection: () => ['agent_x', vi.fn()],
}));
vi.mock('@/web/hooks/useChatPanelWidth', () => ({
  useChatPanelWidth: () => ({ width: 400, isResizing: false, resizeHandleProps: {} }),
}));
// 视图组件无需渲染——404 分支不会走到 ViewRouter。
vi.mock('@/web/components/views/DashboardView', () => ({ default: () => null }));
vi.mock('@/web/components/views/ConceptView', () => ({ default: () => null }));
vi.mock('@/web/components/views/WorldView', () => ({ default: () => null }));
vi.mock('@/web/components/views/CharacterView', () => ({ default: () => null }));
vi.mock('@/web/components/views/OutlineView', () => ({ default: () => null }));
vi.mock('@/web/components/views/SceneView', () => ({ default: () => null }));
vi.mock('@/web/components/views/ForeshadowView', () => ({ default: () => null }));
vi.mock('@/web/components/views/StoryArcView', () => ({ default: () => null }));
vi.mock('@/web/components/views/CharacterGraphView', () => ({ default: () => null }));
vi.mock('@/web/components/views/WuxiaView', () => ({ default: () => null }));
vi.mock('@/web/components/views/WritingView', () => ({ default: () => null }));
// sonner 的 toast 在模块顶层即被调用，需 mock 掉。
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import ProjectPage from '../../../src/web/pages/ProjectPage';

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<div data-testid="home" />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function wrap(children: ReactNode) {
  return children;
}
void wrap; // 占位，避免 lint 抱怨未使用导入

describe('ProjectPage 项目加载状态', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom 未实现 EventSource；ProjectPage 的 SSE useEffect 会 new EventSource，
    // 在所有用例里统一 stub 成空操作对象。
    vi.stubGlobal('EventSource', class {
      addEventListener() {}
      close() {}
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('项目不存在（404）时显示「项目不存在」而非无限加载', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    );

    renderAt('/projects/proj_does_not_exist');

    // 旧 bug：这里会永远停留在「加载中...」
    expect(await screen.findByText('项目不存在')).toBeTruthy();
    expect(screen.queryByText('加载中...')).toBeNull();
    // 给出返回首页的出口
    expect(screen.getByText('← 返回首页')).toBeTruthy();
    // 404 不应出现「重试」按钮（重试无意义）
    expect(screen.queryByText('重试')).toBeNull();

    expect(fetchMock).toHaveBeenCalled();
  });

  it('服务器错误（5xx）时显示「加载失败」并提供重试', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    renderAt('/projects/proj_any');

    expect(await screen.findByText('加载失败', {}, { timeout: 5000 })).toBeTruthy();
    // 5xx 应提供重试按钮
    expect(screen.getByText('重试')).toBeTruthy();
    expect(screen.getByText('← 返回首页')).toBeTruthy();
  });

  it('项目存在时进入正常渲染（不出现错误态）', async () => {
    const project = {
      id: 'proj_ok',
      title: '测试小说',
      path: '/tmp/x',
      genre: 'wuxia',
      currentStage: 'concept',
      skillId: 'wuxia',
    };
    // GET /api/projects/:id 返回项目；GET /api/projects/:id/chapters 返回空数组。
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input));
      if (url.includes('/chapters')) {
        return new Response(JSON.stringify({ chapters: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ project }), { status: 200 });
    });

    renderAt('/projects/proj_ok');

    // 项目存在 → 正常渲染 Sidebar（mock），不出现错误/加载态。
    const sidebar = await screen.findByTestId('sidebar', {}, { timeout: 2000 });
    expect(sidebar).toBeTruthy();
    expect(screen.queryByText('项目不存在')).toBeNull();
    expect(screen.queryByText('加载失败')).toBeNull();
  });
});
