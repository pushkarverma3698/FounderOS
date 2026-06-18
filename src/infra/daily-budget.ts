/**
 * FounderOS — Daily Budget Guard
 * ==============================
 * Enforces the tenant-wide daily LLM spend cap (`BUDGET_DAILY_USD`).
 * Per-run caps live in budget.ts; this module guards the *day*.
 *
 * Why this exists: every agent operator needs cost control. The env var was
 * documented since v1 but never wired — runs could accumulate unbounded daily
 * spend while only single-invoke caps were enforced.
 *
 * Pure assessment/formatting functions are unit-tested without DB/LLM.
 */

import { env } from "../core/config.js";

/** Warn when daily spend crosses this fraction of the cap. */
export const DAILY_BUDGET_WARN_RATIO = 0.8;

/** Critical alert threshold (just before hard stop). */
export const DAILY_BUDGET_CRITICAL_RATIO = 0.95;

export type DailyBudgetLevel = "ok" | "warn" | "critical" | "exceeded";

export interface DailyBudgetStatus {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  percentUsed: number;
  level: DailyBudgetLevel;
}

export type DailyBudgetGateResult = { ok: true } | { ok: false; reason: string };

/** Thrown when today's spend already meets or exceeds BUDGET_DAILY_USD. */
export class DailyBudgetExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`DailyBudgetExceededError: ${reason}`);
    this.name = "DailyBudgetExceededError";
  }
}

/** Read the configured daily cap (USD). */
export function getDailyBudgetCapUsd(): number {
  return env.BUDGET_DAILY_USD;
}

/** Read per-run caps for display alongside daily status. */
export function getRunBudgetCaps(): { maxUsd: number; maxTokens: number } {
  return { maxUsd: env.RUN_BUDGET_USD, maxTokens: env.RUN_BUDGET_TOKENS };
}

/**
 * Assess daily spend against the cap. Pure — no I/O.
 */
export function assessDailyBudget(spentUsd: number, capUsd: number): DailyBudgetStatus {
  const cap = capUsd > 0 ? capUsd : 5;
  const spent = Math.max(0, spentUsd);
  const percentUsed = cap > 0 ? (spent / cap) * 100 : 100;
  const remainingUsd = Math.max(0, cap - spent);

  let level: DailyBudgetLevel = "ok";
  if (spent >= cap) level = "exceeded";
  else if (percentUsed >= DAILY_BUDGET_CRITICAL_RATIO * 100) level = "critical";
  else if (percentUsed >= DAILY_BUDGET_WARN_RATIO * 100) level = "warn";

  return {
    spentUsd: spent,
    capUsd: cap,
    remainingUsd,
    percentUsed,
    level,
  };
}

/**
 * Gate a new office run. Call BEFORE invoke when spend is already at/over cap.
 */
export function checkDailyBudgetGate(spentUsd: number, capUsd: number): DailyBudgetGateResult {
  const status = assessDailyBudget(spentUsd, capUsd);
  if (status.level !== "exceeded") return { ok: true };
  return {
    ok: false,
    reason:
      `Daily budget exceeded: $${status.spentUsd.toFixed(4)} ≥ $${status.capUsd.toFixed(2)} limit. ` +
      `New tasks are blocked until tomorrow. Set BUDGET_DAILY_USD in .env to raise the cap.`,
  };
}

/**
 * Pre-invoke gate used by the gateway. Reads live spend from DB; **fail-open**
 * when telemetry is unavailable (dev DB without migrations, transient outage).
 */
export async function assertDailyBudgetAllowsRun(
  getSpentUsd: () => Promise<number>,
  capUsd: number,
  onTelemetryError?: (message: string) => void,
): Promise<void> {
  let spent = 0;
  try {
    spent = await getSpentUsd();
  } catch (err) {
    onTelemetryError?.((err as Error).message);
    return;
  }
  const gate = checkDailyBudgetGate(spent, capUsd);
  if (!gate.ok) throw new DailyBudgetExceededError(gate.reason);
}

/** Emoji + label for Telegram dashboards. */
export function dailyBudgetLevelLabel(level: DailyBudgetLevel): string {
  switch (level) {
    case "exceeded":
      return "🛑 cap reached";
    case "critical":
      return "🔴 critical";
    case "warn":
      return "🟡 warning";
    default:
      return "✅ headroom";
  }
}

export interface CostBreakdownRow {
  agent: string;
  model: string;
  calls: number;
  total_cost_usd: string;
}

/** Format the /budget dashboard (HTML). */
export function formatBudgetDashboard(
  status: DailyBudgetStatus,
  runCaps: { maxUsd: number; maxTokens: number },
  breakdown: CostBreakdownRow[] = [],
): string {
  const dailyLine =
    `💰 <b>Daily:</b> $${status.spentUsd.toFixed(4)} / $${status.capUsd.toFixed(2)} ` +
    `(${status.percentUsed.toFixed(0)}%) — ${dailyBudgetLevelLabel(status.level)}`;

  const runLine =
    `⚙️ <b>Per-run caps:</b> $${runCaps.maxUsd.toFixed(2)} · ` +
    `${runCaps.maxTokens.toLocaleString()} tokens`;

  let breakdownBlock = "";
  if (breakdown.length > 0) {
    const lines = breakdown.slice(0, 5).map((row) => {
      const usd = parseFloat(row.total_cost_usd);
      const cost = Number.isFinite(usd) ? `$${usd.toFixed(4)}` : row.total_cost_usd;
      return `• ${row.agent} / ${row.model} — ${cost} (${row.calls} calls)`;
    });
    breakdownBlock = `\n\n<b>Top spend (7d):</b>\n${lines.join("\n")}`;
  }

  const blocked =
    status.level === "exceeded"
      ? `\n\n🛑 <b>New tasks blocked</b> until tomorrow (midnight reset).`
      : status.level === "critical"
        ? `\n\n🔴 Approaching daily cap — consider <code>/halt</code> if testing.`
        : "";

  return (
    `💰 <b>FounderOS Budget</b>\n\n` +
    `${dailyLine}\n` +
    `${runLine}` +
    breakdownBlock +
    blocked +
    `\n\nRecent calls: <code>/runs</code>\n` +
    `Adjust caps: <code>BUDGET_DAILY_USD</code> · <code>RUN_BUDGET_USD</code> in <code>.env</code>`
  );
}

/** Compact one-liner for /status. */
export function formatBudgetStatusLine(status: DailyBudgetStatus): string {
  return (
    `💰 Budget today: $${status.spentUsd.toFixed(2)}/$${status.capUsd.toFixed(2)} ` +
    `(${status.percentUsed.toFixed(0)}%) — ${dailyBudgetLevelLabel(status.level)}`
  );
}

/** founder_context key for deduplicated threshold alerts. */
export const BUDGET_ALERTS_KEY = "budget_alerts_sent";

export interface BudgetAlertsState {
  date: string;
  levels: number[];
}

/** Today as YYYY-MM-DD in local server time. */
export function budgetAlertDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Parse stored alert state; reset when date rolls over. */
export function parseBudgetAlertsState(raw: unknown, today = budgetAlertDateKey()): BudgetAlertsState {
  if (typeof raw !== "object" || raw === null) return { date: today, levels: [] };
  const date = String((raw as { date?: unknown }).date ?? "");
  const levelsRaw = (raw as { levels?: unknown }).levels;
  if (date !== today || !Array.isArray(levelsRaw)) return { date: today, levels: [] };
  const levels = levelsRaw
    .map((n) => Number(n))
    .filter((n) => n === 80 || n === 100);
  return { date: today, levels };
}

/**
 * Return 80 or 100 if we should send a threshold alert now, else null.
 * Alerts fire once per threshold per calendar day.
 */
export function nextBudgetAlertThreshold(
  status: DailyBudgetStatus,
  alreadySent: number[],
): 80 | 100 | null {
  if (status.percentUsed >= 100 && !alreadySent.includes(100)) return 100;
  if (status.percentUsed >= DAILY_BUDGET_WARN_RATIO * 100 && !alreadySent.includes(80)) return 80;
  return null;
}

/** Build the proactive Telegram alert for a threshold crossing. */
export function formatBudgetThresholdAlert(
  status: DailyBudgetStatus,
  threshold: 80 | 100,
): string {
  if (threshold === 100) {
    return (
      `🛑 <b>Daily budget cap reached</b>\n\n` +
      `Spent <b>$${status.spentUsd.toFixed(4)}</b> of <b>$${status.capUsd.toFixed(2)}</b> today.\n\n` +
      `New tasks are now <b>blocked</b> until midnight. Resume tomorrow or raise ` +
      `<code>BUDGET_DAILY_USD</code> in <code>.env</code>.\n\n` +
      `Details: <code>/budget</code>`
    );
  }
  return (
    `🟡 <b>Daily budget warning — 80% used</b>\n\n` +
    `Spent <b>$${status.spentUsd.toFixed(4)}</b> of <b>$${status.capUsd.toFixed(2)}</b> today ` +
    `($${status.remainingUsd.toFixed(4)} left).\n\n` +
    `Check spend: <code>/budget</code> · pause work: <code>/halt</code>`
  );
}
