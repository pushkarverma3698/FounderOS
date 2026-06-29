/**
 * FounderOS — Cost Report (roadmap #9)
 * =====================================
 * Pure formatters for per-department cost attribution. Kept side-effect-free so
 * they're unit-testable with $0 — the DB query (getCostByDepartment) feeds them.
 *
 * The roadmap's thesis: "cost per task" is the scoreboard that should replace
 * "number of agents". These helpers compute and render exactly that.
 */

export interface DepartmentCostRow {
  department: string | null;
  calls: number;
  /** SUM(cost_usd) comes back from Postgres numeric as a string. */
  total_cost_usd: string;
}

export interface CostSummary {
  totalUsd: number;
  totalCalls: number;
  /** Mean USD per costed call — the "cost per task" headline metric. */
  costPerTask: number;
  byDepartment: Array<{ department: string; usd: number; calls: number; share: number }>;
}

/** Fold raw DB rows into a typed, sorted summary with cost-per-task. Pure. */
export function summarizeDepartmentCost(rows: DepartmentCostRow[]): CostSummary {
  const depts = rows.map((r) => ({
    department: r.department ?? "unknown",
    usd: Number.parseFloat(r.total_cost_usd) || 0,
    calls: r.calls,
  }));
  const totalUsd = depts.reduce((a, d) => a + d.usd, 0);
  const totalCalls = depts.reduce((a, d) => a + d.calls, 0);
  const costPerTask = totalCalls > 0 ? totalUsd / totalCalls : 0;
  const byDepartment = depts
    .map((d) => ({ ...d, share: totalUsd > 0 ? d.usd / totalUsd : 0 }))
    .sort((a, b) => b.usd - a.usd);
  return { totalUsd, totalCalls, costPerTask, byDepartment };
}

/** Render the summary as a Telegram-friendly HTML block. Pure. */
export function formatDepartmentCostReport(summary: CostSummary, days = 7): string {
  if (summary.totalCalls === 0) {
    return `💸 <b>Cost by department</b> (last ${days}d)\n\nNo costed calls recorded in this window.`;
  }
  const lines = summary.byDepartment.map(
    (d) =>
      `• <b>${d.department}</b> — $${d.usd.toFixed(4)} · ${d.calls} call${d.calls === 1 ? "" : "s"} · ${(d.share * 100).toFixed(0)}%`,
  );
  return (
    `💸 <b>Cost by department</b> (last ${days}d)\n\n` +
    `${lines.join("\n")}\n\n` +
    `Total: <b>$${summary.totalUsd.toFixed(4)}</b> over ${summary.totalCalls} calls — ` +
    `cost/task <b>$${summary.costPerTask.toFixed(5)}</b>`
  );
}
