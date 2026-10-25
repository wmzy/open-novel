import { useQuery } from '@tanstack/react-query';

/** 上下文检查器：单层报告（与后端 ContextSectionReport 对应）。 */
export interface ContextSectionReportEntry {
  name: string;
  priority: number;
  /** 该层构建文本的原始 token 估算（丢弃 / 截断前的量）。 */
  tokens: number;
  /** 是否注入最终 prompt（false = 超预算被整层丢弃）。 */
  kept: boolean;
  /** 截断后保留的层首字符数（仅截断层有值）。 */
  truncatedTo?: number;
}

/** GET /api/projects/:id/context/preview 响应。 */
export interface ContextPreview {
  sections: ContextSectionReportEntry[];
  totalTokens: number;
  budgetTokens: number;
  prompt: string;
  /** 本次预览的章号（缺省时由后端按「下一章」推断）。 */
  chapter: number;
}

/**
 * 上下文检查器查询：分层 token 报告 + 组装后 prompt。
 * chapter 传 null 表示「自动（下一章）」；enabled=false 时不发请求（懒加载）。
 */
export function useContextInspector(projectId: string, chapter: number | null, enabled: boolean) {
  return useQuery({
    queryKey: ['context-preview', projectId, chapter ?? 'auto'],
    queryFn: async (): Promise<ContextPreview> => {
      const qs = chapter === null ? '' : `?chapter=${chapter}`;
      const res = await fetch(`/api/projects/${projectId}/context/preview${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: enabled && !!projectId,
    // 报告由项目文件派生（只读），无需聚焦高频重拉
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
