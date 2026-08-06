/**
 * FounderOS — the hard spend cap on the job sweep
 * ===============================================
 * The sweep may not start a paid feed call that would take the billing cycle
 * past its cap. Before this existed, nothing in the pipeline could refuse to
 * spend: the cadence was the only brake, and the cadence does not know the
 * balance.
 *
 * WHY IT MATTERS HERE SPECIFICALLY. The Apify account is on the FREE plan with a
 * $5 hard platform cap, and the research actors draw from the same pool. On
 * 2026-08-05 the cycle stood at $3.28 of $5 with two sweeps still scheduled. If
 * the platform cap is reached, actors stop returning data — and a feed that
 * returns nothing is indistinguishable from a market with nothing in it, which
 * is the exact ambiguity that hid a four-day outage.
 *
 * The decision is a PURE function over three numbers. The planner and the ledger
 * therefore cannot disagree about whether a sweep was affordable, and the gate is
 * testable without a database.
 *
 * A refusal is LOUD and lands in the founder's brief. Silently skipping a sweep
 * to stay under budget would be a cheaper version of the same failure this
 * pipeline already had: a system that stops producing and does not say so.
 */

import { childLogger } from "../../infra/logger.js";
import { summariseSpend } from "../../db/job-run-queries.js";

const log = childLogger({ module: "jobhunt:spend-gate" });

/**
 * Default ceiling per billing cycle, in USD.
 *
 * $2 of the $5 free-tier cap, leaving headroom for the research actors on the
 * same account. Raise with JOBHUNT_MONTHLY_CAP_USD.
 */
export const DEFAULT_MONTHLY_CAP_USD = 2.0;

/**
 * Day of month the Apify billing cycle rolls over.
 *
 * 11 is the observed cycle on this account (11th → 10th), not a calendar month.
 * Measuring a calendar month would use the wrong window and allow a double spend
 * across the real boundary.
 */
export const DEFAULT_CYCLE_START_DAY = 11;

export interface SpendDecision {
  readonly ok: boolean;
  /** Founder-facing sentence. Printed verbatim into the brief on a refusal. */
  readonly reason: string;
  readonly spentUsd: number;
  readonly projectedUsd: number;
  readonly capUsd: number;
  /** Headroom left in the cycle. Never negative. */
  readonly remainingUsd: number;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Read the cap, refusing to treat a malformed value as permission to spend. */
export function capFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env["JOBHUNT_MONTHLY_CAP_USD"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MONTHLY_CAP_USD;

  const parsed = Number(raw);
  // A typo must never become an unlimited budget, so anything unparseable or
  // negative falls back to the documented default rather than to "no limit".
  if (!Number.isFinite(parsed) || parsed < 0) {
    log.warn({ raw }, "JOBHUNT_MONTHLY_CAP_USD is not a valid amount — using the default cap");
    return DEFAULT_MONTHLY_CAP_USD;
  }
  return parsed;
}

/** Read the billing-cycle start day, rejecting values that are not a day of month. */
export function cycleStartDayFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env["APIFY_CYCLE_START_DAY"]);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 28) return DEFAULT_CYCLE_START_DAY;
  return parsed;
}

/**
 * The instant the current billing cycle began.
 *
 * Capped at day 28 by `cycleStartDayFromEnv` so the cycle exists in February and
 * the window never silently shifts in a short month.
 */
export function cycleStart(now: Date, startDay: number): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const started = now.getUTCDate() >= startDay;
  return new Date(Date.UTC(year, started ? month : month - 1, startDay));
}

/** Whether a sweep projected to cost `projectedUsd` may run. Pure. */
export function decideSweep(args: {
  spentUsd: number;
  projectedUsd: number;
  capUsd: number;
}): SpendDecision {
  const { spentUsd, projectedUsd, capUsd } = args;
  const remainingUsd = Math.max(0, capUsd - spentUsd);
  // `<=` because the cap is a ceiling, not a line to stay under. Refusing a
  // sweep that lands exactly on it would make the last affordable sweep of every
  // cycle unreachable.
  const ok = spentUsd + projectedUsd <= capUsd;

  const reason = ok
    ? `${usd(spentUsd)} spent this cycle of ${usd(capUsd)}; this sweep projects ${usd(projectedUsd)}.`
    : `Sweep SKIPPED to stay under the cap. ${usd(spentUsd)} already spent this cycle of ` +
      `${usd(capUsd)}; this sweep projects ${usd(projectedUsd)} and only ${usd(remainingUsd)} ` +
      `is left. Raise JOBHUNT_MONTHLY_CAP_USD or wait for the cycle to roll over.`;

  return { ok, reason, spentUsd, projectedUsd, capUsd, remainingUsd };
}

/**
 * The same decision, against what the ledger says has actually been spent.
 *
 * Fails OPEN on a database error, deliberately and loudly: the ledger is
 * bookkeeping and the sweep is the work, and a Postgres hiccup must not silently
 * end the job search. The platform's own $5 cap is the backstop underneath this.
 */
export async function checkSweepBudget(
  projectedUsd: number,
  opts: { now?: Date; env?: Record<string, string | undefined> } = {},
): Promise<SpendDecision> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const capUsd = capFromEnv(env);
  const since = cycleStart(now, cycleStartDayFromEnv(env));

  let spentUsd = 0;
  try {
    spentUsd = (await summariseSpend(since)).costUsd;
  } catch (err) {
    // allow-failopen: the ledger is the receipt, the sweep is the work. A cap we
    // cannot read must not end the job search; Apify's own $5 platform cap still
    // stands underneath, and the failure is logged at error level.
    log.error(
      { err: (err as Error).message, since },
      "Spend ledger unreadable — running the sweep uncapped this once",
    );
    return {
      ok: true,
      reason: `Spend ledger unreadable (${(err as Error).message}); cap NOT enforced this run.`,
      spentUsd: 0,
      projectedUsd,
      capUsd,
      remainingUsd: capUsd,
    };
  }

  const decision = decideSweep({ spentUsd, projectedUsd, capUsd });
  log[decision.ok ? "info" : "warn"](
    { spentUsd, projectedUsd, capUsd, since },
    decision.ok ? "Sweep within budget" : "Sweep refused by the spend cap",
  );
  return decision;
}
