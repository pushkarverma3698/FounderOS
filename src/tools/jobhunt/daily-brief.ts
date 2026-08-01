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
  countPassingApplications,
  recordLiveness,
  recordBriefRanks,
} from "../../db/job-queries.js";
import { listSignals } from "../../db/cv-signal-queries.js";
import { readFullCvText } from "../career.js";
import { TRACK_PRIORITY } from "./tracks.js";
import { compareOverlap, overlapScore, type OverlapResult } from "./overlap.js";
import { extractSkillTerms } from "./skills.js";
import { verifyLiveness, type Liveness } from "./liveness.js";
import {
  formatDailyBrief,
  selectAskable,
  selectDoToday,
  type BriefInput,
  type BriefRow,
  type TrendRow,
} from "./brief.js";
import type { JobApplication } from "../../db/schema.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "jobhunt:daily-brief" });

/**
 * How many top-ranked rows to spend a liveness check on.
 *
 * Verification is cheap but not free, and it only changes a decision near the
 * top of the list. Checking rank 40 buys nothing the founder will read today.
 */
export const VERIFY_TOP_N = 8;

/** Terms below this share of a track's passing postings are noise in a trend line. */
const TREND_MIN_SHARE = 0.3;
const TREND_TERMS_PER_TRACK = 2;

function ageInDays(from: Date | null | undefined, now: Date): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

/** Longest headline the brief will print before trimming. */
const HEADLINE_MAX = 160;

/**
 * Trim to the last COMPLETE sentence that fits, falling back to a word boundary.
 *
 * A hard character cut ends the founder's decision line mid-word ("…They c"),
 * which reads as a rendering bug and drops whatever the gate was about to
 * qualify. Ending early but cleanly costs a clause and keeps the line credible.
 */
function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const lastStop = window.lastIndexOf(". ");
  if (lastStop > max / 2) return window.slice(0, lastStop + 1);
  const lastSpace = window.lastIndexOf(" ");
  return `${(lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd()}…`;
}

/**
 * The single most decision-relevant line from a row's stored gate evidence.
 *
 * `salary_evidence` holds every gate joined by " | ". For a reject the first
 * failing gate is the answer; for anything else the first line is the leading
 * consideration.
 */
export function headlineFor(row: JobApplication): string {
  const reasons = (row.salary_evidence ?? "").split(" | ").filter((s) => s.trim().length > 0);
  if (reasons.length === 0) return row.salary_status.toUpperCase();
  if (row.salary_status === "reject") {
    const bar = reasons.find((r) => /reject|cannot|void|required/i.test(r));
    if (bar) return trimToSentence(bar, HEADLINE_MAX);
  }
  return trimToSentence(reasons[0]!, HEADLINE_MAX);
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
 * Per-track CV text, read once per brief rather than once per row.
 *
 * Returns the tracks it could NOT read alongside the ones it could. Without that
 * list the failure is silent: a missing CV scores every posting at 0 overlap, so
 * the brief still renders a confident-looking order built from no comparison at
 * all. A log line does not reach the founder; a brief line does.
 */
export function loadTrackCvs(): { cvs: Map<string, string>; unreadable: string[] } {
  const cvs = new Map<string, string>();
  const unreadable: string[] = [];
  for (const track of TRACK_PRIORITY) {
    const cv = readFullCvText(track);
    if (cv.ok) cvs.set(track, cv.text);
    else {
      unreadable.push(track);
      log.warn({ track, error: cv.error }, "Track CV unreadable — overlap unavailable");
    }
  }

  // A row whose title matched no track is stored as "unclassified", and every
  // row screened before tracks existed carries that value. Without an entry here
  // the map lookup misses, the CV text is "", and EVERY such row scores 0/N —
  // a ranking built from no comparison, printed with no warning. Production's
  // first real brief showed "0/21 skills" on all three rows for exactly this
  // reason. The shared master CV is the honest comparison for a row with no
  // track, and it is what `readFullCvText()` returns when asked for no track.
  const master = readFullCvText();
  if (master.ok) cvs.set(UNCLASSIFIED_TRACK, master.text);
  else {
    unreadable.push(UNCLASSIFIED_TRACK);
    log.warn({ error: master.error }, "Master CV unreadable — untracked rows score 0 overlap");
  }

  return { cvs, unreadable };
}

/** The `track` column's default: a title that matched no track's phrases. */
export const UNCLASSIFIED_TRACK = "unclassified";

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

/** The market trend lines, one or two terms per track, with how long they've been absent. */
export async function buildTrends(cvs: ReadonlyMap<string, string>, now: Date): Promise<TrendRow[]> {
  const trends: TrendRow[] = [];

  for (const track of TRACK_PRIORITY) {
    const sampleSize = await countPassingApplications({ track });
    if (sampleSize === 0) continue;

    const signals = await listSignals({ track, limit: 40 });
    const cvText = cvs.get(track);
    const cvTerms =
      cvText === undefined ? null : new Set(extractSkillTerms(cvText).map((s) => s.term));

    for (const signal of signals) {
      if (signal.category === "unknown") continue;
      if (signal.seen_count / sampleSize < TREND_MIN_SHARE) continue;
      // A term already in the CV is not news. With no readable CV we cannot say
      // either way, so absence is reported as null rather than guessed at.
      const absent = cvTerms === null ? null : !cvTerms.has(signal.term);
      if (absent === false) continue;

      trends.push({
        track,
        sampleSize,
        term: signal.term,
        seenCount: signal.seen_count,
        absentDays: absent === null ? null : ageInDays(signal.first_seen_at, now),
      });
      if (trends.filter((t) => t.track === track).length >= TREND_TERMS_PER_TRACK) break;
    }
  }

  return trends;
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
  const applications = await listActionableApplications({});
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

  const rows: BriefRow[] = scored.map(({ row, overlap }) => ({
    id: row.id,
    company: row.company,
    title: row.title,
    track: row.track,
    verdict: row.salary_status,
    route: row.route,
    url: row.url,
    overlap,
    liveness: liveness.get(row.id) ?? toLiveness(row.liveness),
    headline: headlineFor(row),
    ageDays: ageInDays(row.created_at, now),
  }));

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

  const input: BriefInput = {
    date: now,
    screened: opts.screened ?? applications.length,
    perTrack,
    rows,
    trends: await buildTrends(cvs, now),
    failures: [...(opts.failures ?? []), ...cvFailure, ...untrackedNote],
  };

  // Pin the numbering BEFORE returning the text. selectDoToday/selectAskable are
  // pure and get the same `rows`, so what is stored is exactly what is printed.
  // Deriving it again when /draft fires would retarget the command silently.
  await persistBriefRanks(rows);

  return formatDailyBrief(input);
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
