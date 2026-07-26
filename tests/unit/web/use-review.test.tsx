import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReview } from '../../../src/web/hooks/useReview';

const mockReview = {
  commits: [{ hash: 'abc1234', message: '[auto] test', date: '2026-07-27T00:00:00+08:00' }],
  files: [{ path: 'ch1.md', status: 'added' as const, addedLines: 5, removedLines: 0, diff: '+content' }],
  totalAdded: 5,
  totalRemoved: 0,
};

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('useReview', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('拉取 review 数据', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => mockReview,
    });
    const { result } = renderHook(() => useReview('proj1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.review).toBeDefined());
    expect(result.current.review?.commits).toHaveLength(1);
    expect(result.current.pendingCount).toBe(1);
  });

  it('pendingCount 为 commits.length', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockReview, commits: [...mockReview.commits, ...mockReview.commits] }),
    });
    const { result } = renderHook(() => useReview('proj1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.pendingCount).toBe(2));
  });

  it('空审阅时 pendingCount 为 0', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ commits: [], files: [], totalAdded: 0, totalRemoved: 0 }),
    });
    const { result } = renderHook(() => useReview('proj1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.review).toBeDefined());
    expect(result.current.pendingCount).toBe(0);
  });

  it('merge 调用 POST /review/merge', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/merge') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => mockReview });
    });
    const { result } = renderHook(() => useReview('proj1'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.review).toBeDefined());
    await result.current.merge();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/projects/proj1/review/merge',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
