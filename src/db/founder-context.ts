/**
 * FounderOS — founder_context row helpers (pure, no DB)
 * ======================================================
 * agents.founder_context is one JSONB blob per tenant with three writers:
 *   - the founder, through update_context (src/tools/context.ts) and the /focus
 *     and /projects commands (src/gateway/focus-commands.ts);
 *   - the deploy seed, scripts/seed-founder-context.ts (fill-only, except the
 *     SYSTEM_CONTEXT_KEYS the code owns and RETIRED_SEED_VALUES — see below);
 *   - system bookkeeping that shares the row, e.g. the budget alert sweep's
 *     dedupe state (src/infra/daily-budget-alerts.ts).
 *
 * Every write that changes a value dates it: `context_meta` (context-meta.ts)
 * holds { at, source } per key, stamped in mergeContextUpdates (founder and
 * system writes) and reconcileSeededContext (the seed). The list of writers is
 * pinned by tests/unit/db/founder-context-writers.test.ts.
 *
 * Bookkeeping keys are listed ONCE here. Every founder-facing render filters
 * through founderFacingContext(); before this list existed, read_context printed
 * "budget alerts sent: [object Object]" as business context.
 */

import { isDeepStrictEqual } from "node:util";
import {
  CONTEXT_META_KEY,
  pruneContextMeta,
  readContextMeta,
  stampContextMeta,
  type ContextSource,
} from "./context-meta.js";
import { RETIRED_SEED_VALUES } from "./retired-seed-values.js";

export { RETIRED_SEED_VALUES };

/** founder_context key for deduplicated budget threshold alerts (see daily-budget.ts). */
export const BUDGET_ALERTS_KEY = "budget_alerts_sent";

/** ISO timestamp of the last founder-facing write; shown by read_context, never counted as context. */
export const LAST_UPDATED_KEY = "last_updated";

/** Keys the system stores for its own bookkeeping. Never shown to the founder or a model. */
export const INTERNAL_CONTEXT_KEYS: readonly string[] = [BUDGET_ALERTS_KEY, CONTEXT_META_KEY];

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

/**
 * Keys that describe FounderOS itself rather than the founder's business. The
 * code owns them: the deploy seed rewrites a stored value that differs from the
 * seed. Until 2026-09-29 they were fill-only like every other key, so prod kept
 * v2's "createSupervisor + createReactAgent, Gemini 2.5 Flash via OpenRouter"
 * for three months after v2 was deleted. The bot described that architecture to
 * the founder and wrote an Antigravity brief against a v2 file (#762 → #763).
 */
export const SYSTEM_CONTEXT_KEYS: readonly string[] = ["tech_stack", "founderos_departments", "founderos_key_features"];

/**
 * Seed values that were retired (data: retired-seed-values.ts). A stored value still
 * EQUAL to one of them was written by the seed and never touched since, so the seed
 * removes it (#760 only edited the seed file, so the June values stayed in prod;
 * #767 added the removal; 2026-09-29 added the four that made "what is my focus?"
 * answer with June's plan). Anything the founder saved under the same key differs,
 * and is kept.
 *
 * Deep equality, not ===: a value read back from JSONB is a fresh object, and a
 * structured one (an array of objects) is never === to the literal that was seeded.
 * `Object.hasOwn`: a stored key called "constructor" must not find Object's own.
 */
export function isRetiredSeedValue(
  key: string,
  value: unknown,
  retired: Readonly<Record<string, readonly unknown[]>> = RETIRED_SEED_VALUES,
): boolean {
  return Object.hasOwn(retired, key) && (retired[key] ?? []).some((text) => isDeepStrictEqual(value, text));
}

/**
 * Merge a write into the stored row and date it. Every key written (except the
 * internal ones) gets `{ at: now, source }` in `context_meta`, and `last_updated`
 * moves. A bookkeeping-only write (the budget alert sweep) is not a founder
 * update: it dates nothing and leaves `last_updated` and `context_meta` as they
 * were. A caller cannot write `context_meta` itself: its dates come from here.
 * Pure: `now` is an argument, and nothing is mutated.
 */
export function mergeContextUpdates(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
  now: Date,
  source: ContextSource,
): Record<string, unknown> {
  const writes = Object.fromEntries(Object.entries(updates).filter(([key]) => key !== CONTEXT_META_KEY));
  const merged: Record<string, unknown> = { ...current, ...writes };
  if (!Object.keys(writes).some((key) => !INTERNAL_CONTEXT_KEYS.includes(key))) return merged;

  const written = Object.keys(writes).filter((key) => !INTERNAL_CONTEXT_KEYS.includes(key) && key !== LAST_UPDATED_KEY);
  merged[LAST_UPDATED_KEY] = now.toISOString();
  merged[CONTEXT_META_KEY] = pruneContextMeta(
    stampContextMeta(readContextMeta(current).entries, written, source, now),
    Object.keys(merged),
  );
  return merged;
}

export interface SeedReconciliation {
  /** The row to store. */
  readonly data: Record<string, unknown>;
  /** Absent keys the seed added. */
  readonly filled: string[];
  /** Code-owned keys whose stored value differed from the code's, rewritten. */
  readonly refreshed: string[];
  /** Keys whose stored value was still a retired seed value, removed. */
  readonly retired: string[];
  /**
   * Keys the seed used to write that are stored but were NOT removed: the founder wrote
   * or confirmed the value, or it differs from every text the seed ever wrote (an older
   * text this list does not know). The deploy log names them, so a value that should have
   * been retired and was not (one byte off) is visible without reading the database.
   */
  readonly survived: string[];
  /** Code-owned keys that already matched the code but had no date: dated now, value unchanged. */
  readonly dated: string[];
  /** Why context_meta was rebuilt (it was not readable); empty when it was healthy or absent. */
  readonly metaProblems: readonly string[];
}

/**
 * What the deploy seed writes: fill absent keys, rewrite SYSTEM_CONTEXT_KEYS that
 * drifted, drop RETIRED_SEED_VALUES nobody changed. Every other stored value wins.
 *
 * Dates (context_meta): a filled key is dated `seed` (`system` for a code-owned
 * key) and a refreshed key `system`, both `now`. A code-owned key that already
 * matches the code but has no date is dated `system` once (`dated`): the deploy
 * rewrites it whenever it drifts, so it is never stale, and leaving it undated
 * would flag FounderOS's own description "date unknown" on every read. A founder
 * fact the seed did not write stays undated: a missing date must never read as a fresh one.
 *
 * A retired value is NOT removed when its date says the founder wrote it: /focus
 * with the exact retired text stores a value equal to it, and the deploy must not
 * delete what he just typed. Removing a key removes its date with it (no orphan).
 *
 * Idempotent: the row it returns, stored, reconciles to `filled`, `refreshed`,
 * `retired` and `dated` all empty. Pure: `now` is an argument, nothing is mutated.
 */
export function reconcileSeededContext(
  current: Record<string, unknown>,
  defaults: Record<string, unknown>,
  now: Date,
  retiredValues: Readonly<Record<string, readonly unknown[]>> = RETIRED_SEED_VALUES,
): SeedReconciliation {
  const { data, filled } = fillMissingContextKeys(current, defaults);
  const refreshed = SYSTEM_CONTEXT_KEYS.filter(
    (key) => Object.hasOwn(defaults, key) && Object.hasOwn(current, key) && !isDeepStrictEqual(current[key], defaults[key]),
  );
  for (const key of refreshed) data[key] = defaults[key];

  const { entries, problems: metaProblems } = readContextMeta(current);
  const retired = Object.keys(retiredValues).filter(
    (key) =>
      Object.hasOwn(current, key) &&
      entries[key]?.source !== "founder" &&
      isRetiredSeedValue(key, current[key], retiredValues),
  );
  for (const key of retired) delete data[key];
  const survived = Object.keys(retiredValues).filter((key) => Object.hasOwn(current, key) && !retired.includes(key));

  const dated = SYSTEM_CONTEXT_KEYS.filter(
    (key) =>
      Object.hasOwn(defaults, key) && Object.hasOwn(current, key) && !refreshed.includes(key) && entries[key]?.source !== "system",
  );
  if (filled.length + refreshed.length + retired.length + dated.length + metaProblems.length > 0) {
    const codeOwnedFills = filled.filter((key) => SYSTEM_CONTEXT_KEYS.includes(key));
    const stamped = stampContextMeta(
      stampContextMeta(entries, filled.filter((key) => !SYSTEM_CONTEXT_KEYS.includes(key)), "seed", now),
      [...codeOwnedFills, ...refreshed, ...dated],
      "system",
      now,
    );
    data[CONTEXT_META_KEY] = pruneContextMeta(stamped, Object.keys(data));
  }
  return { data, filled, refreshed, retired, survived, dated, metaProblems };
}
