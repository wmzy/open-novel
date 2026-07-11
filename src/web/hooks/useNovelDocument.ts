import { useQuery } from '@tanstack/react-query';
import type { DocType } from '@/shared/split-document';

/**
 * 拉取合并后的拆分文档（后端读 index + 全部卡片 → 拼合为单个 markdown）。
 * 替代 useNovelFile 用于 concept/world/outline 三种拆分文档。
 * queryKey 与 SSE 失效逻辑对齐：file-changed 事件按目录前缀失效。
 */
export function useNovelDocument(projectId: string, docType: DocType) {
  return useQuery({
    queryKey: ['novel-document', projectId, docType],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/document/${docType}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.content as string;
    },
  });
}
