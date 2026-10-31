/**
 * Run 级实时预算提醒（纯函数层）。
 *
 * 服务端在 run 启动时取一次项目累计花费快照，之后每条 `runtime_usage`
 * （Pi 每条 assistant 消息一次）累加本次 run 成本；首次越过预算时 emit
 * 一次 `cost_alert`，避免每个 token 都刷屏。预算为 null/0 时不提醒
 * （0 预算按“未设置”处理，与成本面板一致）。
 *
 * 该模块不读 DB、不发请求，供服务端 tracker 与前端展示共用类型。
 */

export interface ProjectCostSnapshot {
  /** 快照时点的项目累计花费（USD，已四舍五入到 4 位）。 */
  spentUsd: number;
  /** 预算（USD）；null 表示未设置。 */
  budgetUsd: number | null;
}

export interface CostAlert {
  /** 越过预算时的项目累计花费（含本次 run 已产生的成本）。 */
  spentUsd: number;
  budgetUsd: number;
  /** spentUsd / budgetUsd 百分比；budget > 0。 */
  percent: number;
  /** 本次 run 累计成本（USD）。 */
  runCostUsd: number;
}

/** 金额统一保留 4 位小数，消除浮点尾差（0.1+0.2 类）。 */
export function roundUsd(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function validCost(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export interface BudgetTracker {
  /** 记录一条 runtime_usage 成本；首次越过预算返回 alert，否则 null。 */
  record(costUsd: unknown): CostAlert | null;
  /** 本次 run 累计成本（USD）。 */
  readonly runCostUsd: number;
}

/**
 * 创建 run 级预算 tracker。
 *
 * @param snapshot run 启动前的项目累计花费与预算。预算 null / <= 0 时
 *                 tracker 仍记录 runCostUsd，但永不返回 alert。
 */
export function createBudgetTracker(snapshot: ProjectCostSnapshot): BudgetTracker {
  const spentBefore = Number.isFinite(snapshot.spentUsd) && snapshot.spentUsd > 0
    ? snapshot.spentUsd
    : 0;
  const budget = typeof snapshot.budgetUsd === 'number'
    && Number.isFinite(snapshot.budgetUsd)
    && snapshot.budgetUsd > 0
    ? snapshot.budgetUsd
    : null;

  let runCost = 0;
  let alerted = false;

  return {
    record(costUsd: unknown): CostAlert | null {
      runCost += validCost(costUsd);
      if (alerted || budget === null) return null;

      const total = roundUsd(spentBefore + runCost);
      if (total <= budget) return null;

      alerted = true;
      return {
        spentUsd: total,
        budgetUsd: budget,
        percent: Math.round((total / budget) * 100),
        runCostUsd: roundUsd(runCost),
      };
    },
    get runCostUsd(): number {
      return roundUsd(runCost);
    },
  };
}
