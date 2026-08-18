import { useQueries } from '@tanstack/react-query';
import type { DocType } from '@/shared/split-document';

/**
 * 解析三种拆分文档（concept/world/outline）的实际预览文件路径。
 *
 * 后端 GET /document/:type 返回 `sourceFile`——新格式是 `<type>/index.md`，
 * 旧格式回退到 `concept.md` / `world-building.md` / `outline-detailed.md`。
 *
 * 用于 ProjectPage 的预览面板：viewToFile 不再硬编码 index.md。
 */
const DOC_TYPES: DocType[] = ['concept', 'world', 'outline'];

export function useDocSourceFile(projectId: string): Record<string, string> {
  const queries = useQueries({
    queries: DOC_TYPES.map((docType) => ({
      queryKey: ['novel-document', projectId, docType],
      queryFn: async () => {
        const res = await fetch(`/api/projects/${projectId}/document/${docType}`);
        if (!res.ok) return null;
        const data = await res.json();
        // 缓存形状必须与 useNovelDocument 一致（{content, sourceFile} 对象）——
        // 此前这里把裸字符串 sourceFile 写进同一缓存键，两个 hook 竞争写入导致
        // 后写者胜，OutlineView 拿到字符串时 data.content 为 undefined，视图间歇性空态。
        return { content: data.content as string, sourceFile: data.sourceFile as string };
      },
      // sourceFile 只是本观察者的派生视图，不污染共享缓存
      select: (d: { sourceFile?: string } | null) => d?.sourceFile,
      staleTime: 60_000,
    })),
  });

  const map: Record<string, string> = {};
  DOC_TYPES.forEach((docType, i) => {
    const sf = queries[i].data;
    if (sf) map[docType] = sf;
  });
  return map;
}
