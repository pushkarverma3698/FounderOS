/**
 * FounderOS — what the brief writes back
 * ======================================
 * The two write-backs a render performs: the numbering `/draft N` resolves
 * against, and the CV-to-posting fit the ranking just computed.
 *
 * Split out of daily-brief.ts on 2026-08-06 when the third actionable section
 * pushed that file to its 400-line budget — same precedent as brief-cv.ts and
 * brief-trends.ts.
 *
 * BOTH ARE FAIL-OPEN, and deliberately so: the brief itself is the deliverable.
 * Throwing here would trade a working message for a lost footnote, and the
 * founder finds out about a lost rank the loud way — `/draft` says it cannot
 * find the row — never by drafting for the wrong company.
 */

import { childLogger } from "../../infra/logger.js";
import { recordBriefRanks, recordFitScores } from "../../db/job-queries.js";
import { formatOverlap, type OverlapResult } from "./overlap.js";
import { orderAskable, orderDoToday, orderStretch } from "./brief-select.js";
import type { BriefRow } from "./brief-row.js";
import type { JobApplication } from "../../db/schema.js";

const log = childLogger({ module: "jobhunt:brief-persist" });

/**
 * Store which row the founder will read as "1", "2", "3" in each section.
 *
 * THE STRETCH SECTION CONTINUES DO TODAY'S NUMBERING rather than restarting,
 * because `/draft` addresses both: a row flagged only on the years bar needs an
 * application, not a question, so it carries `/draft` like a do-today row does.
 * `renderMarketBlocks` prints those rows from the same offset, so the printed
 * number and the pinned rank agree by construction rather than by two functions
 * happening to compute the same thing.
 *
 * Failure is tolerated but reported — see the module header.
 */
export interface BriefRankEntry {
  readonly id: string;
  readonly section: "do_today" | "stretch" | "ask";
  readonly rank: number;
}

/**
 * The numbering, as data — every qualifying row, not only the printed ones.
 *
 * PINNED OVER THE UNCAPPED ORDERING (`order*`), not the display slice
 * (`select*`). The cap decides how much of the message the founder reads; it
 * must not decide how much of his own queue he can address. Until 2026-08-24 it
 * decided both, and the measurable result was 464 screened rows against 3 that
 * `/draft` — or `mac-client/sync.py`, which reads this very column — could
 * reach.
 *
 * Stretch continues from the FULL do-today length, not the displayed one.
 * Numbering it from `DO_TODAY_CAP + 1` would hand two different rows the same
 * number, and `ja_brief_rank_uniq` would reject the second write — losing the
 * row silently, which is the failure direction this codebase keeps paying for.
 *
 * Pure and exported so the property can be asserted without a database.
 */
export function briefRankEntries(rows: readonly BriefRow[]): BriefRankEntry[] {
  const doToday = orderDoToday(rows);
  return [
    ...doToday.map((r, i) => ({ id: r.id, section: "do_today" as const, rank: i + 1 })),
    ...orderStretch(rows).map((r, i) => ({
      id: r.id,
      section: "stretch" as const,
      rank: doToday.length + i + 1,
    })),
    ...orderAskable(rows).map((r, i) => ({ id: r.id, section: "ask" as const, rank: i + 1 })),
  ];
}

export async function persistBriefRanks(rows: readonly BriefRow[], opts: { profileId?: string } = {}): Promise<void> {
  const entries = briefRankEntries(rows);
  try {
    // profileId scoping: without it, ranking Wife's queue clears Pushkar's
    // brief_section/brief_rank (and vice versa) — see recordBriefRanks in
    // job-queries.ts, which only clears the invoking profile's previous ranks
    // when profileId is passed.
    await recordBriefRanks(entries, { profileId: opts.profileId });
  } catch (err) {
    // allow-failopen: the brief itself is the deliverable. A lost rank makes
    // /draft say "I can't find row N", which is loud and recoverable.
    log.warn({ err: (err as Error).message }, "Brief rank persist failed — /draft handles stale");
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
export async function persistFitScores(
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
