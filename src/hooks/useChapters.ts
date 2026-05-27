import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export function useChapter(projectId: string, num: number) {
  return useQuery({
    queryKey: ['chapter', projectId, num],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/chapters/${num}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.chapter;
    },
  });
}

export function useUpdateChapter(projectId: string, num: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { title?: string; content?: string; wordCount?: number }) => {
      const res = await fetch(`/api/projects/${projectId}/chapters/${num}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chapter', projectId, num] }),
  });
}
