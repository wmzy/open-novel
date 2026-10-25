import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export interface ReviewCommit {
  hash: string;
  message: string;
  date: string;
}

export interface ReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  addedLines: number;
  removedLines: number;
  diff: string;
}

export interface ReviewResult {
  commits: ReviewCommit[];
  files: ReviewFile[];
  totalAdded: number;
  totalRemoved: number;
  /** run 进行中时后端返回占位（不跑 git/不做 checkpoint），任务结束后失效重拉。 */
  runInProgress?: boolean;
  /** run 占位时附带的活动 run id。 */
  runId?: string;
}

/** 行内评论（PR 式审阅）：与后端 src/shared/review-comments.ts 的 ReviewComment 对应。 */
export interface ReviewComment {
  id: string;
  file: string;
  /** 行号锚点；省略 = 文件级评论。 */
  line?: number;
  body: string;
  author?: string;
  /** ISO 时间戳。 */
  createdAt: string;
  resolved: boolean;
  resolvedAt?: string;
}

export interface ReviewCommentsResult {
  comments: ReviewComment[];
  byFile: Record<string, ReviewComment[]>;
  unresolvedCount: number;
}

/**
 * 审阅闸门 hook：拉取待审阅数据 + merge/discard mutations。
 * merge/discard 成功后失效 review 与 snapshots 查询缓存。
 */
export function useReview(projectId: string) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['review', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/review`);
      if (!res.ok) throw new Error('拉取审阅数据失败');
      return (await res.json()) as ReviewResult;
    },
    enabled: !!projectId,
    // GET /review 会跑整套 git 命令并可能产生 checkpoint commit（有写副作用）：
    // 窗口聚焦/重挂载不再触发高频重构，改动由 merge/discard/accept/reject 显式失效。
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const mergeMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/review/merge`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || '合并失败');
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review', projectId] });
      qc.invalidateQueries({ queryKey: ['snapshots', projectId] });
    },
  });

  const discardMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/review/discard`, { method: 'POST' });
      if (!res.ok) throw new Error('丢弃失败');
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review', projectId] });
      qc.invalidateQueries({ queryKey: ['snapshots', projectId] });
    },
  });

  /** 逐文件接受/拒绝：单文件操作，成功后刷新审阅列表。 */
  const fileMut = useMutation({
    mutationFn: async ({ op, path }: { op: 'accept' | 'reject'; path: string }) => {
      const res = await fetch(`/api/projects/${projectId}/review/files/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || (op === 'accept' ? '接受失败' : '拒绝失败'));
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['review', projectId] });
      qc.invalidateQueries({ queryKey: ['snapshots', projectId] });
    },
  });

  return {
    review: query.data,
    isLoading: query.isLoading,
    // run 进行中占位不计入待审阅数（否则徽标闪现）
    pendingCount: query.data && !query.data.runInProgress ? query.data.commits.length : 0,
    merge: mergeMut.mutateAsync,
    discard: discardMut.mutateAsync,
    merging: mergeMut.isPending,
    discarding: discardMut.isPending,
    acceptFile: (path: string) => fileMut.mutateAsync({ op: 'accept', path }),
    rejectFile: (path: string) => fileMut.mutateAsync({ op: 'reject', path }),
    fileBusy: fileMut.isPending,
  };
}

/**
 * 行内评论 hook（PR 式审阅）：GET /review/comments + 新增/解决 mutations。
 * 评论是纯 .novel 元数据，GET 在 run 进行中后端也放行；
 * 评论变化不失效 review 主查询（评论不改变 diff）。
 */
export function useReviewComments(projectId: string | undefined) {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['review-comments', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/review/comments`);
      if (!res.ok) throw new Error('拉取评论失败');
      return (await res.json()) as ReviewCommentsResult;
    },
    enabled: !!projectId,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['review-comments', projectId] });

  const addMut = useMutation({
    mutationFn: async ({ file, line, body }: { file: string; line?: number; body: string }) => {
      const res = await fetch(`/api/projects/${projectId}/review/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, line, body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || '添加评论失败');
      }
      return res.json();
    },
    onSuccess: invalidate,
  });

  const resolveMut = useMutation({
    mutationFn: async ({ id, resolved }: { id: string; resolved: boolean }) => {
      const res = await fetch(`/api/projects/${projectId}/review/comments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || '更新评论失败');
      }
      return res.json();
    },
    onSuccess: invalidate,
  });

  return {
    comments: query.data,
    addComment: addMut.mutateAsync,
    resolveComment: resolveMut.mutateAsync,
    commentBusy: addMut.isPending || resolveMut.isPending,
  };
}
