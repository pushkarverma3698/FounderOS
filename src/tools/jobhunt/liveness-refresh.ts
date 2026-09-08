/**
 * FounderOS — re-check posting liveness before a file goes out
 * =============================================================
 * WHY THIS EXISTS. Until 2026-09-09 the liveness column was written by exactly
 * one caller: `buildDailyBrief`, on the top `VERIFY_TOP_N` rows of the ranked
 * queue. Every CSV path — `/csv`, `/csv all`, `export_jobs_csv` — read that
 * column and rendered it without ever checking anything.
 *
 * Measured on prod the day this was written:
 *
 *   pushkar-nl-tech   unknown 856 · live 785 · unverifiable 36 · expired 19
 *   wife-nl-finance   unknown  38 · live  78 · unverifiable  1 · expired  1
 *
 * So a CSV of the whole log handed the founder 894 rows whose "Still open?"
 * cell read "not checked" — while presenting itself as the file you apply
 * from. Founder's instruction, 2026-09-09: *"All the apply links should be
 * verified both in telegram messages and the CSV."*
 *
 * WHAT IT DOES NOT DO. It does not verify every row, and it does not pretend
 * to. A CSV can hold 1,700 rows; each check is a real HTTP GET with a 10s
 * timeout against a third-party ATS. The budget is explicit (`CSV_VERIFY_MAX`),
 * the rows that got skipped keep their stored value, and the caller is handed
 * the counts so the caption can say which is which. A file that silently
 * verified 150 of 1,700 and said nothing would be the same defect one layer
 * down.
 *
 * ORDER MATTERS. Rows are spent freshest-first, because that is the slice the
 * founder applies from and the slice where "is it still open" changes an
 * answer. A role published five weeks ago is not where the budget belongs.
 */

import { intEnv } from "../../core/config.js";
import { recordLiveness } from "../../db/job-queries.js";
import type { JobApplication } from "../../db/schema.js";
import { childLogger } from "../../infra/logger.js";
import { verifyLiveness, type Liveness } from "./liveness.js";

const log = childLogger({ module: "jobhunt:liveness-refresh" });

/**
 * How many rows one file may spend a network check on.
 *
 * 150 at `URL_CHECK_CONCURRENCY` 6 is ~25 rounds; against a 10s worst-case
 * timeout that is a bounded wait rather than an open one, and in practice most
 * ATS hosts answer in well under a second. Raise it via env when a slower,
 * more complete file is worth the wait.
 */
export const CSV_VERIFY_MAX = intEnv("CSV_VERIFY_MAX", 150);

/**
 * How old a check may be and still count as current.
 *
 * A posting that was open yesterday is usually open today, and re-checking it
 * spends budget that an unchecked row needs more. 24h matches the freshness
 * window the brief itself is built around.
 */
export const LIVENESS_STALE_HOURS = intEnv("LIVENESS_STALE_HOURS", 24);

export interface RefreshOutcome {
  /** The same rows, with `liveness`/`liveness_checked_at` updated where checked. */
  readonly rows: readonly JobApplication[];
  /** How many rows were actually checked over the network this call. */
  readonly verified: number;
  /** How many wanted a check but were past the budget. */
  readonly skipped: number;
  /** How many already carried a check inside `LIVENESS_STALE_HOURS`. */
  readonly alreadyFresh: number;
}

/**
 * Does this row's stored verdict still count?
 *
 * `unknown` never counts, whatever the timestamp says — it is the value a row
 * carries when nothing has ever looked at it.
 */
export function needsRecheck(row: JobApplication, now: Date, staleHours: number): boolean {
  if (row.liveness === "unknown" || row.liveness === null) return true;
  if (!row.liveness_checked_at) return true;
  const ageHours = (now.getTime() - row.liveness_checked_at.getTime()) / 3_600_000;
  return ageHours > staleHours;
}

/**
 * Freshest first, by publication date, with never-published rows last.
 *
 * `posted_at` and not `created_at`: the budget belongs on what the market
 * published recently, not on what we happened to store recently. A row
 * backfilled today from a five-week-old posting is not where a liveness check
 * earns its cost.
 */
function freshestFirst(a: JobApplication, b: JobApplication): number {
  const aTime = a.posted_at?.getTime() ?? 0;
  const bTime = b.posted_at?.getTime() ?? 0;
  return bTime - aTime;
}

/**
 * Re-check the rows whose verdict is stale, newest first, within budget.
 *
 * NEVER THROWS. A file the founder asked for must not be lost because an ATS
 * host timed out — the rows still render, carrying whatever the database last
 * knew, and `verified`/`skipped` tell the caller what to say about it.
 */
export async function refreshLiveness(
  rows: readonly JobApplication[],
  opts: { now?: Date; budget?: number; staleHours?: number } = {},
): Promise<RefreshOutcome> {
  const now = opts.now ?? new Date();
  const budget = opts.budget ?? CSV_VERIFY_MAX;
  const staleHours = opts.staleHours ?? LIVENESS_STALE_HOURS;

  const stale = rows.filter((r) => needsRecheck(r, now, staleHours));
  const alreadyFresh = rows.length - stale.length;
  const targets = [...stale].sort(freshestFirst).slice(0, budget);

  if (targets.length === 0) {
    return { rows, verified: 0, skipped: 0, alreadyFresh };
  }

  let results: Awaited<ReturnType<typeof verifyLiveness>>;
  try {
    results = await verifyLiveness(
      targets.map((r) => ({ id: r.id, url: r.url, source: r.source, externalId: r.external_id })),
    );
  } catch (err) {
    // allow-failopen: the file is the deliverable. A verification outage must
    // degrade to "we could not re-check these", never to no file at all.
    log.warn({ err: (err as Error).message, targets: targets.length }, "Liveness refresh failed");
    return { rows, verified: 0, skipped: stale.length, alreadyFresh };
  }

  const byId = new Map<string, Liveness>(results.map((r) => [r.id, r.liveness]));

  for (const result of results) {
    try {
      await recordLiveness(result.id, result.liveness, { reason: result.reason, checkedAt: now });
    } catch (err) {
      // allow-failopen: a lost write costs the next caller one re-check. The
      // verdict is already in `byId` and renders correctly in this file.
      log.warn({ id: result.id, err: (err as Error).message }, "Liveness write failed");
    }
  }

  // A NEW ARRAY OF NEW OBJECTS. The caller's rows came from drizzle and may be
  // rendered again elsewhere in the same request; mutating them in place would
  // make the file's contents depend on call order.
  const updated = rows.map((row) => {
    const liveness = byId.get(row.id);
    return liveness ? { ...row, liveness, liveness_checked_at: now } : row;
  });

  log.info(
    { rows: rows.length, verified: results.length, skipped: stale.length - results.length, alreadyFresh },
    "Liveness refreshed for export",
  );

  return {
    rows: updated,
    verified: results.length,
    skipped: stale.length - results.length,
    alreadyFresh,
  };
}
