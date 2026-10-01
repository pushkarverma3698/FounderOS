/**
 * Evolution Engine — the rows the jobhunt analyzer reads.
 * ========================================================
 * Split out of `jobhunt.ts` for its 400-line budget (and re-exported from it, so
 * importers do not change). Narrow on purpose: an analyzer that sees a full drizzle
 * row will eventually depend on a column it has no business knowing about, so
 * `jobhunt-rows.ts` maps each stored row to exactly these fields and no more
 * (docs/antigravity/STANDARDS.md section 2).
 */

import type { FreeFunnel } from "../../tools/jobhunt/free-ingest.js";
import type { Finding } from "../types.js";

/** One free-sweep ledger row. `error` is the failure summary, null on a clean sweep. */
export interface IngestRunRow {
  readonly createdAt: Date;
  readonly error: string | null;
}

export interface LaneHeartbeatRow {
  readonly profileId: string;
  readonly candidateName?: string;
  readonly zeroPassStreak: number;
  readonly lastFunnel: FreeFunnel | null;
}

/** A posting the free lane stored for the first time. `platform` is null off a platform's own host. */
export interface NewPostingRow {
  readonly createdAt: Date;
  readonly company: string;
  readonly title: string;
  readonly url: string;
  readonly platform: string | null;
  /** `getApplyUrl(url, company) !== null`, decided by the collector with the real recogniser. */
  readonly hasFormLink: boolean;
}

/** One candidate's counts over the last CANDIDATE_NOT_ACTING_WINDOW_DAYS days. */
export interface ApplyActivityRow {
  readonly profileId: string;
  readonly candidateName?: string;
  readonly doToday: number;
  readonly stretch: number;
  readonly ask: number;
  readonly applied: number;
  readonly skipped: number;
}

export interface JobhuntSnapshot {
  readonly ingestRuns: readonly IngestRunRow[];
  readonly laneHeartbeats: readonly LaneHeartbeatRow[];
  readonly newPostings: readonly NewPostingRow[];
  readonly applyActivity: readonly ApplyActivityRow[];
}

/** What the check looked at, so "nothing new" is a claim that can be checked. */
export interface JobhuntCoverage {
  readonly sweepRuns24h: number;
  readonly newPostings7d: number;
  /** Platforms with enough baseline volume to be judged for silence. */
  readonly platformsJudged: readonly string[];
  readonly platformsKnown: number;
  readonly profilesChecked: number;
}

export interface JobhuntAnalysis {
  readonly findings: Finding[];
  readonly coverage: JobhuntCoverage;
}
