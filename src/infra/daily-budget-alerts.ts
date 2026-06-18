/**
 * FounderOS — Daily budget alert persistence
 * ==========================================
 * Tracks which threshold alerts (80%, 100%) were sent today so the scheduler
 * doesn't spam Telegram. Stored in founder_context JSONB — no new table.
 */

import { getFounderContext, upsertFounderContext } from "../db/queries.js";
import {
  BUDGET_ALERTS_KEY,
  budgetAlertDateKey,
  parseBudgetAlertsState,
  type BudgetAlertsState,
} from "../infra/daily-budget.js";

export async function getBudgetAlertsState(tenant: string): Promise<BudgetAlertsState> {
  const ctx = await getFounderContext(tenant);
  return parseBudgetAlertsState(ctx[BUDGET_ALERTS_KEY]);
}

export async function recordBudgetAlertSent(
  tenant: string,
  threshold: 80 | 100,
): Promise<BudgetAlertsState> {
  const today = budgetAlertDateKey();
  const current = await getBudgetAlertsState(tenant);
  const levels = current.date === today ? [...new Set([...current.levels, threshold])] : [threshold];
  const next: BudgetAlertsState = { date: today, levels };
  await upsertFounderContext(tenant, { [BUDGET_ALERTS_KEY]: next });
  return next;
}
