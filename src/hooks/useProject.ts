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
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}
