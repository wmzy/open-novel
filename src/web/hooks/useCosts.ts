import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

/** GET /api/projects/:id/costs/summary 响应（与 src/api/routes/costs.ts 对应）。 */
export interface ModelCostRow {
  model: string | null;
  runs: number;
  tokens: number;
  costUsd: number;
}

export interface RunCostRow {
  runId: string;
  mode: string;
  status: string;
  tokens: number;
  costUsd: number;
  startedAt: string | null;
}

export interface ChapterCostRow {
  chapter: number;
  tokens: number;
  costUsd: number;
}

export interface DayCostRow {
  day: string;
  tokens: number;
  costUsd: number;
}

export interface CostsSummary {
  byModel: ModelCostRow[];
  byRun: RunCostRow[];
  byChapter: ChapterCostRow[];
  byDay: DayCostRow[];
  total: { tokens: number; costUsd: number; runs: number; unknownCostRuns: number };
  budget: { budgetUsd: number | null; percent: number | null; exceeded: boolean };
}

export interface CostBudget {
  budgetUsd: number | null;
  spentUsd: number;
  percent: number | null;
  exceeded: boolean;
}

/**
 * 成本面板查询：summary 全维度聚合 + budget 阈值。
 * 预算通过既有 PATCH /api/settings 保存（键 cost_budget_usd），null 表示清除。
 * 只读聚合，打开面板才拉取；run 期间越界由服务端 cost_alert 实时推送。
 */
export function useCosts(projectId: string, enabled = true) {
  const qc = useQueryClient();

  const summary = useQuery({
    queryKey: ['costs-summary', projectId],
    queryFn: async (): Promise<CostsSummary> => {
      const res = await fetch(`/api/projects/${projectId}/costs/summary`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: enabled && !!projectId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const budget = useQuery({
    queryKey: ['costs-budget', projectId],
    queryFn: async (): Promise<CostBudget> => {
      const res = await fetch(`/api/projects/${projectId}/costs/budget`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: enabled && !!projectId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['costs-summary', projectId] });
    void qc.invalidateQueries({ queryKey: ['costs-budget', projectId] });
  };

  /** 保存/清除预算：value 为 null 时发送空串（后端视为未设置）。 */
  const saveBudget = useMutation({
    mutationFn: async (value: number | null) => {
      const body = { cost_budget_usd: value === null ? '' : String(value) };
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: invalidate,
  });

  return { summary, budget, saveBudget };
}
