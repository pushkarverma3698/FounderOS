/**
 * FounderOS — founder_context row helpers (pure, no DB)
 * ======================================================
 * agents.founder_context is one JSONB blob per tenant with three writers:
 *   - the founder, through update_context (src/tools/context.ts);
 *   - the deploy seed, scripts/seed-founder-context.ts (fill-only);
 *   - system bookkeeping that shares the row, e.g. the budget alert sweep's
 *     dedupe state (src/infra/daily-budget-alerts.ts).
 *
 * Bookkeeping keys are listed ONCE here. Every founder-facing render filters
 * through founderFacingContext(); before this list existed, read_context printed
 * "budget alerts sent: [object Object]" as business context.
 */

/** founder_context key for deduplicated budget threshold alerts (see daily-budget.ts). */
export const BUDGET_ALERTS_KEY = "budget_alerts_sent";

/** ISO timestamp of the last founder-facing write; shown by read_context, never counted as context. */
export const LAST_UPDATED_KEY = "last_updated";

/** Keys the system stores for its own bookkeeping. Never shown to the founder or a model. */
export const INTERNAL_CONTEXT_KEYS: readonly string[] = [BUDGET_ALERTS_KEY];

/** The stored context minus internal bookkeeping keys (`last_updated` is kept). */
export function founderFacingContext(ctx: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(ctx).filter(([key]) => !INTERNAL_CONTEXT_KEYS.includes(key)));
}

/** True when the row holds at least one key the founder would recognise as context. */
export function hasFounderFacingContext(ctx: Record<string, unknown>): boolean {
  return Object.keys(founderFacingContext(ctx)).some((key) => key !== LAST_UPDATED_KEY);
}

/**
 * Fill-only merge for the deploy seed: stored values always win, a default is
 * written only for a key that is absent. `filled` lists the keys it added, so
 * an empty list means there is nothing to write.
 */
export function fillMissingContextKeys(
  current: Record<string, unknown>,
  defaults: Record<string, unknown>,
): { data: Record<string, unknown>; filled: string[] } {
  const filled = Object.keys(defaults).filter((key) => !Object.hasOwn(current, key));
  return { data: { ...defaults, ...current }, filled };
}
