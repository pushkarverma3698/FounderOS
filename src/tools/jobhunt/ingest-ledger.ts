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
  // `free-ats` is the direct board-polling lane. It is billed at zero and still
  // writes a row: a free lane that logged nothing would be indistinguishable
  // from a free lane that stopped running.
  readonly feed: "ats" | "indeed" | "free-ats";
  readonly pool: string;
  readonly track: string;
  readonly requested: number;
  readonly returned: number;
  readonly pricing: Readonly<Record<ApifyPlan, FeedPricing>>;
  readonly lines?: readonly IngestLine[];
  readonly error?: string;
}

export interface IngestTally {
  readonly screened: number;
  readonly passed: number;
  readonly flagged: number;
  readonly rejected: number;
  readonly duplicates: number;
  readonly errored: number;
  readonly fresh: number;
  /** The commonest screening error, or null when nothing errored. */
  readonly screenError: string | null;
}

/** The screening error that hit the most postings — the one worth reporting. */
function commonestError(lines: readonly IngestLine[]): string | null {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.outcome !== "error") continue;
    const detail = line.detail.trim() || "unspecified screening error";
    counts.set(detail, (counts.get(detail) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Count the verdicts one query produced, so a cost has a yield beside it.
 *
 * Every outcome is counted. The earlier version counted only pass/flag/reject
 * of the five `IngestLine.outcome` values, so `duplicate` and `error` lines
 * inflated `screened` and appeared nowhere else — and a sweep in which every
 * posting threw was recorded as "27 screened, 0, 0, 0", which is exactly what a
 * quiet market looks like. Four days of total screening failure read as bad
 * luck. The columns now sum to `screened`, so they cannot disagree silently.
 */
export function tally(lines: readonly IngestLine[]): IngestTally {
  return {
    screened: lines.length,
    passed: lines.filter((l) => l.outcome === "pass").length,
    flagged: lines.filter((l) => l.outcome === "flag").length,
    rejected: lines.filter((l) => l.outcome === "reject").length,
    duplicates: lines.filter((l) => l.outcome === "duplicate").length,
    errored: lines.filter((l) => l.outcome === "error").length,
    // The yield that decides whether this query is worth running again. Every
    // other count here goes up when the feed re-sells us yesterday's postings.
    fresh: lines.filter((l) => l.isNew).length,
    // Kept because it was already on the line and thrown away. Not persisting
    // it is why the outage needed a code audit instead of a SQL query.
    screenError: commonestError(lines),
  };
}

/** Write one query's cost and yield. Swallows its own failures, loudly logged. */
export async function recordQueryCost(entry: LedgerEntry): Promise<void> {
  const { screenError, ...counts } = tally(entry.lines ?? []);

  // Screening failures are logged as an ERROR before anything else can go wrong
  // with the write. A query that reached the gates and failed every posting is
  // a broken pipeline, not a thin market, and it must be visible in journalctl
  // without a database to hand.
  if (counts.errored > 0) {
    log.error(
      {
        feed: entry.feed,
        pool: entry.pool,
        track: entry.track,
        errored: counts.errored,
        screened: counts.screened,
        cause: screenError,
      },
      counts.errored === counts.screened
        ? "EVERY posting failed to screen — the gates are broken, not the market"
        : "Some postings failed to screen",
    );
  }

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
      ...(screenError ? { screen_error: screenError } : {}),
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
