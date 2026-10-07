/**
 * FounderOS — cross-source and no-answer retrieval cases (AG-029)
 * ===============================================================
 * The doc-only golden set (retrieval-golden.ts) cannot notice that capture from another source died: a Mac nightly
 * ingest failed silently for weeks (10-06 audit). These cases ask questions whose answers live in rows written by
 * one source (metadata.origin, AG-026), so a dead source turns the nightly eval red.
 *
 * Status of the data: the capture jobs (AG-027, AG-028) were not merged when this was written, so no case has a known
 * answer yet. Each case below is PENDING: `expectContains` is null. A pending case is reported as pending, never as a
 * pass. To activate one, read a real row of that origin, copy a distinctive phrase from it into `expectContains`, and
 * check the query finds it. From then on a miss, or a corpus with no rows of that origin, fails the run.
 *
 * Also here: scoring for the no-answer cases (retrieval-no-answer.ts). Pure functions over already-fetched hits;
 * the I/O is in scripts/lib/retrieval-extra.ts.
 */
import { abstainText, bestCosine } from "../db/brain-hit-view.js";
import type { RagHit } from "../db/rag-search.js";
import type { NoAnswerCase } from "./retrieval-no-answer.js";

/** The sources AG-027/028 add, as written in brain_memories.metadata.origin. */
export type CrossSourceOrigin = "telegram" | "mac-claude" | "mac-agy" | "vps-daemon";

export interface CrossSourceCase {
  readonly id: string;
  readonly origin: CrossSourceOrigin;
  readonly query: string;
  /** A phrase a matching row of this origin contains. Null = pending: no real row to copy it from yet. */
  readonly expectContains: string | null;
  readonly rationale: string;
}

export const CROSS_SOURCE_CASES: readonly CrossSourceCase[] = [
  {
    id: "cross-telegram-founder-request",
    origin: "telegram",
    query: "What did I ask FounderOS in Telegram yesterday about the job search?",
    expectContains: null,
    rationale: "PENDING AG-027/028 rows. Draft query: confirm it against a real telegram-origin row before setting expectContains.",
  },
  {
    id: "cross-mac-claude-session",
    origin: "mac-claude",
    query: "What did Claude on the Mac work on in the last session?",
    expectContains: null,
    rationale: "PENDING AG-027/028 rows. Draft query: confirm it against a real mac-claude row before setting expectContains.",
  },
  {
    id: "cross-mac-agy-task",
    origin: "mac-agy",
    query: "Which task did Antigravity on the Mac finish most recently?",
    expectContains: null,
    rationale: "PENDING AG-027/028 rows. Draft query: confirm it against a real mac-agy row before setting expectContains.",
  },
  {
    id: "cross-vps-daemon-alert",
    origin: "vps-daemon",
    query: "What did the VPS daemons report overnight?",
    expectContains: null,
    rationale: "PENDING AG-027/028 rows. Draft query: confirm it against a real vps-daemon row before setting expectContains.",
  },
];

export type CrossSourceVerdict = "pass" | "fail" | "pending";

export interface CrossSourceResult {
  readonly goldenCase: CrossSourceCase;
  readonly verdict: CrossSourceVerdict;
  /** One full sentence saying why, with the numbers. */
  readonly detail: string;
}

/**
 * Score one case. `originRows` is how many rows of the case's origin the corpus holds; `hits` is the top-k retrieval.
 * pending: no expected phrase yet (says whether rows now exist, so someone can activate it).
 * fail: an expected phrase but no rows of that origin (capture is dead), or no top-k hit of that origin containing it.
 */
export function scoreCrossSourceCase(
  c: CrossSourceCase,
  hits: readonly RagHit[],
  originRows: number,
  k: number,
): CrossSourceResult {
  if (c.expectContains === null) {
    const detail =
      originRows === 0
        ? `Pending data: the brain holds 0 rows with origin "${c.origin}" (capture from AG-027/028 has not landed).`
        : `Pending, but data exists: the brain holds ${originRows} rows with origin "${c.origin}". Copy a phrase from one into expectContains to activate this case.`;
    return { goldenCase: c, verdict: "pending", detail };
  }
  if (originRows === 0) {
    return { goldenCase: c, verdict: "fail", detail: `Capture is dead: the brain holds 0 rows with origin "${c.origin}", so "${c.query}" cannot be answered.` };
  }
  const needle = c.expectContains.toLowerCase();
  const rank = hits.slice(0, k).findIndex((h) => h.metadata["origin"] === c.origin && h.content.toLowerCase().includes(needle));
  return rank >= 0
    ? { goldenCase: c, verdict: "pass", detail: `Found a ${c.origin} row containing "${c.expectContains}" at rank ${rank + 1} of ${k}.` }
    : { goldenCase: c, verdict: "fail", detail: `No ${c.origin} row containing "${c.expectContains}" in the top ${k} (the brain holds ${originRows} ${c.origin} rows).` };
}

export interface NoAnswerResult {
  readonly goldenCase: NoAnswerCase;
  readonly abstained: boolean;
  readonly detail: string;
}

/**
 * A no-answer case passes when the reader would print "No strong match" (AG-025), or when retrieval returned nothing.
 * Hits with no cosine (keyword-only) cannot be judged, so they count as a miss: a loud direction (STANDARDS §4).
 */
export function scoreNoAnswerCase(c: NoAnswerCase, hits: readonly RagHit[]): NoAnswerResult {
  if (hits.length === 0) return { goldenCase: c, abstained: true, detail: "Retrieval returned no hits, so nothing is presented as an answer." };
  const best = bestCosine(hits);
  if (abstainText(hits, c.query, () => "") !== null) {
    return { goldenCase: c, abstained: true, detail: `Best cosine ${best?.toFixed(2)} is under the abstain threshold, so the reader says "No strong match".` };
  }
  return {
    goldenCase: c,
    abstained: false,
    detail:
      best === null
        ? "No hit carries a cosine (keyword-only), so the abstain cannot decide and the nearest hit would be shown as an answer."
        : `Best cosine ${best.toFixed(2)} clears the abstain threshold, so the nearest hit would be shown as an answer. Calibrate BRAIN_ABSTAIN_SIMILARITY; do not delete the case.`,
  };
}

/** Number of results that must turn the nightly run red: live cross-source fails plus no-answer misses. */
export function countExtraFailures(cross: readonly CrossSourceResult[], noAnswer: readonly NoAnswerResult[]): number {
  return cross.filter((r) => r.verdict === "fail").length + noAnswer.filter((r) => !r.abstained).length;
}

/** Markdown section for the report: failures first, then pending, then passes. */
export function renderExtraReport(cross: readonly CrossSourceResult[], noAnswer: readonly NoAnswerResult[]): string {
  const order: Record<CrossSourceVerdict, number> = { fail: 0, pending: 1, pass: 2 };
  const crossLines = [...cross]
    .sort((a, b) => order[a.verdict] - order[b.verdict])
    .map((r) => `- ${r.verdict.toUpperCase()} ${r.goldenCase.id}: ${r.detail}`);
  const noAnswerLines = [...noAnswer]
    .sort((a, b) => Number(a.abstained) - Number(b.abstained))
    .map((r) => `- ${r.abstained ? "PASS" : "FAIL"} ${r.goldenCase.id}: ${r.detail}`);
  const pending = cross.filter((r) => r.verdict === "pending").length;
  return [
    "## Cross-source cases (AG-029)",
    "",
    pending > 0 ? `${pending} of ${cross.length} cases are pending data and are not counted as passes.` : `All ${cross.length} cases are live.`,
    "",
    ...crossLines,
    "",
    "## No-answer cases (AG-025)",
    "",
    ...noAnswerLines,
    "",
    `Extra failures: ${countExtraFailures(cross, noAnswer)}`,
    "",
  ].join("\n");
}
