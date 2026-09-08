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
  queueWindowFor,
} from "../../db/job-queries.js";
import type { JobApplication } from "../../db/schema.js";
import type { JobSearchProfile } from "./profile-config.js";

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

export interface BriefQueue {
  readonly applications: JobApplication[];
  /** Rows qualifying inside the window, UNCAPPED. Undefined when the count failed. */
  readonly queued: number | undefined;
  /** Otherwise-actionable rows excluded for age. 0 when the count failed. */
  readonly agedOut: number;
  /** The window this queue was read against, in hours. */
  readonly maxAgeHours: number;
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
  opts: { maxAgeHours?: number; limit?: number } = {},
): Promise<BriefQueue> {
  const maxAgeHours = opts.maxAgeHours ?? queueWindowFor(profile);
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
