/**
 * FounderOS — writing the sweep's cost to the ledger
 * ==================================================
 * One row per paid feed call, written as the call completes rather than
 * reconstructed afterwards.
 *
 * A FAILED call is recorded too, and that is the point rather than an edge case:
 * the actor start is billed whether or not the run returns anything, so a ledger
 * that only recorded successes would under-report precisely on the days
 * something is wrong. A day where every query failed still costs most of a
 * working day's floor, and it should look expensive, because it was.
 *
 * The write itself never throws into the sweep. Losing an entire day's screening
 * because a bookkeeping insert failed would trade the deliverable for its
 * receipt.
 */

import { childLogger } from "../../infra/logger.js";
import { recordIngestRun } from "../../db/job-run-queries.js";
import { estimateQueryCost, toLedgerAmount, type ApifyPlan, type FeedPricing } from "./cost.js";
import type { IngestLine } from "./ingest.js";

const log = childLogger({ module: "jobhunt:ingest-ledger" });

export interface LedgerEntry {
  readonly sweepId: string;
  readonly feed: "ats" | "indeed";
  readonly pool: string;
  readonly track: string;
  readonly requested: number;
  readonly returned: number;
  readonly pricing: Readonly<Record<ApifyPlan, FeedPricing>>;
  readonly lines?: readonly IngestLine[];
  readonly error?: string;
}

/** Count the verdicts one query produced, so a cost has a yield beside it. */
function tally(lines: readonly IngestLine[]): {
  screened: number;
  passed: number;
  flagged: number;
  rejected: number;
} {
  return {
    screened: lines.length,
    passed: lines.filter((l) => l.outcome === "pass").length,
    flagged: lines.filter((l) => l.outcome === "flag").length,
    rejected: lines.filter((l) => l.outcome === "reject").length,
  };
}

/** Write one query's cost and yield. Swallows its own failures, loudly logged. */
export async function recordQueryCost(entry: LedgerEntry): Promise<void> {
  const counts = tally(entry.lines ?? []);
  try {
    await recordIngestRun({
      tenant_id: "turicks",
      sweep_id: entry.sweepId,
      feed: entry.feed,
      pool: entry.pool,
      track: entry.track,
      requested: entry.requested,
      returned: entry.returned,
      ...counts,
      estimated_cost_usd: toLedgerAmount(estimateQueryCost(entry.pricing, entry.returned)),
      ...(entry.error ? { error: entry.error } : {}),
    });
  } catch (err) {
    // allow-failopen: the ledger is the receipt, the screening is the work. A
    // lost row understates one day's cost; a thrown error loses the whole sweep.
    log.warn(
      { feed: entry.feed, pool: entry.pool, track: entry.track, err: (err as Error).message },
      "Ingest cost ledger write failed",
    );
  }
}
