/**
 * FounderOS — Retrieval Eval Scoring (pure)
 * ==========================================
 * Pure functions that turn (RetrievalGoldenCase, RetrievalObservation) pairs
 * into scored results and aggregate them into a report. No LLM, no I/O, no
 * database — fully unit-testable with array literals at $0.
 *
 * Metric philosophy (held from src/eval/scoring.ts): each metric is computed
 * only over the cases that could actually produce it, so the number means what
 * it says.
 *   - recall@k / MRR — only over cases where retrieval RETURNED something
 *     (`error` unset). A case whose retrieval threw is excluded and counted
 *     separately as `retrievalErrors`, exactly as the behavioural harness sets
 *     infra errors aside. A crashed query is not a recall miss.
 *   - Degradation is NOT excluded, it is COUNTED. A keyword-only run does
 *     produce results, so silently dropping it would hide the fact that the
 *     headline number was not measured under semantic retrieval at all. It is
 *     reported as `degradedCases` and the renderer refuses to present a
 *     degraded number as a clean measurement.
 *
 * Definitions, stated so the numbers are not open to interpretation:
 *   - The retriever returns ranked CHUNKS; this module scores the ranked list
 *     of DOCUMENTS derived from them (first occurrence wins). That is exactly
 *     the set of documents the agent would have seen.
 *   - recall@k = (expected documents present in the top-k document list) /
 *     (expected documents declared). For a single-document case this is a hit
 *     rate of 0 or 1.
 *   - reciprocal rank = 1 / (1-based position of the FIRST expected document),
 *     or 0 when none appears. MRR is the mean over scorable cases.
 */

import {
  RETRIEVAL_STYLES,
  type RetrievalGoldenCase,
  type RetrievalStyle,
} from "./retrieval-golden.js";

/** Cutoff for the headline metric. Retrieval is measured at what the agent sees. */
export const RETRIEVAL_TOP_K = 5;

/**
 * Which retrieval signals actually produced the hits.
 *
 * `keyword` and `keyword-fallback` are deliberately DIFFERENT things and must
 * never be collapsed: `keyword` means keyword search was chosen (the ablation
 * lane), `keyword-fallback` means it was forced because the embedder was down.
 * The first is a measurement; the second is a degradation. Only the second
 * makes a run untrustworthy.
 */
export type RetrievalMode = "hybrid" | "vector" | "keyword" | "keyword-fallback";

/**
 * Which retrieval path a run deliberately exercised. Running the same golden set
 * through all four is the ablation: if `keyword-only` matches `hybrid`, the
 * embeddings contributed nothing measurable on that set; if `hybrid+rerank`
 * matches `hybrid`, the local reranker isn't earning its latency.
 */
export type RetrievalLane = "hybrid" | "vector-only" | "keyword-only" | "hybrid+rerank";

/** What one retrieval call actually returned. */
export interface RetrievalObservation {
  /**
   * Ranked `source_path` values, best first, already de-duplicated. Empty when
   * retrieval failed or the corpus matched nothing.
   */
  readonly rankedDocs: readonly string[];
  /** Which signals produced `rankedDocs`. */
  readonly mode: RetrievalMode;
  /** Set only for `keyword-fallback` — why semantic search was unavailable. */
  readonly degradedReason?: string;
  /** Set when retrieval failed outright. Such a case is excluded from metrics. */
  readonly error?: string;
}

/** One golden case after scoring. */
export interface RetrievalCaseResult {
  readonly goldenCase: RetrievalGoldenCase;
  readonly observation: RetrievalObservation;
  /** Expected documents present in the top-k document list. */
  readonly recallAtK: number;
  /** 1 / rank of the first expected document within top-k; 0 when absent. */
  readonly reciprocalRank: number;
  /** True when retrieval threw — excluded from every metric. */
  readonly retrievalError: boolean;
  /** True when the run was keyword-only because the embedder was unavailable. */
  readonly degraded: boolean;
}

/** recall/MRR for one slice of the golden set (one authoring style). */
export interface StyleSummary {
  readonly style: RetrievalStyle;
  /** Scorable cases of this style. 0 means the style contributed no evidence. */
  readonly cases: number;
  readonly meanRecallAtK: number;
  readonly mrr: number;
}

/** The full retrieval report. */
export interface RetrievalReport {
  readonly generatedAt: string;
  /** Which retrieval path this report measured. */
  readonly lane: RetrievalLane;
  /** Cutoff the metrics were computed at. */
  readonly k: number;
  /** Cases that returned results and were scored. */
  readonly scoredCases: number;
  /** Mean recall@k over scored cases. 0 when nothing was scored (never NaN). */
  readonly meanRecallAtK: number;
  /** Mean reciprocal rank over scored cases. 0 when nothing was scored. */
  readonly mrr: number;
  /** Cases where retrieval threw — excluded from the metrics above. */
  readonly retrievalErrors: number;
  /** Scored cases that ran keyword-only because the embedder was down. */
  readonly degradedCases: number;
  /** Golden documents absent from the corpus at run time. Their cases cannot pass. */
  readonly missingGoldenDocs: readonly string[];
  /** Total chunks in the corpus the run measured, or null when it could not be counted. */
  readonly corpusChunks: number | null;
  /** Distinct documents in that corpus, or null when it could not be counted. */
  readonly corpusDocs: number | null;
  /**
   * recall/MRR split by how each query was authored. Reported separately
   * because averaging title-derived and vocabulary-disjoint queries into one
   * number hides the only interesting effect in the data.
   */
  readonly byStyle: readonly StyleSummary[];
  readonly results: readonly RetrievalCaseResult[];
}

/**
 * Project ranked chunk hits onto the ranked list of distinct documents the agent
 * would have seen. First occurrence of a document wins; hits with no usable
 * `source_path` are dropped rather than ranked as an unnamed source.
 */
export function toRankedDocIds(
  hits: readonly { readonly metadata: Record<string, unknown> }[],
): string[] {
  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const hit of hits) {
    const raw = hit.metadata["source_path"];
    if (typeof raw !== "string") continue;
    const path = raw.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    ranked.push(path);
  }
  return ranked;
}

/**
 * Fraction of the expected documents present in the first `k` ranked documents.
 * Returns 0 for an empty expectation — a case declaring nothing cannot be
 * credited with perfect recall (STANDARDS §4: never emit a metric computed from
 * nothing).
 */
export function recallAtK(
  rankedDocs: readonly string[],
  expectedDocs: readonly string[],
  k: number,
): number {
  if (expectedDocs.length === 0 || k <= 0) return 0;
  const topK = new Set(rankedDocs.slice(0, k));
  const found = expectedDocs.filter((doc) => topK.has(doc)).length;
  return found / expectedDocs.length;
}

/**
 * 1 / (1-based rank of the first expected document within the first `k` ranked
 * documents). 0 when no expected document appears.
 */
export function reciprocalRank(
  rankedDocs: readonly string[],
  expectedDocs: readonly string[],
  k: number,
): number {
  if (expectedDocs.length === 0 || k <= 0) return 0;
  const expected = new Set(expectedDocs);
  const topK = rankedDocs.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    if (expected.has(topK[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/** Mean of a list of numbers; 0 for an empty list (never NaN). */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Golden documents that are NOT in the corpus, sorted and de-duplicated. Their
 * cases can never pass, so reporting them is what separates "retrieval missed
 * it" from "it was never there" — two facts a single recall number conflates.
 */
export function findMissingGoldenDocs(
  cases: readonly RetrievalGoldenCase[],
  corpusDocPaths: readonly string[],
): string[] {
  const corpus = new Set(corpusDocPaths);
  const missing = new Set<string>();
  for (const c of cases) {
    for (const doc of c.expectedDocs) {
      if (!corpus.has(doc)) missing.add(doc);
    }
  }
  return [...missing].sort();
}

/** Score one golden case against what retrieval returned. */
export function scoreRetrievalCase(
  goldenCase: RetrievalGoldenCase,
  observation: RetrievalObservation,
  k: number = RETRIEVAL_TOP_K,
): RetrievalCaseResult {
  const failed = typeof observation.error === "string" && observation.error.trim().length > 0;
  return {
    goldenCase,
    observation,
    recallAtK: failed ? 0 : recallAtK(observation.rankedDocs, goldenCase.expectedDocs, k),
    reciprocalRank: failed
      ? 0
      : reciprocalRank(observation.rankedDocs, goldenCase.expectedDocs, k),
    retrievalError: failed,
    degraded: !failed && observation.mode === "keyword-fallback",
  };
}

/**
 * Split scored cases by authoring style. Computed over cases that actually ran
 * (errored cases excluded, consistent with the headline metrics). A style with
 * no scorable case is omitted rather than reported as 0% — an absent slice and
 * a slice that scored zero are different facts.
 */
export function summarizeByStyle(
  results: readonly RetrievalCaseResult[],
): StyleSummary[] {
  const scorable = results.filter((r) => !r.retrievalError);
  const summaries: StyleSummary[] = [];
  for (const style of RETRIEVAL_STYLES) {
    const slice = scorable.filter((r) => r.goldenCase.style === style);
    if (slice.length === 0) continue;
    summaries.push({
      style,
      cases: slice.length,
      meanRecallAtK: mean(slice.map((r) => r.recallAtK)),
      mrr: mean(slice.map((r) => r.reciprocalRank)),
    });
  }
  return summaries;
}

/** Context the report needs that scoring cannot derive from the cases alone. */
export interface RetrievalCorpusContext {
  readonly corpusChunks: number | null;
  readonly corpusDocs: number | null;
  readonly missingGoldenDocs: readonly string[];
}

/**
 * Aggregate scored cases into a report. Errored cases are excluded from
 * recall/MRR and counted separately; degraded cases stay in the metrics and are
 * counted so the renderer can refuse to present them as a clean measurement.
 */
export function aggregateRetrieval(
  results: readonly RetrievalCaseResult[],
  corpus: RetrievalCorpusContext,
  k: number = RETRIEVAL_TOP_K,
  lane: RetrievalLane = "hybrid",
  now: Date = new Date(),
): RetrievalReport {
  const scorable = results.filter((r) => !r.retrievalError);
  return {
    generatedAt: now.toISOString(),
    lane,
    k,
    scoredCases: scorable.length,
    meanRecallAtK: mean(scorable.map((r) => r.recallAtK)),
    mrr: mean(scorable.map((r) => r.reciprocalRank)),
    retrievalErrors: results.length - scorable.length,
    degradedCases: scorable.filter((r) => r.degraded).length,
    missingGoldenDocs: corpus.missingGoldenDocs,
    corpusChunks: corpus.corpusChunks,
    corpusDocs: corpus.corpusDocs,
    byStyle: summarizeByStyle(results),
    results,
  };
}
