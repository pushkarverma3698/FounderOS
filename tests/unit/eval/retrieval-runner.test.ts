/**
 * Unit tests for the retrieval eval runner, its trustworthiness verdict, and the
 * report renderer.
 *
 * The retriever is INJECTED, so these run with no Postgres, no Ollama and no
 * LLM. The most important assertions here are the negative ones: that a
 * degraded (keyword-only) run and a clean run can never look the same in the
 * rendered report.
 */

import { describe, it, expect } from "vitest";
import {
  UNKNOWN_CORPUS,
  isTrustworthy,
  renderRetrievalReport,
  runRetrievalEval,
  type Retriever,
} from "../../../src/eval/retrieval-runner.js";
import {
  aggregateRetrieval,
  scoreRetrievalCase,
  type RetrievalCorpusContext,
  type RetrievalObservation,
} from "../../../src/eval/retrieval-scoring.js";
import {
  RETRIEVAL_GOLDEN_SET,
  type RetrievalGoldenCase,
} from "../../../src/eval/retrieval-golden.js";

const CASES: readonly RetrievalGoldenCase[] = [
  { id: "c1", query: "why LangGraph", expectedDocs: ["a.md"], rationale: "fixture" },
  { id: "c2", query: "why drizzle", expectedDocs: ["b.md"], rationale: "fixture" },
];

const CLEAN_CORPUS: RetrievalCorpusContext = {
  corpusChunks: 478,
  corpusDocs: 113,
  missingGoldenDocs: [],
};

/** A fake retriever that returns a canned ranking per query. */
const fakeRetriever =
  (byQuery: Record<string, RetrievalObservation>): Retriever =>
  async (query) =>
    byQuery[query] ?? { rankedDocs: [], mode: "hybrid" };

// ── runRetrievalEval ──────────────────────────────────────────────────────────

describe("runRetrievalEval", () => {
  it("scores every case against the injected retriever", async () => {
    const report = await runRetrievalEval(
      CASES,
      fakeRetriever({
        "why LangGraph": { rankedDocs: ["a.md"], mode: "hybrid" },
        "why drizzle": { rankedDocs: ["zzz.md"], mode: "hybrid" },
      }),
      CLEAN_CORPUS,
    );

    expect(report.results).toHaveLength(2);
    expect(report.meanRecallAtK).toBe(0.5);
    expect(report.retrievalErrors).toBe(0);
  });

  it("captures a thrown retriever error as a failed case instead of aborting the run", async () => {
    const throwing: Retriever = async (query) => {
      if (query === "why LangGraph") throw new Error("ollama unreachable");
      return { rankedDocs: ["b.md"], mode: "hybrid" };
    };

    const report = await runRetrievalEval(CASES, throwing, CLEAN_CORPUS);

    expect(report.results).toHaveLength(2);
    expect(report.retrievalErrors).toBe(1);
    expect(report.scoredCases).toBe(1);
    expect(report.meanRecallAtK).toBe(1);
  });

  it("defaults to an unknown corpus when none is supplied", async () => {
    const report = await runRetrievalEval(CASES, fakeRetriever({}));

    expect(report.corpusChunks).toBeNull();
    expect(UNKNOWN_CORPUS.corpusDocs).toBeNull();
  });
});

// ── isTrustworthy ─────────────────────────────────────────────────────────────

describe("isTrustworthy", () => {
  const build = (
    observations: readonly RetrievalObservation[],
    corpus: RetrievalCorpusContext = CLEAN_CORPUS,
  ) =>
    aggregateRetrieval(
      observations.map((o, i) => scoreRetrievalCase(CASES[i % CASES.length]!, o)),
      corpus,
    );

  it("is true for a clean hybrid run over a counted corpus", () => {
    expect(isTrustworthy(build([{ rankedDocs: ["a.md"], mode: "hybrid" }]))).toBe(true);
  });

  it("is FALSE when any query ran keyword-only", () => {
    const report = build([
      { rankedDocs: ["a.md"], mode: "keyword-fallback", degradedReason: "ollama down" },
    ]);

    expect(isTrustworthy(report)).toBe(false);
  });

  it("is FALSE when any query errored", () => {
    expect(isTrustworthy(build([{ rankedDocs: [], mode: "vector", error: "boom" }]))).toBe(false);
  });

  it("is FALSE when a golden document is missing from the corpus", () => {
    const report = build([{ rankedDocs: ["a.md"], mode: "hybrid" }], {
      ...CLEAN_CORPUS,
      missingGoldenDocs: ["a.md"],
    });

    expect(isTrustworthy(report)).toBe(false);
  });

  it("is FALSE when the corpus could not be counted", () => {
    const report = build([{ rankedDocs: ["a.md"], mode: "hybrid" }], UNKNOWN_CORPUS);

    expect(isTrustworthy(report)).toBe(false);
  });
});

// ── renderRetrievalReport ─────────────────────────────────────────────────────

describe("renderRetrievalReport", () => {
  it("prints the corpus denominator, the metrics, and a trustworthy verdict", () => {
    const report = aggregateRetrieval(
      [scoreRetrievalCase(CASES[0]!, { rankedDocs: ["a.md"], mode: "hybrid" })],
      CLEAN_CORPUS,
    );

    const md = renderRetrievalReport(report);

    expect(md).toContain("Trustworthy run");
    expect(md).toContain("478 chunks across 113 distinct documents");
    expect(md).toContain("recall@5");
    expect(md).toContain("100.0%");
  });

  it("refuses to present a degraded run as a measurement, and names the reason", () => {
    const report = aggregateRetrieval(
      [
        scoreRetrievalCase(CASES[0]!, {
          rankedDocs: ["a.md"],
          mode: "keyword-fallback",
          degradedReason: "Ollama embeddings unreachable at http://localhost:11434",
        }),
      ],
      CLEAN_CORPUS,
    );

    const md = renderRetrievalReport(report);

    expect(md).toContain("NOT A CLEAN MEASUREMENT");
    expect(md).toContain("DEGRADED RETRIEVAL");
    expect(md).toContain("Ollama embeddings unreachable");
    expect(md).not.toContain("Trustworthy run");
  });

  it("names a missing golden document as a non-retrieval cause of low recall", () => {
    const report = aggregateRetrieval(
      [scoreRetrievalCase(CASES[0]!, { rankedDocs: [], mode: "hybrid" })],
      { ...CLEAN_CORPUS, missingGoldenDocs: ["a.md"] },
    );

    const md = renderRetrievalReport(report);

    expect(md).toContain("golden document(s) are not in the corpus");
    expect(md).toContain("a.md");
  });

  it("says so explicitly when the corpus could not be counted", () => {
    const report = aggregateRetrieval(
      [scoreRetrievalCase(CASES[0]!, { rankedDocs: ["a.md"], mode: "hybrid" })],
      UNKNOWN_CORPUS,
    );

    const md = renderRetrievalReport(report);

    expect(md).toContain("Corpus not counted");
    expect(md).toContain("not counted");
  });

  it("lists misses worst-first with the query, the expected doc, and what came back", () => {
    const report = aggregateRetrieval(
      [
        scoreRetrievalCase(CASES[0]!, { rankedDocs: ["a.md"], mode: "hybrid" }),
        scoreRetrievalCase(CASES[1]!, { rankedDocs: ["wrong.md"], mode: "hybrid" }),
      ],
      CLEAN_CORPUS,
    );

    const md = renderRetrievalReport(report);

    expect(md).toContain("## Misses (1)");
    expect(md).toContain("why drizzle");
    expect(md).toContain("expected: b.md");
    expect(md).toContain("retrieved: wrong.md");
  });

  it("says every document was found when there are no misses", () => {
    const report = aggregateRetrieval(
      [scoreRetrievalCase(CASES[0]!, { rankedDocs: ["a.md"], mode: "hybrid" })],
      CLEAN_CORPUS,
    );

    expect(renderRetrievalReport(report)).toContain("## Misses (0)");
  });
});

// ── the shipped golden set ────────────────────────────────────────────────────

describe("RETRIEVAL_GOLDEN_SET", () => {
  it("has a unique id, a query, at least one expected doc, and a rationale per case", () => {
    const ids = new Set<string>();
    for (const c of RETRIEVAL_GOLDEN_SET) {
      expect(ids.has(c.id), `duplicate case id: ${c.id}`).toBe(false);
      ids.add(c.id);
      expect(c.query.trim().length, `empty query in ${c.id}`).toBeGreaterThan(0);
      expect(c.expectedDocs.length, `no expected docs in ${c.id}`).toBeGreaterThan(0);
      expect(c.rationale.trim().length, `no rationale in ${c.id}`).toBeGreaterThan(0);
    }
  });

  it("expects only repository-relative markdown paths, never a row id", () => {
    // The stable identifier is metadata->>'source_path'. A uuid here would mean
    // the set was keyed on `id`, which gen_random_uuid() regenerates on every
    // re-ingest — the set would silently break on the next `pnpm brain:sync`.
    for (const c of RETRIEVAL_GOLDEN_SET) {
      for (const doc of c.expectedDocs) {
        expect(doc.endsWith(".md"), `${c.id} expects a non-markdown path: ${doc}`).toBe(true);
      }
    }
  });
});
