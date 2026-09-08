/**
 * FounderOS — daily brief assembly
 * ================================
 * The impure half of the brief: DB reads, CV reads, liveness verification.
 * Rendering lives in brief.ts and stays pure, so the whole layout is testable
 * without any of this.
 *
 * The brief is built from the DATABASE, not from the sweep's in-memory results.
 * That is deliberate: a role screened four days ago and still undrafted is
 * exactly what the founder needs to see, and a sweep-local view would show only
 * today's catch and quietly forget the backlog it was supposed to nag about.
 */

import { childLogger } from "../../infra/logger.js";
import { intEnv } from "../../core/config.js";
import { recordLiveness, type QueueAxis } from "../../db/job-queries.js";
import { inScope, loadBriefQueue, scopeMayBeIncomplete, todaysSpend } from "./brief-queue.js";
import { compareOverlap, overlapScore, type OverlapResult } from "./overlap.js";
import { loadTrackCvs, UNCLASSIFIED_TRACK } from "./brief-cv.js";
import { buildTrends } from "./brief-trends.js";
import { verifyLiveness, type Liveness } from "./liveness.js";
import { toBriefRow, toLiveness } from "./brief-assemble.js";
import {
  attachBriefRanks,
  briefRankEntries,
  persistBriefRanks,
  persistFitScores,
} from "./brief-persist.js";
import {
  formatDailyBrief,
  type BriefInput,
  type BriefRow,
  type TrendRow,
} from "./brief.js";
import type { JobApplication } from "../../db/schema.js";
import { getProfile, type JobSearchProfile } from "./profile-config.js";

const log = childLogger({ module: "jobhunt:daily-brief" });

// Re-exported so the brief keeps one import site, and so the existing CV tests
// (cv-missing-loud, cv-track) keep pointing at the same module surface.
export { loadTrackCvs, UNCLASSIFIED_TRACK } from "./brief-cv.js";

/**
 * How many top-ranked rows to spend a liveness check on.
 *
 * Verification is cheap but not free, and it only changes a decision near the
 * top of the list. Checking rank 40 buys nothing the founder will read today.
 *
 * MEASURED, 2026-08-06: of 34 rows stored in production, liveness was
 * `unknown` on 21, `unverifiable` on 5, and `live` on 8 — exactly the 8 a
 * budget of 8 ever checked, and all 8 came back live. The budget was the
 * binding constraint on APPLY TODAY, not the market and not the gates:
 * `selectDoToday` (brief.ts) only admits `pass && live`, so every row this
 * budget left unchecked was invisible to that section no matter how strong
 * its overlap or how genuinely open the role was.
 *
 * Raised from 8 to 25 only once `verifyLiveness` (liveness.ts) stopped
 * checking URLs strictly sequentially — at ~10s worst case per check, 25
 * sequential checks risked ~250s of wall time against the sweep's own
 * timeout. Checked through a bounded pool instead, the wider budget is safe.
 * `verificationTargets` below already spends every PASS before any FLAG, so
 * the extra headroom goes to flags once every pass is covered.
 *
 * RAISED AGAIN, 25 → 60, ON 2026-08-24. `APPLY_QUEUE_MAX_AGE_HOURS` moved to
 * 168 and back to 24 the same day (see its own comment in job-queries.ts); this
 * budget did not move back with it, because the two are coupled in only ONE
 * direction: `isDoTodayRow` admits only `pass && live`, so whichever of the
 * window's pool and this budget is smaller is the real size of APPLY TODAY. A
 * budget bigger than the pool costs nothing — it simply checks everything the
 * window returns. Measured immediately after the board registry grew 923 →
 * 1,297 (#559), 24h alone held 37 actionable rows, comfortably inside 60; the
 * headroom is there for whatever a bigger sweep finds tomorrow.
 *
 * `URL_CHECK_CONCURRENCY` stays at 6. Raising it would shorten the worst case,
 * but its 6 is not arbitrary — liveness.ts argues it from same-host bursts,
 * since one ATS host serves many companies and a burst at one host turns a live
 * posting into `unverifiable`, which defeats the check. At 6, sixty targets is
 * ~15s typically and ~100s only if every host times out, which is itself an
 * outage rather than a slow day.
 */
export const VERIFY_TOP_N = intEnv("VERIFY_TOP_N", 60);

// The queue read — its limit, its verdict set and the two counts that describe
// it — moved to brief-queue.ts on 2026-09-08, when A2 pushed this file past its
// 400-line budget. Re-exported so existing import sites keep resolving here.
export { BRIEF_QUEUE_LIMIT, BRIEF_VERDICTS, loadBriefQueue } from "./brief-queue.js";

// Re-exported: liveness-unknown.test.ts and anything else that imports
// `toLiveness` from this module keeps resolving after the move.
export { toLiveness, toBriefRow } from "./brief-assemble.js";

/**
 * How many whole days ago the EMPLOYER published a row.
 *
 * `posted_at` falling back to `created_at` — the same coalesce
 * `applyQueueFreshnessSql` filters on, so the order and the window agree about
 * what "old" means. A posting the founder pasted himself carries no `posted_at`
 * and is as fresh as the minute he found it, which is the truth about it.
 *
 * DAY GRANULARITY, not minutes. Minute-level freshness would make the ranking a
 * reverse-chronological list and throw away CV overlap entirely; day buckets put
 * today's roles above last week's and let the match decide inside a day.
 */
function publishedDaysAgo(row: JobApplication, now: Date): number {
  const at = row.posted_at ?? row.created_at;
  if (!at) return 0;
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));
}

/**
 * Rank the actionable pool: freshest day first, best CV overlap inside a day.
 *
 * FRESHNESS LEADS, since 2026-09-08 (founder decision). `/jobs` carries no age
 * limit now, and overlap alone over an unbounded population fills APPLY TODAY's
 * six slots with whatever matches the CV best across all time — which is the
 * "442 standing vs 35 fresh" brief rejected on 2026-09-07. Ordering by
 * publication day first keeps the lifted limit from costing what the limit was
 * protecting: the reach is there, and today's roles are still on top.
 *
 * For the founder's own lane this changes almost nothing — his 24h window
 * already holds 166 rows, so nearly everything sits in the day-0 bucket and
 * overlap decides as it always has. It matters for the wider view and for the
 * low-supply lane, where a fortnight of roles is one list.
 *
 * A row whose track has no readable CV scores zero overlap rather than being
 * dropped. It still appears, just not at the top — losing an opportunity because
 * a file was missing would be a silent failure caused by our own configuration.
 */
export function rankRows(
  applications: readonly JobApplication[],
  cvs: ReadonlyMap<string, string>,
  now: Date,
  profile: JobSearchProfile = getProfile(),
): Array<{ row: JobApplication; overlap: OverlapResult }> {
  const scored = applications.map((row) => ({
    row,
    overlap: overlapScore(row.description ?? "", cvs.get(row.track) ?? "", profile.skillsDictionaryName),
    freshness: publishedDaysAgo(row, now),
  }));
  scored.sort((a, b) => a.freshness - b.freshness || compareOverlap(a.overlap, b.overlap));
  log.debug({ ranked: scored.length, now: now.toISOString() }, "Brief rows ranked");
  return scored.map(({ row, overlap }) => ({ row, overlap }));
}

/**
 * How much a verdict benefits from being verified. Lower sorts first.
 *
 * A PASS is the only verdict that can become an application today, so it is the
 * only one whose liveness changes what the founder does in the next hour. A FLAG
 * is one answer away and still worth verifying. A REJECT is a legal bar — its
 * being open or closed changes nothing.
 */
const VERIFY_PRIORITY: Record<string, number> = { pass: 0, flag: 1 };

/**
 * Choose which rows spend the liveness budget.
 *
 * Ranking by overlap alone is the right ORDER to read the brief in and the wrong
 * order to verify in. On 2026-07-31 the top 8 rows by overlap were all flags;
 * every pass ended the run unverified, and DO TODAY reported 0 while five roles
 * sat in the database having cleared every gate.
 */
export function verificationTargets<T extends { row: { salary_status: string }; overlap: OverlapResult }>(
  scored: readonly T[],
  budget: number,
): T[] {
  return scored
    .filter((s) => s.row.salary_status in VERIFY_PRIORITY)
    .sort((a, b) => {
      const byVerdict =
        VERIFY_PRIORITY[a.row.salary_status]! - VERIFY_PRIORITY[b.row.salary_status]!;
      return byVerdict !== 0 ? byVerdict : compareOverlap(a.overlap, b.overlap);
    })
    .slice(0, budget);
}

export interface BriefOptions {
  readonly screened?: number;
  readonly failures?: readonly string[];
  /** Rows the feeds filtered on purpose. Reported separately from failures. */
  readonly notes?: readonly string[];
  readonly now?: Date;
  /** Skip network liveness checks — used by tests and by a $0 dry run. */
  readonly skipLiveness?: boolean;
  /**
   * Which candidate profile to build the brief for. Defaults to Pushkar's
   * profile. Without this, every profile's brief read Pushkar's CVs and tech
   * skills, and ranking wrote over the shared (un-scoped) brief_rank column.
   */
  readonly profile?: JobSearchProfile;
  /**
   * WHICH SLICE OF THE RANKED QUEUE TO PRINT. Omitted = all of it (`/jobs`).
   *
   * A DISPLAY FILTER, never a second query. The queue is read once, unbounded,
   * and ranked once, so `/jobs`, `/today` and `/fresh` all address rows by the
   * same `brief_rank` — see BriefRow.rank for what a per-verb ranking would cost.
   */
  readonly scope?: BriefDisplayScope;
}

export interface BriefDisplayScope {
  readonly windowHours?: number | null;
  /** An absolute cutoff — `/fresh`'s "since you last looked", not a range. */
  readonly since?: Date | undefined;
  readonly axis?: QueueAxis;
  /** How the header names this slice: "posted in the last 24h", "everything on file". */
  readonly label?: string;
}

/**
 * Build the brief: read → rank → verify → number → filter → render.
 *
 * Liveness runs AFTER ranking and only on the top slice, so the check lands
 * exactly where a wrong answer is most expensive and nowhere it would be waste.
 * With fresh-first ranking that slice is the freshest rows, which is also where
 * "is it still open?" changes an answer.
 *
 * NUMBERING IS PINNED BEFORE FILTERING, deliberately. The rank belongs to the
 * whole queue; the scope only decides how much of it this message shows.
 */
export async function buildDailyBrief(opts: BriefOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const profile = opts.profile ?? getProfile();
  const scope = opts.scope ?? {};
  const { applications, queued, agedOut, maxAgeHours } = await loadBriefQueue(profile);
  const { cvs, unreadable } = loadTrackCvs(profile);
  const scored = rankRows(applications, cvs, now, profile);

  const liveness = new Map<string, Liveness>();
  if (!opts.skipLiveness && scored.length > 0) {
    const targets = verificationTargets(scored, VERIFY_TOP_N).map(({ row }) => ({
      id: row.id,
      url: row.url,
      source: row.source,
      externalId: row.external_id,
    }));
    const results = await verifyLiveness(targets);
    for (const result of results) {
      liveness.set(result.id, result.liveness);
      try {
        await recordLiveness(result.id, result.liveness, { reason: result.reason });
      } catch (err) {
        // allow-failopen: a lost liveness write must not cost the founder the
        // brief. The verdict is still shown; only the persistence is lost.
        log.warn({ id: result.id, err: (err as Error).message }, "Liveness write failed");
      }
    }
  }

  // RANKED OVER THE WHOLE QUEUE, then numbered, then filtered. The three steps
  // are in this order so a row's number is a property of the queue rather than
  // of whichever verb happened to print it.
  const allRows: BriefRow[] = scored.map(({ row, overlap }) => toBriefRow(row, overlap, now, liveness));
  const rankEntries = briefRankEntries(allRows);
  const numbered = attachBriefRanks(allRows, rankEntries);

  const visible = new Set(
    scored.filter(({ row }) => inScope(row, scope, now)).map(({ row }) => row.id),
  );
  const rows = numbered.filter((row) => visible.has(row.id));

  // Per-track counts describe WHAT IS SHOWN. Counting the whole queue under a
  // header that prints a slice of it is the "same number, two nouns" defect A3
  // closed one line above.
  const perTrack: Record<string, number> = {};
  for (const row of rows) perTrack[row.track] = (perTrack[row.track] ?? 0) + 1;

  // Reverted 2026-09-07 (founder decision): back to a strict 24h window. The
  // standing pool (postings older than APPLY_QUEUE_MAX_AGE_HOURS, kept alive up
  // to STANDING_LIVENESS_MAX_HOURS as long as re-verified live) was the
  // 2026-09-01 "reach fix" — it kept good roles visible instead of discarding
  // them at 24h, but it also meant the brief was dominated by old roles (442
  // standing vs 35 fresh for one profile) rather than reading as "today's fresh
  // finds". The founder chose fresh-only over reach. `listStandingApplications`,
  // `selectStanding`/`orderStanding` (brief-select.ts) and the STANDING render
  // block (brief.ts) are now dead code, left in place rather than torn out —
  // this call site is the only thing that fed them.
  const standingRows: BriefRow[] = [];
  const standingScored: Array<{ row: JobApplication; overlap: OverlapResult }> = [];

  // An unreadable CV is not a cosmetic warning: it zeroes every overlap score
  // for that track, so the ranking stops being a ranking. It belongs with the
  // source failures, where the brief already says the numbers are a floor.
  const cvFailure =
    unreadable.length > 0
      ? [
          `CV unreadable for ${unreadable.join(", ")} — every overlap score on ` +
            "those tracks is 0, so their order in this brief is arbitrary. " +
            "Set PERSONAL_CV_DIR or restore the file.",
        ]
      : [];

  // Untracked rows are compared against the master CV rather than a tailored
  // one, which is a weaker comparison than the ranking implies. Said out loud,
  // because a number that is quietly less trustworthy than it looks is the kind
  // of thing that gets acted on for weeks.
  // A narrow verb cannot see past the read's horizon, and unlike `/jobs` it
  // gets no header cut notice. Reported as a FAILURE line rather than a note,
  // because that block already carries the right sentence — "today's numbers are
  // a floor, not a measurement" — and this is exactly that situation.
  const truncationNote = scopeMayBeIncomplete(applications, queued, scope, now)
    ? [
        `This list was drawn from the newest ${applications.length} of ${queued} rows in your ` +
          `queue, and it asks about a window older than the oldest of those. Roles inside the ` +
          `window may be missing from it. Send /csv for the whole queue, or raise ` +
          `BRIEF_QUEUE_LIMIT.`,
      ]
    : [];

  const untracked = rows.filter((row) => row.track === UNCLASSIFIED_TRACK).length;
  const untrackedNote =
    untracked > 0
      ? [
          `${untracked} row(s) have no track — their title matched none of the ` +
            `searched roles, or they were screened before tracks existed. They are ` +
            `ranked against the master CV, not a tailored one.`,
        ]
      : [];

  const spend = await todaysSpend(now);

  const input: BriefInput = {
    date: now,
    // NO FALLBACK TO `applications.length` (A3, 2026-09-08). That default is
    // what printed the apply-queue size under the word "screened" on every
    // typed /jobs — a claim about the machine made from a number about the
    // founder's queue. Undefined omits the line; only a caller that ran a sweep
    // knows this figure.
    ...(opts.screened === undefined ? {} : { screened: opts.screened }),
    // The uncapped total describes THE SAME POPULATION the rows do. Under a
    // scope the rows are a filtered slice, so the queue count is the slice's
    // own size and a cut notice would be about a cut that did not happen.
    ...(queued === undefined || rows.length !== allRows.length ? {} : { queued }),
    perTrack,
    rows,
    standing: standingRows,
    trends: await buildTrends(cvs, now, profile),
    failures: [...(opts.failures ?? []), ...truncationNote, ...cvFailure, ...untrackedNote],
    notes: opts.notes ?? [],
    agedOut,
    // What THIS list excluded, measured on the ranked population rather than on
    // the read. `/today` showing 166 of 500 owes the founder the other 334.
    outsideScope: allRows.length - rows.length,
    maxAgeHours: scope.windowHours ?? (scope.since ? null : maxAgeHours),
    // What this list EXCLUDED, in words. UX rule 2 of the fresh-first plan: a
    // list that does not name its own scope is the T-2 defect again — the
    // founder cannot tell an empty market from a narrow window.
    ...(scope.label ? { scopeLabel: scope.label } : {}),
    // WHOSE brief. The legend quotes this candidate's years, salary criterion,
    // permit bases and markets — and printed the founder's on everyone's until
    // 2026-09-08, because `GATE_GLOSSARY` was a module constant.
    profile,
    ...(spend ? { spend } : {}),
  };

  // Pin the numbering BEFORE returning the text, and pin it over `allRows` —
  // the whole ranked queue, NOT the scoped slice this message prints.
  //
  // The scoped slice is what `/today` and `/fresh` show; the rank is what
  // `/draft` resolves. If a narrow verb persisted its own numbering, running
  // `/fresh` would renumber the founder's entire queue from 1 and every number
  // in the `/jobs` message still on his screen would point at a different
  // company. Same numbering source as the rows carry (`attachBriefRanks`
  // consumed these identical entries above), so printed number and pinned rank
  // agree by construction rather than by two functions computing the same thing.
  await persistBriefRanks(allRows, standingRows, {
    profileId: profile.id,
    entries: rankEntries,
  });
  await persistFitScores([...scored, ...standingScored]);

  return formatDailyBrief(input);
}

// `job_brief` — the English surface — moved to brief-tool.ts on 2026-09-08,
// when the B-block scope plumbing pushed this file past its 400-line budget.
// Re-exported so kernel-boot and every existing import site keep resolving here.
export { jobBriefTool } from "./brief-tool.js";
