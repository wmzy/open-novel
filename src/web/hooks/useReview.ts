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
      if (!res.ok) throw new Error('合并失败');
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

  return {
    review: query.data,
    isLoading: query.isLoading,
    pendingCount: query.data?.commits.length ?? 0,
    merge: mergeMut.mutateAsync,
    discard: discardMut.mutateAsync,
    merging: mergeMut.isPending,
    discarding: discardMut.isPending,
  };
}
