/**
 * FounderOS — founder_context row helpers (pure, no DB)
 * ======================================================
 * agents.founder_context is one JSONB blob per tenant with three writers:
 *   - the founder, through update_context (src/tools/context.ts);
 *   - the deploy seed, scripts/seed-founder-context.ts (fill-only, except the
 *     SYSTEM_CONTEXT_KEYS the code owns and RETIRED_SEED_VALUES — see below);
 *   - system bookkeeping that shares the row, e.g. the budget alert sweep's
 *     dedupe state (src/infra/daily-budget-alerts.ts).
 *
 * Bookkeeping keys are listed ONCE here. Every founder-facing render filters
 * through founderFacingContext(); before this list existed, read_context printed
 * "budget alerts sent: [object Object]" as business context.
 */

import { isDeepStrictEqual } from "node:util";

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
 * Seed values retired from scripts/seed-founder-context.ts (#760, 2026-09-28 —
 * which only edited the file, so the June values stayed in prod). A stored value
 * still EQUAL to one of these was written by the seed and never touched since,
 * so the seed removes it. Anything the founder saved under the same key through
 * update_context differs, and is kept.
 */
export const RETIRED_SEED_VALUES: Readonly<Record<string, unknown>> = {
  current_priorities: [
    "Ship 3 live proof showcases at proof.turicks.com (showcase-1 AgentOps first)",
    "LinkedIn build-in-public: 3–5 posts/week via FounderOS marketing dept (HITL on every post)",
    "Proof Drops: 2–3 custom cinematic artifacts/week to AI/dev-tool seed–Series A target list",
    "Keep turicks-brain current: pnpm brain:sync after every strategy/ADR change",
    "Land first $8K+ Cinematic Launch Experience client (studio retainer $5K/mo after)",
  ],
  recent_wins: [
    "FounderOS production live on Hetzner VPS since 2026-06-14 (GitHub Actions CD)",
    "Phases 1–6 hardening merged: context isolation, typed signals, Claude judge, execution guards",
    "turicks-brain dual RAG live (brain:sync + pgvector, Ollama embeddings)",
    "ICP guard fix: toolsCalled honored when dept tool messages hidden (2026-06-18)",
    "Prod hardcore QA: 6/6 office probes PASS including ICP grounding (T23/T24)",
    "Web design pipeline: claude_code + deploy_static_site + site_deployed signal wired",
  ],
  next_actions: [
    "Deploy showcase-1 live at proof.turicks.com (vps-live-showcase.sh)",
    "Build showcases 2–3 per 05-SHOWCASE-BRIEF.md",
    "Compile 30-account AI/dev-tool target list for Proof Drops",
    "First LinkedIn BUILD_LOG post with showcase URL + FounderOS metrics (HITL approve)",
    "Configure prod LinkedIn token + gws auth (or GMAIL_BACKEND=composio rollback)",
    "First Proof Drop email to target founder (HITL approve send)",
  ],
  open_decisions: [
    "proof.turicks.com DNS vs IP-only URLs for early outreach",
    "First paying client: project vs retainer entry point",
    "Cinematic Cloud SaaS vs studio-first — studio-first locked until $5K+ banked (SCALE gate)",
  ],
};

/**
 * What the deploy seed writes: fill absent keys, rewrite SYSTEM_CONTEXT_KEYS that
 * drifted, drop RETIRED_SEED_VALUES nobody changed. Every other stored value wins.
 */
export function reconcileSeededContext(
  current: Record<string, unknown>,
  defaults: Record<string, unknown>,
): { data: Record<string, unknown>; filled: string[]; refreshed: string[]; retired: string[] } {
  const { data, filled } = fillMissingContextKeys(current, defaults);
  const refreshed = SYSTEM_CONTEXT_KEYS.filter(
    (key) => Object.hasOwn(defaults, key) && Object.hasOwn(current, key) && !isDeepStrictEqual(current[key], defaults[key]),
  );
  for (const key of refreshed) data[key] = defaults[key];
  const retired = Object.keys(RETIRED_SEED_VALUES).filter(
    (key) => Object.hasOwn(current, key) && isDeepStrictEqual(current[key], RETIRED_SEED_VALUES[key]),
  );
  for (const key of retired) delete data[key];
  return { data, filled, refreshed, retired };
}
