import { useQuery } from '@tanstack/react-query';
import type { DocType } from '@/shared/split-document';

export interface NovelDocument {
  content: string;
  /** 修订目标文件（相对 .novel/），可能是 '<type>/index.md' 或旧格式单文件。 */
  sourceFile: string;
}

/**
 * 拉取合并后的拆分文档（后端读 index + 全部卡片 → 拼合为单个 markdown）。
 * 替代 useNovelFile 用于 concept/world/outline 三种拆分文档。
 * 旧格式项目（无 <type>/index.md）自动回退到旧单文件。
 * queryKey 与 SSE 失效逻辑对齐：file-changed 事件按目录前缀失效。
 */
export function useNovelDocument(projectId: string, docType: DocType) {
  return useQuery<NovelDocument | null>({
    queryKey: ['novel-document', projectId, docType],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/document/${docType}`);
      if (!res.ok) return null;
      const data = await res.json();
      return { content: data.content as string, sourceFile: data.sourceFile as string };
    },
  });
}
