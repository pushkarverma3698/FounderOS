/**
 * FounderOS — stack overlap
 * =========================
 * The ranking function. Until this existed the pipeline emitted an
 * undifferentiated queue: on 2026-07-31 it screened 17 postings and 13 of them
 * needed founder attention, in no order, which is a list rather than a decision.
 *
 * WHAT IT IS: the (category-weighted) count of skill terms a posting asks for
 * that the CV also states, over the number of terms the posting asks for. Raw
 * counting ranked "Mentoring" and "Agile" the same as "LangGraph" and "RAG",
 * which let a generic infra-and-process-heavy posting outrank one that actually
 * named the founder's specialisation (see `compareOverlap`).
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

import { categoryOf, extractSkillTerms } from "./skills.js";
import { SKILL_CATEGORY_WEIGHT } from "./skills-dictionary.js";

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
 * How much a set of matched terms counts toward ranking.
 *
 * Sums each term's category weight (`SKILL_CATEGORY_WEIGHT`), defaulting to 1
 * for anything not in the dictionary — matched terms always come from
 * `extractSkillTerms`, so this only matters for hand-built test fixtures using
 * fake term names, which then behave exactly like the old raw count.
 */
function weightOf(terms: readonly string[]): number {
  return terms.reduce((sum, term) => {
    const category = categoryOf(term);
    return sum + (category ? SKILL_CATEGORY_WEIGHT[category] : 1);
  }, 0);
}

/**
 * Order for the brief: WEIGHTED matched-term count first, then ratio, then the
 * row's own order.
 *
 * Weighted, not raw, count leads. Measured, 2026-09-01: on a raw count a
 * Windows DevOps posting matching Azure/CI-CD/Linux/Mentoring outranked an AI
 * Engineer posting matching LangGraph/RAG/LLM/Prompt Engineering/AI Agents —
 * every matched term counted the same, so four generic infra-and-process terms
 * beat five terms naming the candidate's actual specialisation. Weighting by
 * category (skills-dictionary.ts) fixes that without picking one track over
 * another: a bigger, more substantive match still leads, same as before —
 * "9/12 leads 3/3" — it just no longer treats "Mentoring" as equal to
 * "LangGraph". Ratio still breaks ties among equal weight.
 */
export function compareOverlap(a: OverlapResult, b: OverlapResult): number {
  const byWeight = weightOf(b.matched) - weightOf(a.matched);
  if (byWeight !== 0) return byWeight;
  return b.ratio - a.ratio;
}
