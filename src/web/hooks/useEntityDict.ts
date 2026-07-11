/**
 * 拉取项目档案文件 → 构建实体词典。
 * 复用 viewShared 的 useNovelFile / useNovelFileList（react-query 缓存 + SSE 失效）。
 *
 * 用 useQueries 批量拉取（符合 hooks 规则，且 queryKey 与 useNovelFile 一致，
 * SSE file-changed 失效逻辑仍生效）。
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useNovelFileList } from '@/web/components/views/viewShared';
import { buildEntityDict, type EntityRef } from '@/shared/entity-dict';

export function useEntityDict(projectId: string): {
  dict: Map<string, EntityRef>;
  isLoading: boolean;
} {
  const { data: fileList } = useNovelFileList(projectId);

  // 候选档案：characters/*.md + world/*.md + concept/*.md + wuxia/*.md
  const candidates = useMemo(() => {
    const list = fileList ?? [];
    const result: Array<{ key: string; path: string }> = [];
    for (const p of list) {
      if (p.startsWith('characters/') && p.endsWith('.md')) {
        result.push({ key: `char-${p}`, path: p });
      } else if (p.startsWith('world/') && p.endsWith('.md') && p !== 'world/index.md') {
        result.push({ key: `world-${p}`, path: p });
      } else if (p.startsWith('concept/') && p.endsWith('.md') && p !== 'concept/index.md') {
        result.push({ key: `concept-${p}`, path: p });
      } else if (p.startsWith('wuxia/') && p.endsWith('.md')) {
        result.push({ key: `wuxia-${p}`, path: p });
      }
    }
    return result;
  }, [fileList]);

  const queryResults = useQueries({
    queries: candidates.map((c) => ({
      queryKey: ['novel-file', projectId, c.key],
      queryFn: async () => {
        const res = await fetch(
          `/api/projects/${projectId}/files?path=${encodeURIComponent(c.path)}`,
        );
        if (!res.ok) return null;
        const data = await res.json();
        return data.content as string | null;
      },
    })),
  });

  const dict = useMemo(() => {
    const sources: Array<{ path: string; content: string }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const content = queryResults[i].data;
      if (content) sources.push({ path: candidates[i].path, content });
    }
    return buildEntityDict(sources);
    // queryResults 是数组，依赖其内容变化；用 data 拼成依赖串触发 memo 重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, queryResults.map((q) => q.data).join('\u0000')]);

  const isLoading = queryResults.some((q) => q.isLoading);

  return { dict, isLoading };
}
