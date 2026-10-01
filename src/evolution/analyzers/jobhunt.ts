/**
 * Evolution Engine — jobhunt findings (plan 2026-09-29, part C1).
 * ================================================================
 * Four checks over rows already read by `collect-jobhunt.ts`. PURE: no I/O, no
 * clock (`now` is a parameter), no environment, so every case is an array literal
 * and the same rows always give the same findings.
 *
 *   adapter-silent           IMPLEMENTATION  a platform stopped yielding postings
 *   apply-link-unrecognised  IMPLEMENTATION  a platform's URLs stopped yielding a form link
 *   lane-silent              DECISION        a candidate's lane passed nothing to screening
 *   candidate-not-acting     DECISION        roles piled up and nothing was applied to
 *
 * Implementation kinds have guidance in `jobhunt-guidance.ts`, which is what makes
 * `issue-body.ts` willing to turn them into an issue. Decision kinds have none, so
 * they can never reach an executor: they go to Telegram only.
 *
 * WHAT THE PLAN GOT WRONG ABOUT ITS SOURCES (found by reading the writers, 2026-09-29).
 *  · `job_ingest_runs` has NO platform column. The free lane writes ONE row per
 *    profile per sweep (`feed='free-ats'`, `pool='free-boards'`, `track='all'`), and
 *    `returned` is the postings that reached screening, summed over every platform.
 *    Per-platform facts survive in exactly two places: the failure summary in
 *    `error` (failures only) and the URLs on `job_applications`. So platform
 *    silence is measured from stored postings, and `job_ingest_runs` supplies the
 *    two controls the plan's own wording needs: did the sweeps run, and were the
 *    platform's boards failing at the HTTP level.
 *  · "all of the platform's boards return HTTP 200" is unsatisfiable literally:
 *    every sampled sweep in the 7 days to 2026-09-29 named dead boards ("greenhouse
 *    HTTP 404 ×16-18; ashby HTTP 404 ×3-4; lever HTTP 404 ×3"). It is read as "not
 *    failing in most sweeps", which becomes exact once the persisted dead-board skip
 *    (plan B1) removes steady 404s from the summary.
 *  · `candidate-not-acting` needs `job_applications` (`brief_section`, `applied_at`,
 *    `skipped_at`), which the plan does not list.
 */

import { rankFindings } from "../rank.js";
import type { Finding, FindingKind } from "../types.js";
import { findCandidateNotActing, findLaneSilent } from "./jobhunt-decisions.js";
import type { JobhuntAnalysis, JobhuntCoverage, JobhuntSnapshot, NewPostingRow } from "./jobhunt-types.js";

// The two decision kinds live in jobhunt-decisions.ts; re-exported so this stays the one import for the analyzer.
export {
  CANDIDATE_NOT_ACTING_MIN_ACTIONABLE,
  CANDIDATE_NOT_ACTING_WINDOW_DAYS,
  LANE_SILENT_MIN_STREAK,
  SWEEP_INTERVAL_MINUTES,
  findCandidateNotActing,
  findLaneSilent,
} from "./jobhunt-decisions.js";

/** The kinds this analyzer emits. The issue-body tests walk it, so a new kind cannot ship without a fixture. */
export const JOBHUNT_KINDS: readonly FindingKind[] = [
  "adapter-silent",
  "apply-link-unrecognised",
  "lane-silent",
  "candidate-not-acting",
];

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ── Thresholds. Each names the plan's measured number, or says it has none. ─────

/** Plan C1: "fell to 0 for 24h". The window is the 24h before the daily 09:30 run. */
export const ADAPTER_SILENT_WINDOW_HOURS = 24;

/** Plan C1: "after a non-zero 7-day baseline". */
export const ADAPTER_SILENT_BASELINE_DAYS = 7;

/**
 * Baseline postings one platform needs before its silence means anything.
 *
 * The plan says "non-zero"; a bare non-zero would file an issue whenever a small
 * platform has a quiet day. 49 is 7 postings a day for 7 days: for a feed at 7 a
 * day the chance of a genuinely empty 24h is e^-7 = 0.09%. The plan gives no
 * per-platform volume (its measured 65, 114, 79, 85 and 103 new rows a week for
 * Tashi are the whole lane, all platforms together), so only the large platforms
 * can qualify, which is where a broken parser costs the most. NOT measured
 * against prod: chosen to be conservative.
 */
export const ADAPTER_SILENT_MIN_BASELINE_ROWS = 49;

/**
 * The rest of the lane must have produced at least this share of its usual daily
 * volume in the same 24h. It is the weekend, holiday and dead-sweep guard: when
 * everything is quiet no platform is singled out. NOT measured; without it a
 * Sunday would read as a broken adapter.
 */
export const ADAPTER_SILENT_MIN_LANE_SHARE = 0.5;

/**
 * Free-sweep ledger rows needed in the window before "the adapter is broken" can
 * be said instead of "the sweep did not run". Measured: 670 `free-boards` runs in
 * 7 days = 96 a day (48 sweeps x 2 profiles); a quarter of that is 24.
 */
export const ADAPTER_SILENT_MIN_SWEEP_RUNS = 24;

/**
 * The most sweeps in the window whose failure summary may name the platform. Past
 * this the platform is failing at the HTTP level (a 429 storm, a moved API): a
 * fetch defect, and the plan is explicit that rate limiting is a different failure.
 */
export const ADAPTER_SILENT_MAX_FAILING_SWEEP_SHARE = 0.5;

/** Plan C1: "over 7 days". */
export const APPLY_LINK_WINDOW_DAYS = 7;

/**
 * Plan C1: "exceeds 30%". Sits between the two shares the 2026-09-28 audit
 * measured: 17.8% of the NL sweep's 39,287 postings had no form link after the
 * recognisers shipped (by design: boards white-labelled on the employer's own
 * domain) and 48.6% before. Only postings on a platform's OWN host are counted,
 * so that by-design 17.8% never reaches the numerator.
 */
export const APPLY_LINK_MAX_MISSING_SHARE = 0.3;

/**
 * Postings on one platform's hosts needed before the share is judged: at 10, the
 * 30% line is 3 postings, so one odd URL cannot file an issue. NOT measured.
 */
export const APPLY_LINK_MIN_ROWS = 10;

/** Sample postings quoted in an issue's Evidence section. */
export const SAMPLE_ROWS = 5;

/** Longest a quoted data value may be, so one row cannot bloat an issue. */
const ROW_TEXT_MAX = 140;

/**
 * The adapter file per platform, which is the component an issue names. A test
 * pins the keys to `ADAPTERS` and every path to a file in the checkout, because an
 * issue naming a path that does not exist is dead on arrival.
 */
export const ADAPTER_SOURCE_PATHS: Readonly<Record<string, string>> = Object.fromEntries(
  [
    "greenhouse",
    "lever",
    "ashby",
    "recruitee",
    "smartrecruiters",
    "workable",
    "personio",
    "workday",
    "teamtailor",
    "bamboohr",
  ].map((platform) => [platform, `src/tools/jobhunt/adapters/${platform}.ts`]),
);

/** Where a platform's apply-link recognition lives (`extractBoardToken`'s PATTERNS). */
const APPLY_LINK_SOURCE_PATH = "src/tools/jobhunt/board-token.ts";

// ── Row contracts: what the collector hands over (see jobhunt-types.ts). ───────

export type {
  ApplyActivityRow,
  IngestRunRow,
  JobhuntAnalysis,
  JobhuntCoverage,
  JobhuntSnapshot,
  LaneHeartbeatRow,
  NewPostingRow,
} from "./jobhunt-types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** One line of data, safe to quote inside a Markdown issue and a Telegram message. */
export function oneLine(value: string, max: number = ROW_TEXT_MAX): string {
  // `<` and `>` go too: a company name must never be able to open an HTML comment
  // and forge the fingerprint marker the next run reads its history back from.
  const flat = value.replace(/[<>`]/g, "'").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function describePosting(p: NewPostingRow): string {
  return `"${oneLine(p.title)}" at ${oneLine(p.company)}, ${oneLine(p.url, 300)} (first seen ${p.createdAt.toISOString()})`;
}

function newestFirst(rows: readonly NewPostingRow[]): NewPostingRow[] {
  return rows
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.url < b.url ? -1 : 1));
}

/**
 * Platforms named in a sweep's failure summary. The summary is our own format
 * (`summariseFailures`: "12 board(s) failed: greenhouse HTTP 404 ×9; ashby HTTP
 * 429 ×3; +2 other pattern(s)"), and a test pins this reader to the real writer.
 * Segments it does not recognise are ignored, so a new format can make it blind,
 * never wrong.
 */
export function failedPlatformsOf(error: string | null): Set<string> {
  const known = new Set(Object.keys(ADAPTER_SOURCE_PATHS)); // a Set, not `in`: "constructor" is not a platform
  const found = new Set<string>();
  if (!error) return found;
  const body = error.includes("failed:") ? error.slice(error.indexOf("failed:") + "failed:".length) : error;
  for (const segment of body.split(";")) {
    const first = segment.trim().split(/\s+/)[0]?.replace(/[^a-z]+$/i, "").toLowerCase();
    if (first && known.has(first)) found.add(first);
  }
  return found;
}

/**
 * The two spans adapter-silent compares: the last 24h (`inWindow`, newest edge inclusive) and the 7 days
 * before it (`inBaseline`, oldest edge inclusive). A row stamped after `now`, or with an invalid date,
 * falls in neither.
 */
function spans(now: Date): { readonly inWindow: (d: Date) => boolean; readonly inBaseline: (d: Date) => boolean } {
  const nowMs = now.getTime();
  const windowStart = nowMs - ADAPTER_SILENT_WINDOW_HOURS * MS_PER_HOUR;
  const baselineStart = windowStart - ADAPTER_SILENT_BASELINE_DAYS * MS_PER_DAY;
  return {
    inWindow: (d) => d.getTime() > windowStart && d.getTime() <= nowMs,
    inBaseline: (d) => d.getTime() >= baselineStart && d.getTime() <= windowStart,
  };
}

// ── adapter-silent ──────────────────────────────────────────────────────────────

export function findAdapterSilent(snapshot: JobhuntSnapshot, now: Date): Finding[] {
  const { inWindow: windowSpan, inBaseline: baselineSpan } = spans(now);
  const inWindow = (p: NewPostingRow): boolean => windowSpan(p.createdAt);
  const inBaseline = (p: NewPostingRow): boolean => baselineSpan(p.createdAt);

  const runs = snapshot.ingestRuns.filter((r) => windowSpan(r.createdAt));
  // The sweeps did not run: that is the lane's failure to report, not an adapter's.
  if (runs.length < ADAPTER_SILENT_MIN_SWEEP_RUNS) return [];

  const findings: Finding[] = [];
  for (const platform of Object.keys(ADAPTER_SOURCE_PATHS).sort()) {
    const own = snapshot.newPostings.filter((p) => p.platform === platform);
    const baseline = own.filter(inBaseline);
    if (baseline.length < ADAPTER_SILENT_MIN_BASELINE_ROWS || own.some(inWindow)) continue;

    const others = snapshot.newPostings.filter((p) => p.platform !== platform);
    const laneWindow = others.filter(inWindow).length;
    const lanePerDay = others.filter(inBaseline).length / ADAPTER_SILENT_BASELINE_DAYS;
    // Silence shared with the whole lane is a quiet day (or a dead sweep), not this adapter.
    if (laneWindow === 0 || laneWindow < ADAPTER_SILENT_MIN_LANE_SHARE * lanePerDay) continue;

    const failingRuns = runs.filter((r) => failedPlatformsOf(r.error).has(platform)).length;
    if (failingRuns / runs.length > ADAPTER_SILENT_MAX_FAILING_SWEEP_SHARE) continue;

    findings.push(adapterSilentFinding({ platform, baseline, laneWindow, lanePerDay, runs: runs.length, failingRuns }));
  }
  return findings;
}

function adapterSilentFinding(a: {
  readonly platform: string;
  readonly baseline: readonly NewPostingRow[];
  readonly laneWindow: number;
  readonly lanePerDay: number;
  readonly runs: number;
  readonly failingRuns: number;
}): Finding {
  const newest = newestFirst(a.baseline);
  const lastSeen = newest[0]!.createdAt.toISOString();
  const perDay = Math.round(a.lanePerDay);
  return {
    kind: "adapter-silent",
    // The date of the last posting is the episode: it stays fixed while the silence
    // lasts (one issue, however many mornings it persists) and changes when the
    // platform recovers and breaks again (a new issue, not a suppressed one).
    subject: `${a.platform} (no new postings since ${lastSeen.slice(0, 10)})`,
    evidence:
      `${a.platform} produced 0 new postings in the last ${ADAPTER_SILENT_WINDOW_HOURS}h after ${a.baseline.length} in the ` +
      `${ADAPTER_SILENT_BASELINE_DAYS} days before, while the rest of the free lane produced ${a.laneWindow} (about ${perDay} a day ` +
      `before). ${a.platform} was named in a failure summary in only ${a.failingRuns} of ${a.runs} sweeps, so no mass fetch ` +
      `failure was recorded for it: its postings are either not arriving or arriving and not being parsed.`,
    severity: "high",
    location: ADAPTER_SOURCE_PATHS[a.platform]!,
    evidenceRows: [
      `${a.platform}: ${a.baseline.length} new postings in the ${ADAPTER_SILENT_BASELINE_DAYS} days before the last ${ADAPTER_SILENT_WINDOW_HOURS}h, 0 since; the newest was first seen ${lastSeen}.`,
      `Rest of the free lane: ${a.laneWindow} new postings in the last ${ADAPTER_SILENT_WINDOW_HOURS}h, against about ${perDay} a day over the ${ADAPTER_SILENT_BASELINE_DAYS} days before.`,
      `Free sweep runs in the last ${ADAPTER_SILENT_WINDOW_HOURS}h: ${a.runs}; ${a.platform} was named in a failure summary in ${a.failingRuns} of them.`,
      ...newest.slice(0, SAMPLE_ROWS).map((p) => `Last ${a.platform} posting seen: ${describePosting(p)}`),
    ],
  };
}

// ── apply-link-unrecognised ─────────────────────────────────────────────────────

export function findApplyLinkUnrecognised(snapshot: JobhuntSnapshot, now: Date): Finding[] {
  const nowMs = now.getTime();
  const since = nowMs - APPLY_LINK_WINDOW_DAYS * MS_PER_DAY;
  const recent = snapshot.newPostings.filter((p) => p.createdAt.getTime() > since && p.createdAt.getTime() <= nowMs);

  const findings: Finding[] = [];
  for (const platform of Object.keys(ADAPTER_SOURCE_PATHS).sort()) {
    const own = recent.filter((p) => p.platform === platform);
    const missing = own.filter((p) => !p.hasFormLink);
    if (own.length < APPLY_LINK_MIN_ROWS || missing.length / own.length <= APPLY_LINK_MAX_MISSING_SHARE) continue;

    const percent = Math.round((missing.length / own.length) * 100);
    findings.push({
      kind: "apply-link-unrecognised",
      subject: platform,
      evidence:
        `${missing.length} of ${own.length} postings (${percent}%) on ${platform} hosts in the last ${APPLY_LINK_WINDOW_DAYS} days ` +
        `have no apply-form link (limit ${Math.round(APPLY_LINK_MAX_MISSING_SHARE * 100)}%), so /draft and the Mac client open the ` +
        `posting page instead of the employer's form.`,
      severity: "medium",
      location: APPLY_LINK_SOURCE_PATH,
      evidenceRows: [
        `${platform}: ${missing.length} of ${own.length} postings on its own hosts have no apply-form link (${percent}%), last ${APPLY_LINK_WINDOW_DAYS} days.`,
        ...newestFirst(missing)
          .slice(0, SAMPLE_ROWS)
          .map((p) => `No form link for ${platform} posting: ${describePosting(p)}`),
      ],
    });
  }
  return findings;
}

// ── All four ────────────────────────────────────────────────────────────────────

function coverageOf(snapshot: JobhuntSnapshot, now: Date): JobhuntCoverage {
  const { inWindow, inBaseline } = spans(now);
  const judged = Object.keys(ADAPTER_SOURCE_PATHS)
    .filter(
      (platform) =>
        snapshot.newPostings.filter((p) => p.platform === platform && inBaseline(p.createdAt)).length >=
        ADAPTER_SILENT_MIN_BASELINE_ROWS,
    )
    .sort();
  const weekStart = now.getTime() - APPLY_LINK_WINDOW_DAYS * MS_PER_DAY;
  return {
    sweepRuns24h: snapshot.ingestRuns.filter((r) => inWindow(r.createdAt)).length,
    newPostings7d: snapshot.newPostings.filter((p) => p.createdAt.getTime() > weekStart && p.createdAt <= now).length,
    platformsJudged: judged,
    platformsKnown: Object.keys(ADAPTER_SOURCE_PATHS).length,
    profilesChecked: new Set([
      ...snapshot.laneHeartbeats.map((h) => h.profileId),
      ...snapshot.applyActivity.map((a) => a.profileId),
    ]).size,
  };
}

/** Every check, ranked so the finding an issue would be filed for comes first. */
export function analyzeJobhunt(snapshot: JobhuntSnapshot, now: Date): JobhuntAnalysis {
  return {
    findings: rankFindings([
      ...findAdapterSilent(snapshot, now),
      ...findApplyLinkUnrecognised(snapshot, now),
      ...findLaneSilent(snapshot),
      ...findCandidateNotActing(snapshot),
    ]),
    coverage: coverageOf(snapshot, now),
  };
}
