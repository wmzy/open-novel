/**
 * 编辑器内联 AI（润色/扩写/续写）mutation。
 * 同步 JSON 端点（非 SSE）：loading/error 由 useMutation 承载，
 * 错误消息优先取后端 { error }（run 锁等业务错误）。
 */
import { useMutation } from '@tanstack/react-query';
import type { InlineAction, ParagraphMergePlan } from '@/shared/inline-edit';

export interface InlineEditParams {
  chapter: number;
  action: InlineAction;
  /** 选中文本（润色/扩写必填；续写为空）。 */
  selection?: string;
  /** 选区起点/光标位置（章节正文内偏移，服务端据此取前后文）。 */
  selectionStart?: number;
  /** 无法提供偏移时的兜底前文（续写）。 */
  tailContext?: string;
  /** 模型覆盖；'default' 由调用方转为 undefined。 */
  model?: string;
}

export interface InlineEditResponse {
  result: string;
  plan: ParagraphMergePlan;
}

export function useInlineEdit(projectId: string) {
  return useMutation({
    mutationFn: async (params: InlineEditParams): Promise<InlineEditResponse> => {
      const res = await fetch(`/api/projects/${projectId}/inline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json().catch(() => null) as
        | (InlineEditResponse & { error?: string; message?: string })
        | null;
      if (!res.ok) {
        throw new Error(data?.error || data?.message || `内联 AI 调用失败（${res.status}）`);
      }
      if (!data || typeof data.result !== 'string' || !data.plan) {
        throw new Error('内联 AI 响应格式异常');
      }
      return data;
    },
  });
}
