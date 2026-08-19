/**
 * Unit tests for the retrieval eval scoring (pure functions).
 *
 * These measure retrieval quality against a golden set: did the retriever return
 * the document that actually answers the query, and how high did it rank?
 * Everything here is arithmetic over array literals — no Postgres, no Ollama,
 * no LLM, $0.
 *
 * Every function gets a true positive AND a true negative; the negative is the
 * one that catches over-matching.
 */

import { describe, it, expect } from "vitest";
import {
  RETRIEVAL_TOP_K,
  aggregateRetrieval,
  findMissingGoldenDocs,
  mean,
  recallAtK,
  reciprocalRank,
  scoreRetrievalCase,
  toRankedDocIds,
  type RetrievalCorpusContext,
  type RetrievalObservation,
} from "../../../src/eval/retrieval-scoring.js";
import type { RetrievalGoldenCase } from "../../../src/eval/retrieval-golden.js";

const goldenCase = (over: Partial<RetrievalGoldenCase> = {}): RetrievalGoldenCase => ({
  id: "c1",
  query: "why did we choose LangGraph",
  expectedDocs: ["docs/decisions/001-why-langgraph.md"],
  rationale: "fixture",
  ...over,
});

const obs = (over: Partial<RetrievalObservation> = {}): RetrievalObservation => ({
  rankedDocs: [],
  mode: "hybrid",
  ...over,
});

const CLEAN_CORPUS: RetrievalCorpusContext = {
  corpusChunks: 478,
  corpusDocs: 113,
  missingGoldenDocs: [],
};

// ── toRankedDocIds ────────────────────────────────────────────────────────────

describe("toRankedDocIds", () => {
  it("projects chunk hits onto distinct documents, first occurrence winning", () => {
    // Arrange — doc A contributes chunks at rank 1 and 3.
    const hits = [
      { metadata: { source_path: "a.md" } },
      { metadata: { source_path: "b.md" } },
      { metadata: { source_path: "a.md" } },
    ];

    // Act
    const ranked = toRankedDocIds(hits);

    // Assert
    expect(ranked).toEqual(["a.md", "b.md"]);
  });

  it("does NOT rank a hit whose source_path is missing, empty, or not a string", () => {
    const hits = [
      { metadata: {} },
      { metadata: { source_path: "   " } },
      { metadata: { source_path: 42 } },
      { metadata: { source_path: "real.md" } },
    ];

    expect(toRankedDocIds(hits)).toEqual(["real.md"]);
  });

  it("trims whitespace so a padded path is not treated as a different document", () => {
    const hits = [{ metadata: { source_path: " a.md " } }, { metadata: { source_path: "a.md" } }];

    expect(toRankedDocIds(hits)).toEqual(["a.md"]);
  });
});

// ── recallAtK ─────────────────────────────────────────────────────────────────

describe("recallAtK", () => {
  it("is 1 when the single expected document is inside the cutoff", () => {
    expect(recallAtK(["x.md", "want.md", "y.md"], ["want.md"], 5)).toBe(1);
  });

  it("is 0 when the expected document ranks BELOW the cutoff", () => {
    // want.md is at rank 6 — retrieved, but not by an agent reading top-5.
    const ranked = ["a.md", "b.md", "c.md", "d.md", "e.md", "want.md"];

    expect(recallAtK(ranked, ["want.md"], 5)).toBe(0);
  });

  it("is the fraction found when a case expects several documents", () => {
    expect(recallAtK(["a.md", "b.md"], ["a.md", "z.md"], 5)).toBe(0.5);
  });

  it("is 0 (never 1) when the case declares no expected documents", () => {
    expect(recallAtK(["a.md"], [], 5)).toBe(0);
  });

  it("is 0 for a non-positive cutoff rather than dividing by nothing", () => {
    expect(recallAtK(["a.md"], ["a.md"], 0)).toBe(0);
  });
});

// ── reciprocalRank ────────────────────────────────────────────────────────────

describe("reciprocalRank", () => {
  it("is 1 when the first expected document is ranked first", () => {
    expect(reciprocalRank(["want.md", "b.md"], ["want.md"], 5)).toBe(1);
  });

  it("is 1/3 when the first expected document is ranked third", () => {
    expect(reciprocalRank(["a.md", "b.md", "want.md"], ["want.md"], 5)).toBeCloseTo(1 / 3);
  });

  it("is 0 when no expected document appears within the cutoff", () => {
    expect(reciprocalRank(["a.md", "b.md"], ["want.md"], 5)).toBe(0);
  });

  it("uses the FIRST expected document found, not the best-declared one", () => {
    expect(reciprocalRank(["second.md", "first.md"], ["first.md", "second.md"], 5)).toBe(1);
  });
});

// ── mean ──────────────────────────────────────────────────────────────────────

describe("mean", () => {
  it("averages the values", () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5);
  });

  it("is 0 (never NaN) for an empty list", () => {
    expect(mean([])).toBe(0);
  });
});

// ── findMissingGoldenDocs ─────────────────────────────────────────────────────

describe("findMissingGoldenDocs", () => {
  it("names a golden document that is absent from the corpus", () => {
    const cases = [goldenCase({ expectedDocs: ["present.md", "gone.md"] })];

    expect(findMissingGoldenDocs(cases, ["present.md", "other.md"])).toEqual(["gone.md"]);
  });

  it("returns nothing when every golden document exists", () => {
    const cases = [goldenCase({ expectedDocs: ["present.md"] })];

    expect(findMissingGoldenDocs(cases, ["present.md", "other.md"])).toEqual([]);
  });

  it("does NOT treat a path-prefix sibling as the golden document", () => {
    const cases = [goldenCase({ expectedDocs: ["docs/rules/TEST-PYRAMID.md"] })];

    expect(findMissingGoldenDocs(cases, ["docs/rules/TEST-PYRAMID.md.bak"])).toEqual([
      "docs/rules/TEST-PYRAMID.md",
    ]);
  });
});

// ── scoreRetrievalCase ────────────────────────────────────────────────────────

describe("scoreRetrievalCase", () => {
  it("scores a hit at rank 2 as full recall and reciprocal rank 0.5", () => {
    const result = scoreRetrievalCase(
      goldenCase({ expectedDocs: ["want.md"] }),
      obs({ rankedDocs: ["a.md", "want.md"] }),
    );

    expect(result.recallAtK).toBe(1);
    expect(result.reciprocalRank).toBe(0.5);
    expect(result.retrievalError).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it("marks a keyword-fallback observation as degraded while still scoring it", () => {
    const result = scoreRetrievalCase(
      goldenCase({ expectedDocs: ["want.md"] }),
      obs({ rankedDocs: ["want.md"], mode: "keyword-fallback", degradedReason: "ollama down" }),
    );

    expect(result.degraded).toBe(true);
    expect(result.recallAtK).toBe(1);
  });

  it("zeroes an errored case and flags it rather than scoring it as a miss", () => {
    const result = scoreRetrievalCase(
      goldenCase(),
      obs({ rankedDocs: [], error: "query: connection refused" }),
    );

    expect(result.retrievalError).toBe(true);
    expect(result.recallAtK).toBe(0);
    expect(result.degraded).toBe(false);
  });

  it("does NOT treat a blank error string as a failure", () => {
    const result = scoreRetrievalCase(
      goldenCase({ expectedDocs: ["want.md"] }),
      obs({ rankedDocs: ["want.md"], error: "   " }),
    );

    expect(result.retrievalError).toBe(false);
  });
});

// ── aggregateRetrieval ────────────────────────────────────────────────────────

describe("aggregateRetrieval", () => {
  const hit = scoreRetrievalCase(
    goldenCase({ id: "hit", expectedDocs: ["want.md"] }),
    obs({ rankedDocs: ["want.md"] }),
  );
  const miss = scoreRetrievalCase(
    goldenCase({ id: "miss", expectedDocs: ["want.md"] }),
    obs({ rankedDocs: ["other.md"] }),
  );
  const errored = scoreRetrievalCase(
    goldenCase({ id: "err", expectedDocs: ["want.md"] }),
    obs({ error: "embed: ollama unreachable" }),
  );

  it("averages recall and MRR over the scorable cases", () => {
    const report = aggregateRetrieval([hit, miss], CLEAN_CORPUS);

    expect(report.scoredCases).toBe(2);
    expect(report.meanRecallAtK).toBe(0.5);
    expect(report.mrr).toBe(0.5);
    expect(report.retrievalErrors).toBe(0);
  });

  it("EXCLUDES an errored case from the metrics and counts it separately", () => {
    // One hit + one error must read as 100% over 1 case, not 50% over 2 — a
    // crashed query is not evidence that retrieval ranked badly.
    const report = aggregateRetrieval([hit, errored], CLEAN_CORPUS);

    expect(report.scoredCases).toBe(1);
    expect(report.meanRecallAtK).toBe(1);
    expect(report.retrievalErrors).toBe(1);
    expect(report.results).toHaveLength(2);
  });

  it("KEEPS a degraded case in the metrics and counts it, so it cannot hide", () => {
    const degraded = scoreRetrievalCase(
      goldenCase({ id: "deg", expectedDocs: ["want.md"] }),
      obs({ rankedDocs: ["want.md"], mode: "keyword-fallback", degradedReason: "ollama down" }),
    );

    const report = aggregateRetrieval([degraded], CLEAN_CORPUS);

    expect(report.scoredCases).toBe(1);
    expect(report.degradedCases).toBe(1);
    expect(report.meanRecallAtK).toBe(1);
  });

  it("reports zeroes (never NaN) when every case errored", () => {
    const report = aggregateRetrieval([errored], CLEAN_CORPUS);

    expect(report.scoredCases).toBe(0);
    expect(report.meanRecallAtK).toBe(0);
    expect(report.mrr).toBe(0);
  });

  it("carries the corpus denominator and missing golden docs into the report", () => {
    const report = aggregateRetrieval([hit], {
      corpusChunks: 478,
      corpusDocs: 113,
      missingGoldenDocs: ["gone.md"],
    });

    expect(report.corpusChunks).toBe(478);
    expect(report.corpusDocs).toBe(113);
    expect(report.missingGoldenDocs).toEqual(["gone.md"]);
    expect(report.k).toBe(RETRIEVAL_TOP_K);
  });
});
