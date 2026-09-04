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
    pendingCount: query.data?.commits.length ?? 0,
    merge: mergeMut.mutateAsync,
    discard: discardMut.mutateAsync,
    merging: mergeMut.isPending,
    discarding: discardMut.isPending,
    acceptFile: (path: string) => fileMut.mutateAsync({ op: 'accept', path }),
    rejectFile: (path: string) => fileMut.mutateAsync({ op: 'reject', path }),
    fileBusy: fileMut.isPending,
  };
}
