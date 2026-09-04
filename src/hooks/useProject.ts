import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Project } from '@/db/schema';

export interface ProjectWithMeta extends Project {
  pathExists?: boolean;
}

export function useProjects() {
  return useQuery<ProjectWithMeta[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await fetch('/api/projects');
      const data = await res.json();
      return data.projects;
    },
  });
}

export interface CreateProjectInput {
  title: string;
  path: string;
  genre?: string;
  targetWords?: number;
  chapterCount?: number;
  perspective?: string;
  /** 创作偏好（可选）：节奏偏好 / 角色权重 / 伏笔风格 / 文风锚点 */
  intent?: {
    pacing?: string;
    characterWeight?: string;
    foreshadowStyle?: string;
    styleAnchor?: string;
  };
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateProjectInput) => {
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 workspace-exists 等业务错误：抛出后端 message 供 UI toast
        throw new Error((data as { message?: string; error?: string }).message || (data as { error?: string }).error || `创建失败 (${res.status})`);
      }
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, removeFiles }: { id: string; removeFiles?: boolean }) => {
      const res = await fetch(`/api/projects/${id}${removeFiles ? '?removeFiles=true' : ''}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || `删除失败 (${res.status})`);
      }
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}
