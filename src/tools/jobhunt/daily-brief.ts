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
import {
  listActionableApplications,
  recordLiveness,
  recordBriefRanks,
  recordFitScores,
} from "../../db/job-queries.js";
import { summariseSpend } from "../../db/job-run-queries.js";
import { compareOverlap, overlapScore, formatOverlap, type OverlapResult } from "./overlap.js";
import { loadTrackCvs, UNCLASSIFIED_TRACK } from "./brief-cv.js";
import { parseGates } from "./gates.js";
import { toPostingCountry } from "./country.js";
import { buildTrends } from "./brief-trends.js";
import { verifyLiveness, type Liveness } from "./liveness.js";
import {
  formatDailyBrief,
  selectAskable,
  selectDoToday,
  type BriefInput,
  type BriefRow,
  type SpendLine,
  type TrendRow,
} from "./brief.js";
import type { JobApplication } from "../../db/schema.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "jobhunt:daily-brief" });

// Re-exported so the brief keeps one import site, and so the existing CV tests
// (cv-missing-loud, cv-track) keep pointing at the same module surface.
export { loadTrackCvs, UNCLASSIFIED_TRACK } from "./brief-cv.js";

/**
 * How many top-ranked rows to spend a liveness check on.
 *
 * Verification is cheap but not free, and it only changes a decision near the
 * top of the list. Checking rank 40 buys nothing the founder will read today.
 */
export const VERIFY_TOP_N = 8;

function ageInDays(from: Date | null | undefined, now: Date): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

/** The only values `Liveness` actually has. Anything else is not knowledge. */
const LIVENESS_VALUES: readonly string[] = ["live", "expired", "unverifiable"];

/**
 * Narrow a stored liveness string to the union, honestly.
 *
 * `row.liveness as Liveness` was an unchecked cast, and production carried
 * `"unknown"` — the column's own default — on every row. That value is outside
 * the union, so it reached the renderer and was displayed as "closed": the brief
 * announced that three live roles had shut, on the strength of a check that had
 * never run. Anything not positively one of the three collapses to
 * `unverifiable`, which is what "we don't know" is called here.
 */
export function toLiveness(value: unknown): Liveness {
  return typeof value === "string" && LIVENESS_VALUES.includes(value)
    ? (value as Liveness)
    : "unverifiable";
}

/**
 * Rank the actionable pool by stack overlap.
 *
 * A row whose track has no readable CV scores zero overlap rather than being
 * dropped. It still appears, just not at the top — losing an opportunity because
 * a file was missing would be a silent failure caused by our own configuration.
 */
export function rankRows(
  applications: readonly JobApplication[],
  cvs: ReadonlyMap<string, string>,
  now: Date,
): Array<{ row: JobApplication; overlap: OverlapResult }> {
  const scored = applications.map((row) => ({
    row,
    overlap: overlapScore(row.description ?? "", cvs.get(row.track) ?? ""),
  }));
  scored.sort((a, b) => compareOverlap(a.overlap, b.overlap));
  log.debug({ ranked: scored.length, now: now.toISOString() }, "Brief rows ranked");
  return scored;
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
}

/**
 * Build today's brief: read → rank → verify → render.
 *
 * Liveness runs AFTER ranking and only on the top slice, so the check lands
 * exactly where a wrong answer is most expensive and nowhere it would be waste.
 */
export async function buildDailyBrief(opts: BriefOptions = {}): Promise<string> {
  const now = opts.now ?? new Date();
  // REJECTS ARE READ BACK TOO (founder direction, 2026-08-01: "store all the data
  // we are collecting even if it is senior and of no use to us"). The brief has
  // always had a NOT LAWFUL section and it was always empty, because this query
  // defaulted to pass+flag — so the roles the pipeline threw away on the founder's
  // behalf were invisible to him, which is the whole complaint. They cost nothing
  // to show: one line each, and `verificationTargets` still refuses to spend the
  // liveness budget on them.
  const applications = await listActionableApplications({
    verdicts: ["pass", "flag", "reject"],
  });
  const { cvs, unreadable } = loadTrackCvs();
  const scored = rankRows(applications, cvs, now);

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

  const perTrack: Record<string, number> = {};
  for (const { row } of scored) perTrack[row.track] = (perTrack[row.track] ?? 0) + 1;

  const rows: BriefRow[] = scored.map(({ row, overlap }) => {
    const { gates, legacy } = parseGates(row);
    // A row verified in THIS run was checked seconds ago; anything else is as
    // old as its stored timestamp says, and the brief must not round that to
    // "today". Null when no check has ever run against it.
    const livenessAgeDays = liveness.has(row.id)
      ? 0
      : row.liveness_checked_at
        ? ageInDays(row.liveness_checked_at, now)
        : null;
    return {
      id: row.id,
      company: row.company,
      title: row.title,
      track: row.track,
      verdict: row.salary_status,
      route: row.route,
      // Read off the stored column, never re-derived. Rows screened before the
      // column existed carry NULL and come back `unknown`, which is the truth
      // about them — they were filed by a pipeline that recorded no country.
      country: toPostingCountry(row.country),
      location: row.location,
      url: row.url,
      overlap,
      liveness: liveness.get(row.id) ?? toLiveness(row.liveness),
      gates,
      legacyGates: legacy,
      ageDays: ageInDays(row.created_at, now),
      livenessAgeDays,
    };
  });

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
  const untracked = scored.filter(({ row }) => row.track === UNCLASSIFIED_TRACK).length;
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
    screened: opts.screened ?? applications.length,
    perTrack,
    rows,
    trends: await buildTrends(cvs, now),
    failures: [...(opts.failures ?? []), ...cvFailure, ...untrackedNote],
    notes: opts.notes ?? [],
    ...(spend ? { spend } : {}),
  };

  // Pin the numbering BEFORE returning the text. selectDoToday/selectAskable are
  // pure and get the same `rows`, so what is stored is exactly what is printed.
  // Deriving it again when /draft fires would retarget the command silently.
  await persistBriefRanks(rows);
  await persistFitScores(scored);

  return formatDailyBrief(input);
}

/**
 * Today's feed spend, or nothing.
 *
 * Returns undefined rather than zero when the ledger cannot be read. "$0.00
 * spent today" is a claim, and a claim made because a query failed is the kind
 * of quiet wrongness that gets believed for a month.
 */
async function todaysSpend(now: Date): Promise<SpendLine | undefined> {
  const since = new Date(now.getTime() - 86_400_000);
  try {
    const window = await summariseSpend(since);
    return window.runs === 0
      ? undefined
      : {
          runs: window.runs,
          returned: window.returned,
          costUsd: window.costUsd,
          failed: window.failed,
        };
  } catch (err) {
    // allow-failopen: the cost line is context, and losing the whole brief over
    // an unreadable ledger would trade the deliverable for a footnote.
    log.warn({ err: (err as Error).message }, "Spend summary unavailable — cost line omitted");
    return undefined;
  }
}

/**
 * Store the overlap the ranking just computed.
 *
 * `fit_score` and `fit_evidence` were declared when the table was created and
 * never written to, so the number was recomputed and discarded on every render
 * and no history of it exists anywhere. Written here because this is where the
 * TRACK's CV is already loaded.
 */
async function persistFitScores(
  scored: ReadonlyArray<{ row: JobApplication; overlap: OverlapResult }>,
): Promise<void> {
  try {
    await recordFitScores(
      scored.map(({ row, overlap }) => ({
        id: row.id,
        score: overlap.ratio,
        evidence:
          `${formatOverlap(overlap)} matched. ` +
          `Have: ${overlap.matched.join(", ") || "none"}. ` +
          `Missing: ${overlap.missing.join(", ") || "none"}.`,
      })),
    );
  } catch (err) {
    // allow-failopen: the score is history, the brief is the deliverable.
    log.warn({ err: (err as Error).message }, "Fit score persist failed");
  }
}

/**
 * Store which row the founder will read as "1", "2", "3" in each section.
 *
 * Failure here is tolerated but reported: the brief is still worth sending
 * without working handles, whereas throwing would lose the whole thing over the
 * numbering. The founder finds out because /draft says it cannot resolve the row
 * — never by drafting for the wrong company.
 */
async function persistBriefRanks(rows: readonly BriefRow[]): Promise<void> {
  const entries = [
    ...selectDoToday(rows).map((r, i) => ({ id: r.id, section: "do_today" as const, rank: i + 1 })),
    ...selectAskable(rows).map((r, i) => ({ id: r.id, section: "ask" as const, rank: i + 1 })),
  ];
  try {
    await recordBriefRanks(entries);
  } catch (err) {
    // allow-failopen: the brief itself is the deliverable. A lost rank makes
    // /draft say "I can't find row N", which is loud and recoverable.
    log.warn({ err: (err as Error).message }, "Brief rank persist failed — /draft handles stale");
  }
}

export const jobBriefTool: UnifiedTool = {
  name: "job_brief",
  description:
    "Show the ranked job brief: which screened roles to apply to TODAY, ordered by how " +
    "much of the posting's stack the CV already covers, each verified still open. Use when " +
    "the founder asks what to apply to, what's in the pipeline, what to do about jobs, or " +
    "for today's shortlist. Reads what ingest_jobs already screened — it does not fetch. " +
    "Read-only, no approval needed, no model spend.",
  input_schema: {
    type: "object",
    properties: {
      skip_liveness: {
        type: "boolean",
        description:
          "Skip the still-open check. Faster, but rows will read 'couldn't confirm'.",
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const brief = await buildDailyBrief({
        ...(args["skip_liveness"] === true ? { skipLiveness: true } : {}),
      });
      return { success: true, data: brief };
    } catch (err) {
      return {
        success: false,
        error:
          `Could not build the job brief: ${(err as Error).message}. ` +
          "Nothing was changed — screening results, if any, are still recorded.",
      };
    }
  },
};
