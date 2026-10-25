import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import ReviewPanel from '../../../src/web/components/ReviewPanel';
import type { ReviewResult } from '../../../src/web/hooks/useReview';

const emptyReview: ReviewResult = { commits: [], files: [], totalAdded: 0, totalRemoved: 0 };
const sampleReview: ReviewResult = {
  commits: [{ hash: 'abc1234', message: '[auto] 写第一章', date: '2026-07-27T00:00:00+08:00' }],
  files: [
    { path: 'chapters/第1章.md', status: 'added', addedLines: 5, removedLines: 0, diff: '+第一章内容\n' },
    { path: 'concept.md', status: 'modified', addedLines: 2, removedLines: 1, diff: '-old\n+new\n' },
  ],
  totalAdded: 7,
  totalRemoved: 1,
};

/** 带 hunk 头的 diff（行内评论行号锚定依赖 @@ 头）。 */
const diffWithHunk = [
  'diff --git a/chapters/第1章.md b/chapters/第1章.md',
  'index 111..222 100644',
  '--- a/chapters/第1章.md',
  '+++ b/chapters/第1章.md',
  '@@ -1,2 +1,3 @@',
  ' 旧开头',
  '+新开头',
  '+新增段落',
  ' 结尾',
].join('\n');

const hunkReview: ReviewResult = {
  commits: [{ hash: 'def5678', message: '[auto] 写', date: '2026-07-27T00:00:00+08:00' }],
  files: [
    { path: 'chapters/第1章.md', status: 'modified', addedLines: 2, removedLines: 0, diff: diffWithHunk },
  ],
  totalAdded: 2,
  totalRemoved: 0,
};

interface Props {
  review: ReviewResult | undefined;
  onMerge: () => void;
  onDiscard: () => void;
  merging: boolean;
  discarding: boolean;
  onClose: () => void;
  onAcceptFile: (path: string) => void;
  onRejectFile: (path: string) => void;
  fileBusy: boolean;
}

const baseProps: Props = {
  review: sampleReview,
  onMerge: vi.fn(),
  onDiscard: vi.fn(),
  merging: false,
  discarding: false,
  onClose: vi.fn(),
  onAcceptFile: vi.fn(),
  onRejectFile: vi.fn(),
  fileBusy: false,
};

/**
 * ReviewPanel 内部经 useParams 取 :id 拉评论（与 ProjectPage 同源路由参数）。
 * 带 projectId 时挂匹配路由（激活评论查询）；不带时裸渲染（评论能力降级）。
 */
function renderPanel(props: Partial<Props> = {}, opts: { projectId?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  if (opts.projectId) {
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/projects/${opts.projectId}`]}>
          <Routes>
            <Route path="/projects/:id" element={<ReviewPanel {...baseProps} {...props} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  return render(
    <QueryClientProvider client={qc}>
      <ReviewPanel {...baseProps} {...props} />
    </QueryClientProvider>,
  );
}

/** 评论 GET fixture：chapters/第1章.md 一条未解决评论。 */
const commentsFixture = {
  comments: [
    { id: 'c1', file: 'chapters/第1章.md', line: 1, body: '开头太慢', createdAt: '2026-01-02T03:04:05Z', resolved: false },
  ],
  byFile: { 'chapters/第1章.md': [{ id: 'c1', file: 'chapters/第1章.md', line: 1, body: '开头太慢', createdAt: '2026-01-02T03:04:05Z', resolved: false }] },
  unresolvedCount: 1,
};

/** stub fetch：GET/POST/PATCH /review/comments* 分流。 */
function stubCommentsFetch() {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/review/comments') && method === 'GET') {
      return Promise.resolve({ ok: true, json: async () => commentsFixture });
    }
    if (url.includes('/review/comments') && method === 'POST') {
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ comment: { id: 'c2' } }) });
    }
    if (url.includes('/review/comments/') && method === 'PATCH') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ comment: { id: 'c1', resolved: true } }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ReviewPanel 基础（无路由上下文，评论能力降级）', () => {
  it('空审阅时显示"无待审阅"', () => {
    renderPanel({ review: emptyReview });
    expect(screen.getByText('无待审阅')).toBeInTheDocument();
  });

  it('渲染文件列表 + 增删摘要', () => {
    renderPanel();
    expect(screen.getByText('chapters/第1章.md')).toBeInTheDocument();
    expect(screen.getByText('concept.md')).toBeInTheDocument();
    expect(screen.getByText(/\+7/)).toBeInTheDocument();
  });

  it('点文件展开 diff', () => {
    renderPanel();
    fireEvent.click(screen.getByText('chapters/第1章.md'));
    expect(screen.getByText(/第一章内容/)).toBeInTheDocument();
  });

  it('点合并调用 onMerge', () => {
    const onMerge = vi.fn();
    renderPanel({ onMerge });
    fireEvent.click(screen.getByText('合并'));
    expect(onMerge).toHaveBeenCalledOnce();
  });

  it('点丢弃需二次确认', () => {
    const onDiscard = vi.fn();
    renderPanel({ onDiscard });
    fireEvent.click(screen.getByText('丢弃'));
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('确认丢弃'));
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('逐文件接受/拒绝调用对应 handler', () => {
    const onAcceptFile = vi.fn();
    const onRejectFile = vi.fn();
    renderPanel({ onAcceptFile, onRejectFile });
    // 每个文件都有一组接受/拒绝按钮，取第一组
    fireEvent.click(screen.getAllByText('✓ 接受')[0]);
    expect(onAcceptFile).toHaveBeenCalledWith('chapters/第1章.md');
    fireEvent.click(screen.getAllByText('✗ 拒绝')[0]);
    expect(onRejectFile).toHaveBeenCalledWith('chapters/第1章.md');
  });

  it('fileBusy 时逐文件按钮禁用', () => {
    renderPanel({ fileBusy: true });
    expect(screen.getAllByText('✓ 接受')[0]).toBeDisabled();
    expect(screen.getAllByText('✗ 拒绝')[0]).toBeDisabled();
  });
});

describe('ReviewPanel 行内评论（PR 式审阅）', () => {
  it('💬 徽标 + 顶部汇总条未解决计数', async () => {
    stubCommentsFetch();
    renderPanel(undefined, { projectId: 'p1' });
    // 文件行徽标：该文件 1 条未解决
    expect(await screen.findByText('💬 1')).toBeInTheDocument();
    // 汇总条：N 文件待审 / M 条未解决评论
    expect(screen.getByText(/💬 1 条未解决评论/)).toBeInTheDocument();
  });

  it('点 diff 行尾 ＋ → 编辑器带行号锚点 → 提交 POST /review/comments', async () => {
    const fetchMock = stubCommentsFetch();
    renderPanel({ review: hunkReview }, { projectId: 'p1' });

    fireEvent.click(screen.getByText('chapters/第1章.md'));
    // 展开后 diff 内容行带行尾 ＋ 按钮（上下文/新增/删除行）
    const addBtns = await screen.findAllByTitle(/评论第 \d+ 行/);
    expect(addBtns.length).toBeGreaterThanOrEqual(3);

    // 点击第 1 行（上下文行）的 ＋：编辑器出现并带行号
    fireEvent.click(screen.getAllByTitle('评论第 1 行')[0]);
    expect(screen.getByText('评论 行 1')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/写下批注/), { target: { value: '这里不好' } });
    fireEvent.click(screen.getByText('提交'));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/projects/p1/review/comments' && init?.method === 'POST',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1]!.body as string)).toEqual({
        file: 'chapters/第1章.md',
        line: 1,
        body: '这里不好',
      });
    });
    // 提交成功后编辑器关闭
    await waitFor(() => expect(screen.queryByText('提交')).not.toBeInTheDocument());
  });

  it('展开文件显示已有评论列表；点 ✓ 解决 PATCH /comments/:id', async () => {
    const fetchMock = stubCommentsFetch();
    renderPanel({ review: hunkReview }, { projectId: 'p1' });

    fireEvent.click(screen.getByText('chapters/第1章.md'));
    // 评论列表：正文 + 行号锚点 + 解决按钮
    expect(await screen.findByText('开头太慢')).toBeInTheDocument();
    expect(screen.getByText('行 1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('✓ 解决'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/projects/p1/review/comments/c1' && init?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1]!.body as string)).toEqual({ resolved: true });
    });
  });

  it('run 进行中：占位横幅 + 评论仍可见（GET 放行），解决按钮禁用', async () => {
    stubCommentsFetch();
    renderPanel(
      { review: { ...emptyReview, runInProgress: true, runId: 'r1' } },
      { projectId: 'p1' },
    );
    expect(screen.getByText(/写作任务进行中/)).toBeInTheDocument();
    // 评论区块仍展示（含文件名与正文）
    expect(await screen.findByText('开头太慢')).toBeInTheDocument();
    expect(screen.getByText('chapters/第1章.md')).toBeInTheDocument();
    // run 中 PATCH 会被后端 409：按钮禁用并提示
    expect(screen.getByText('✓ 解决')).toBeDisabled();
    expect(screen.getByText(/任务结束后自动恢复/)).toBeInTheDocument();
  });

  it('无待审改动但有遗留评论：评论区块仍可处理', async () => {
    stubCommentsFetch();
    renderPanel({ review: emptyReview }, { projectId: 'p1' });
    expect(screen.getByText('无待审阅')).toBeInTheDocument();
    expect(await screen.findByText('开头太慢')).toBeInTheDocument();
    expect(screen.getByText('✓ 解决')).toBeEnabled();
  });
});
