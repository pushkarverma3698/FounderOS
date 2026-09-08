/**
 * FounderOS — reading the queue a brief is built from
 * ===================================================
 * Split out of daily-brief.ts on 2026-09-08, when the A2 fix (an explicit read
 * limit plus the uncapped total that makes a cut visible) pushed that file past
 * its 400-line CI budget. Same precedent as brief-cv.ts, brief-trends.ts,
 * brief-persist.ts and brief-assemble.ts before it.
 *
 * ONE PLACE DECIDES WHICH ROWS A BRIEF IS ABOUT. Three counts have to agree or
 * the header lies about itself — what was loaded, what qualified, and what fell
 * out for age — and they can only be guaranteed to agree if one function issues
 * all three against one scope object. Until this existed, `buildDailyBrief`
 * passed no limit and inherited the query's own default of 100 while counting
 * nothing, so a 166-row queue rendered as a complete 100-row brief.
 */

import { childLogger } from "../../infra/logger.js";
import { intEnv } from "../../core/config.js";
import {
  listActionableApplications,
  countActionableApplications,
  countAgedOutApplications,
  type QueueAxis,
} from "../../db/job-queries.js";
import type { JobApplication } from "../../db/schema.js";
import type { JobSearchProfile } from "./profile-config.js";
import { summariseSpend } from "../../db/job-run-queries.js";
import { SPEND_WINDOW_DAYS, type SpendLine } from "./brief-sections.js";

const log = childLogger({ module: "jobhunt:brief-queue" });

/**
 * How many actionable rows one brief reads out of the database.
 *
 * MEASURED, 2026-09-08: `listActionableApplications` defaults to `.limit(100)`
 * and `buildDailyBrief` passed no limit at all. Pushkar had 166 rows qualifying
 * inside his 24h window. The brief loaded the newest 100 and the other 66 were
 * not merely unprinted — `persistBriefRanks` only pins ranks for rows it was
 * handed, and `/draft` plus `mac-client/sync.py` both resolve against
 * `brief_rank`, so an unloaded row is unaddressable by every surface the
 * founder has. Sixty-six fresh roles, invisible, under a line reading "Nothing
 * is cut — read to the end".
 *
 * 500, not "no limit". An unbounded read is how one bad day (a board that
 * backfills ten thousand postings) turns a Telegram message into an OOM, and
 * the bound is what makes the header's "showing N of M" line meaningful. The
 * cost of the wider read is CPU only: ranking is pure overlap scoring, and the
 * network spend — liveness — is separately capped at VERIFY_TOP_N.
 *
 * Wider than Tashi's 14-day window can plausibly hold (118 rows lifetime) and
 * 3× Pushkar's worst measured day, so in practice it never bites; when it does,
 * the founder is told rather than left to discover it.
 */
export const BRIEF_QUEUE_LIMIT = intEnv("BRIEF_QUEUE_LIMIT", 500);

/**
 * REJECTS ARE READ BACK TOO (founder direction, 2026-08-01: "store all the data
 * we are collecting even if it is senior and of no use to us"). The brief has
 * always had a NOT LAWFUL section and it was always empty, because this query
 * defaulted to pass+flag — so the roles the pipeline threw away on the founder's
 * behalf were invisible to him, which is the whole complaint. They cost nothing
 * to show: one line each, and `verificationTargets` still refuses to spend the
 * liveness budget on them.
 */
export const BRIEF_VERDICTS = ["pass", "flag", "reject"] as const;

/**
 * The date a window is measured against, for ONE row.
 *
 * The JS twin of `windowCondition` in job-queries.ts, and the only other place
 * that decides what "old" means. Two copies of a predicate drift — that is
 * exactly what `applyQueueFreshnessSql`'s own comment warns about — so this one
 * exists for a reason the SQL cannot serve: the ranking population is read ONCE,
 * unbounded, so that every verb shares one numbering, and the per-verb display
 * filter then has to run over rows already in memory. Re-querying per verb would
 * rank a different population per verb, which is the defect B5 exists to close.
 *
 * `posted` coalesces to `created_at` exactly as the SQL does. `found` is
 * `created_at` alone, because "when did we first see it" has no fallback.
 */
export function windowDateOf(
  row: Pick<JobApplication, "posted_at" | "created_at">,
  axis: QueueAxis,
): Date | null {
  return axis === "found" ? row.created_at : (row.posted_at ?? row.created_at);
}

/**
 * The absolute cutoff a scope resolves to, or null when it has none.
 *
 * One place computes it, so `inScope` and the truncation check below can never
 * disagree about where a scope's boundary is.
 */
export function scopeCutoff(
  scope: { windowHours?: number | null; since?: Date | undefined },
  now: Date,
): Date | null {
  if (scope.since) return scope.since;
  if (scope.windowHours === null || scope.windowHours === undefined) return null;
  return new Date(now.getTime() - scope.windowHours * 3_600_000);
}

/**
 * Whether the read limit could have hidden rows this scope asked for.
 *
 * THE SILENT LOSS THIS CLOSES. Since 2026-09-08 the queue is read ONCE and
 * unbounded (so every verb shares one numbering) and then filtered in memory.
 * That read is capped at BRIEF_QUEUE_LIMIT and ordered `created_at DESC`, so it
 * sees back only as far as the oldest row it returned. A narrow scope whose
 * cutoff reaches PAST that horizon is asking about rows the read never loaded —
 * and, unlike `/jobs`, it gets no header cut notice, because under a scope the
 * displayed count and the queue total describe different populations.
 *
 * MEASURED ON PROD, 2026-09-08: 1,676 actionable rows for the founder against a
 * 500-row read, so the read IS truncated — and 345 rows were created in the last
 * 24h, with the oldest 24h-fresh row at position 339. Complete today, at 69% of
 * the limit. This function is what makes the day it stops being complete loud
 * instead of silent.
 *
 * Returns false when the read was not truncated at all: everything is loaded, so
 * no scope can miss anything.
 */
export function scopeMayBeIncomplete(
  loaded: ReadonlyArray<Pick<JobApplication, "created_at">>,
  totalQualifying: number | undefined,
  scope: { windowHours?: number | null; since?: Date | undefined },
  now: Date,
): boolean {
  if (totalQualifying === undefined || totalQualifying <= loaded.length) return false;
  const cutoff = scopeCutoff(scope, now);
  if (cutoff === null) return false;
  const horizon = loaded.reduce<Date | null>(
    (oldest, row) => (row.created_at && (!oldest || row.created_at < oldest) ? row.created_at : oldest),
    null,
  );
  return horizon !== null && cutoff.getTime() < horizon.getTime();
}

/** Whether one row falls inside a display scope. Pure; `now` is passed. */
export function inScope(
  row: Pick<JobApplication, "posted_at" | "created_at">,
  scope: { windowHours?: number | null; since?: Date | undefined; axis?: QueueAxis },
  now: Date,
): boolean {
  const cutoff =
    scope.since ??
    (scope.windowHours === null || scope.windowHours === undefined
      ? null
      : new Date(now.getTime() - scope.windowHours * 3_600_000));
  if (cutoff === null) return true;
  const at = windowDateOf(row, scope.axis ?? "posted");
  // A row with neither date is kept, for the same reason the SQL coalesce keeps
  // it: an unknown timestamp is not evidence of age, and dropping it would hide
  // a row nobody can prove is stale.
  return at === null || at.getTime() >= cutoff.getTime();
}

export interface BriefQueue {
  readonly applications: JobApplication[];
  /** Rows qualifying inside the window, UNCAPPED. Undefined when the count failed. */
  readonly queued: number | undefined;
  /** Otherwise-actionable rows excluded for age. 0 when the window is unbounded. */
  readonly agedOut: number;
  /** The window this queue was read against, in hours, or null when unbounded. */
  readonly maxAgeHours: number | null;
}

/**
 * Read one candidate's actionable queue, plus the two counts that describe it.
 *
 * `profileId` scoping is what keeps one candidate's brief from mixing in the
 * other's — `listActionableApplications` filters by tenant alone when it is
 * omitted, so every multi-profile caller must pass it.
 *
 * WHOSE window. A single global here capped the second candidate's brief at her
 * market's daily publication rate — see `queueWindowFor`.
 *
 * Both counts fail open, and both fail toward SILENCE rather than toward a
 * claim: a lost aged-out count reads as 0, and a lost total leaves `queued`
 * undefined, which the header renders as "nothing to report about a cut" — not
 * as a cut of unknown size. Losing the whole brief over a count query would
 * trade the shortlist for a footnote.
 */
export async function loadBriefQueue(
  profile: JobSearchProfile,
  opts: { maxAgeHours?: number | null; limit?: number } = {},
): Promise<BriefQueue> {
  // UNBOUNDED BY DEFAULT, since 2026-09-08. One ranking population for every
  // verb is what makes `/draft 3` mean the same row after `/jobs`, `/today` and
  // `/fresh` — a per-verb population would renumber the queue on every command.
  // The verbs are DISPLAY filters over this one read (see `inScope`), not
  // separate queries. Fresh-first ordering (rankRows) is what makes the lifted
  // limit safe: reach without burying today's roles.
  const maxAgeHours = opts.maxAgeHours ?? null;
  const scope = {
    verdicts: BRIEF_VERDICTS,
    tenantId: profile.tenantId,
    profileId: profile.id,
    maxAgeHours,
  };

  // EXPLICIT LIMIT. The query's own default is 100 and passing none meant the
  // brief inherited it silently — see BRIEF_QUEUE_LIMIT for the 66 rows that
  // cost. `queued` below measures the same population without it, so the header
  // can state the gap instead of hiding it.
  const applications = await listActionableApplications({
    ...scope,
    limit: opts.limit ?? BRIEF_QUEUE_LIMIT,
  });

  let agedOut = 0;
  let queued: number | undefined;
  try {
    agedOut = await countAgedOutApplications(scope);
  } catch (err) {
    // allow-failopen: the freshness line is context, not the deliverable.
    log.warn({ err: (err as Error).message }, "Aged-out count unavailable — freshness line will read 0");
  }
  try {
    queued = await countActionableApplications(scope);
  } catch (err) {
    // allow-failopen: see the module note — an unmeasured total suppresses the
    // cut notice rather than inventing one.
    log.warn({ err: (err as Error).message }, "Queue total unavailable — cut notice suppressed");
  }

  return { applications, queued, agedOut, maxAgeHours };
}

/**
 * Today's feed spend, or nothing.
 *
 * Returns undefined rather than zero when the ledger cannot be read. "$0.00
 * spent today" is a claim, and a claim made because a query failed is the kind
 * of quiet wrongness that gets believed for a month.
 */
/**
 * TENANT-WIDE, not per candidate. `ai_call_costs`/`job_ingest_runs` carry no
 * profile column, so this is every lane's spend on one line in every lane's
 * brief. Harmless today — the metered sweep's cron was removed on 2026-08-21 and
 * the free lane records $0 — and it becomes a wrong number the day that cron
 * comes back. Recorded here rather than silently left as an implication.
 */
export async function todaysSpend(now: Date): Promise<SpendLine | undefined> {
  // SPEND_WINDOW_DAYS, not a literal 3 — the heading in brief-sections.ts reads
  // off the same constant. They were two independent numbers and the heading
  // said "WHAT TODAY COST" over a three-day sum for weeks (A4).
  const since = new Date(now.getTime() - SPEND_WINDOW_DAYS * 86_400_000);
  try {
    const window = await summariseSpend(since);
    return window.runs === 0
      ? undefined
      : {
          runs: window.runs,
          returned: window.returned,
          costUsd: window.costUsd,
          // `summariseSpend.failed` counts ledger rows with a non-null `error`.
          // Renamed at this boundary rather than in the query, because the query
          // is honest about the column it filters on; it was the RENDERER that
          // called those runs failed. See SpendLine.runsWithErrors.
          runsWithErrors: window.failed,
          fresh: window.fresh,
        };
  } catch (err) {
    // allow-failopen: the cost line is context, and losing the whole brief over
    // an unreadable ledger would trade the deliverable for a footnote.
    log.warn({ err: (err as Error).message }, "Spend summary unavailable — cost line omitted");
    return undefined;
  }
}
