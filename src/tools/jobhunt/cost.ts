/**
 * FounderOS — what the job feeds cost
 * ===================================
 * Apify bills these actors per EVENT, not per minute. Two events matter:
 * starting the actor, and each job it returns. Both prices are published on the
 * actor pages and both fall by ~2× to ~100× on a paid Apify plan, which is why
 * the plan tier is a parameter here rather than a constant baked into the sums.
 *
 * WHY THIS IS A MODULE AND NOT A COMMENT. Asked on 2026-08-01 what the pipeline
 * costs, the answer had to be rebuilt by hand from the pricing pages and a
 * reading of the cron schedule — a question about our own system that our own
 * system could not answer. Worse, the hand-built answer went stale the moment
 * the sweep's query count changed, and it changed twice that week. The numbers
 * live in code now, next to the code that spends them, and every run writes what
 * it cost to `job_ingest_runs`.
 *
 * ESTIMATED, and named so everywhere. Apify's own ledger is the invoice; this is
 * our arithmetic over the posted prices. It is right for noticing the day a
 * sweep doubled, and it is not an accounting record.
 */

/** Apify plan tiers, in the order they reduce the per-job price. */
export type ApifyPlan = "free" | "silver" | "gold";

export interface FeedPricing {
  /** Charged once per actor start, per GB of memory (minimum one event). */
  readonly perStartUsd: number;
  /** Charged per job returned in the dataset. */
  readonly perJobUsd: number;
}

/**
 * `fantastic-jobs~career-site-job-listing-api` — the ATS aggregator.
 *
 * The dominant cost of the sweep by a wide margin: at FREE tier one returned job
 * costs 240× what an Indeed job costs.
 */
export const ATS_PRICING: Readonly<Record<ApifyPlan, FeedPricing>> = {
  free: { perStartUsd: 0.01, perJobUsd: 0.012 },
  silver: { perStartUsd: 0.0001, perJobUsd: 0.006 },
  gold: { perStartUsd: 0.0001, perJobUsd: 0.004 },
};

/** The Indeed actor. Cheap enough that its cost is noise next to the ATS feed. */
export const INDEED_PRICING: Readonly<Record<ApifyPlan, FeedPricing>> = {
  free: { perStartUsd: 0.00001, perJobUsd: 0.00005 },
  silver: { perStartUsd: 0.00001, perJobUsd: 0.00005 },
  gold: { perStartUsd: 0.00001, perJobUsd: 0.00005 },
};

/**
 * The plan we are actually on. Read from the environment so upgrading Apify is a
 * config change rather than a code change — and so the ledger stops lying about
 * the cost the same day the plan changes, not whenever someone remembers.
 */
export function currentPlan(env: NodeJS.ProcessEnv = process.env): ApifyPlan {
  const raw = (env["APIFY_PLAN"] ?? "free").toLowerCase();
  return raw === "silver" || raw === "gold" ? raw : "free";
}

/**
 * What one query cost: one start, plus one charge per job it returned.
 *
 * A FAILED query still costs a start. That is not a rounding detail — at FREE
 * tier a start is $0.01 and a returned job is $0.012, so a sweep where every
 * query fails still bills most of a successful sweep's floor. A cost model that
 * counted only successes would under-report precisely on the days something is
 * wrong.
 */
export function estimateQueryCost(
  pricing: Readonly<Record<ApifyPlan, FeedPricing>>,
  returned: number,
  plan: ApifyPlan = currentPlan(),
): number {
  const price = pricing[plan];
  return price.perStartUsd + Math.max(0, returned) * price.perJobUsd;
}

/** Round to the cent-fraction the ledger stores, so sums don't drift on floats. */
export function toLedgerAmount(usd: number): string {
  return usd.toFixed(6);
}
