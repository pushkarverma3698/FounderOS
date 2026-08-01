/**
 * FounderOS — the market-trend lines of the brief
 * ===============================================
 * "React asked 9× across 11 roles that cleared the gates — missing from your
 * frontend CV for 14 days."
 *
 * This is the only part of the brief that is about the MARKET rather than about
 * a specific job, and it is the part that makes the CV a moving target rather
 * than a document written once. It reads `cv_signals`, which only ever counts
 * postings that PASSED every gate — the market at large is noise, while the
 * roles Pushkar can lawfully hold are the population his CV has to match.
 *
 * Split out of daily-brief.ts, which was over the 400-line budget and was doing
 * three jobs: reading applications, verifying liveness, and this.
 */

import { countPassingApplications } from "../../db/job-queries.js";
import { listSignals } from "../../db/cv-signal-queries.js";
import { TRACK_PRIORITY } from "./tracks.js";
import { extractSkillTerms } from "./skills.js";
import type { TrendRow } from "./brief.js";

/** Terms below this share of a track's passing postings are noise in a trend line. */
const TREND_MIN_SHARE = 0.3;
const TREND_TERMS_PER_TRACK = 2;

function ageInDays(from: Date | null | undefined, now: Date): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

/** The market trend lines, one or two terms per track, with how long they've been absent. */
export async function buildTrends(
  cvs: ReadonlyMap<string, string>,
  now: Date,
): Promise<TrendRow[]> {
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
