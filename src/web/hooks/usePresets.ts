import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

/** GET /api/projects/:id/presets 响应（列表项）。 */
export interface PresetSummaryEntry {
  id: string;
  name: string;
  /** 预设设计用于的阶段（'' = 不限定；元信息，实际注入看绑定）。 */
  stage: string;
  description: string;
  current: number;
  versionCount: number;
  /** 绑定了该预设的主阶段 id 列表。 */
  boundStages: string[];
}

export interface PresetsOverview {
  presets: PresetSummaryEntry[];
  bindings: Record<string, string | null>;
}

export interface PresetVersionEntry {
  version: number;
  note: string;
  createdAt: string;
  content: string;
}

/** GET /api/projects/:id/presets/:presetId 响应（版本历史含全文）。 */
export interface PresetDetailEntry {
  manifest: {
    id: string;
    name: string;
    stage: string;
    description: string;
    current: number;
  };
  versions: PresetVersionEntry[];
}

/** GET /api/projects/:id/presets/preview?stage=X 响应。 */
export interface PresetPreviewEntry {
  prompt: string;
  presetId: string | null;
  version: number | null;
  tokensApprox: number;
  /** 非 writing 族阶段：上下文层仅为示意时的说明。 */
  note?: string;
}

/** 统一 JSON 请求：非 2xx 抛后端 error 字段（中文消息直接上 UI）。 */
async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body?.error) message = body.error;
    } catch { /* 非 JSON 错误体，保留状态码消息 */ }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface CreatePresetInput {
  name: string;
  stage?: string;
  content: string;
  description?: string;
}

/**
 * 提示词预设 hook：列表/详情/预览查询 + 全部写 mutation。
 * 写成功后统一失效预设缓存（列表里的 current/版本数/绑定阶段都会变）。
 */
export function usePresets(projectId: string) {
  const qc = useQueryClient();

  const overview = useQuery({
    queryKey: ['prompt-presets', projectId],
    queryFn: () => jsonFetch<PresetsOverview>(`/api/projects/${projectId}/presets`),
    enabled: !!projectId,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['prompt-presets', projectId] });

  const createMut = useMutation({
    mutationFn: (body: CreatePresetInput) =>
      jsonFetch<{ preset: { id: string } }>(`/api/projects/${projectId}/presets`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
  });

  const addVersionMut = useMutation({
    mutationFn: (vars: { presetId: string; content: string; note?: string }) =>
      jsonFetch(`/api/projects/${projectId}/presets/${vars.presetId}/versions`, {
        method: 'POST',
        body: JSON.stringify({ content: vars.content, note: vars.note }),
      }),
    onSuccess: invalidate,
  });

  const updateMut = useMutation({
    mutationFn: (vars: { presetId: string; current?: number; name?: string }) =>
      jsonFetch(`/api/projects/${projectId}/presets/${vars.presetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ current: vars.current, name: vars.name }),
      }),
    onSuccess: invalidate,
  });

  const deleteMut = useMutation({
    mutationFn: (presetId: string) =>
      jsonFetch(`/api/projects/${projectId}/presets/${presetId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const importMut = useMutation({
    mutationFn: (vars: { skillPath: string; name?: string; stage?: string }) =>
      jsonFetch<{ preset: { id: string } }>(`/api/projects/${projectId}/presets/import-skill`, {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: invalidate,
  });

  const bindMut = useMutation({
    mutationFn: (vars: { stage: string; presetId: string | null }) =>
      jsonFetch<Record<string, string | null>>(`/api/projects/${projectId}/presets/bindings`, {
        method: 'PUT',
        body: JSON.stringify(vars),
      }),
    onSuccess: invalidate,
  });

  return { overview, createMut, addVersionMut, updateMut, deleteMut, importMut, bindMut };
}

/** 单个预设详情（版本历史）。presetId 为空不发请求。 */
export function usePresetDetail(projectId: string, presetId: string | null) {
  return useQuery({
    queryKey: ['prompt-preset-detail', projectId, presetId],
    queryFn: () => jsonFetch<PresetDetailEntry>(`/api/projects/${projectId}/presets/${presetId}`),
    enabled: !!projectId && !!presetId,
    staleTime: 10_000,
  });
}

/** 组装预览（按阶段）。enabled=false 时不发请求（选好阶段再拉）。 */
export function usePresetPreview(projectId: string, stage: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['prompt-preset-preview', projectId, stage],
    queryFn: () =>
      jsonFetch<PresetPreviewEntry>(`/api/projects/${projectId}/presets/preview?stage=${stage}`),
    enabled: enabled && !!projectId && !!stage,
    staleTime: 10_000,
  });
}
