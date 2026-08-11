/**
 * FounderOS — stack overlap
 * =========================
 * The ranking function. Until this existed the pipeline emitted an
 * undifferentiated queue: on 2026-07-31 it screened 17 postings and 13 of them
 * needed founder attention, in no order, which is a list rather than a decision.
 *
 * WHAT IT IS: the count of skill terms a posting asks for that the CV also
 * states, over the number of terms the posting asks for.
 *
 * WHAT IT IS NOT: a fit score. It knows nothing about seniority, team, domain,
 * compensation, or whether Pushkar would want the job. It is named "overlap" for
 * that reason — a name implying judgement would earn trust the number cannot
 * support, and the first time it ranked a bad role first the founder would be
 * right to stop reading the brief entirely.
 *
 * Both sides run through `extractSkillTerms`, the SAME extractor that produces
 * the market signals. Matching the CV with different logic from the postings is
 * exactly how a report claims a gap in a skill the CV states plainly.
 *
 * Pure: no model call, no network, no DB. $0 and deterministic.
 */

import { extractSkillTerms } from "./skills.js";

export interface OverlapResult {
  /** Terms in both the posting and the CV. */
  readonly matched: readonly string[];
  /** Terms the posting asks for that the CV does not state. */
  readonly missing: readonly string[];
  /** How many terms the posting asked for at all — the denominator. */
  readonly asked: number;
  /**
   * matched / asked, 0–1. Zero when the posting names no recognisable
   * technology: an unmeasurable posting must not outrank a measured one.
   */
  readonly ratio: number;
}

/**
 * Score one posting against one CV.
 *
 * A posting naming no dictionary terms scores 0, not 1. The tempting reading of
 * "0 of 0 required skills missing" is a perfect match; the honest reading is
 * that nothing was measured. Ranking an unmeasured posting to the top of DO
 * TODAY would put the least legible role in front of the founder first.
 */
export function overlapScore(description: string, cvText: string): OverlapResult {
  const asked = extractSkillTerms(description).map((s) => s.term);
  const cvTerms = new Set(extractSkillTerms(cvText).map((s) => s.term));

  const matched = asked.filter((t) => cvTerms.has(t));
  const missing = asked.filter((t) => !cvTerms.has(t));

  return {
    matched,
    missing,
    asked: asked.length,
    ratio: asked.length === 0 ? 0 : matched.length / asked.length,
  };
}

/** How the brief prints it: `9/11`, never a percentage and never a grade. */
export function formatOverlap(result: OverlapResult): string {
  return `${result.matched.length}/${result.asked}`;
}

export interface RankableRow {
  readonly description: string | null;
  readonly salary_status: string;
}

/**
 * Order for the brief: matched-term count first, then ratio, then the row's own
 * order.
 *
 * Raw count leads deliberately. A posting asking for three things the CV has all
 * three of scores 1.0, and a posting asking for twelve of which the CV has nine
 * scores 0.75 — the second is the better lead, because it is a bigger role with
 * more surface to write about. Ratio breaks ties among equal counts.
 */
export function compareOverlap(a: OverlapResult, b: OverlapResult): number {
  if (b.matched.length !== a.matched.length) return b.matched.length - a.matched.length;
  return b.ratio - a.ratio;
}
