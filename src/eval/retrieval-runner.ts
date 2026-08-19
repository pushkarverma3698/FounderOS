/**
 * FounderOS — Retrieval Eval Runner + Report Renderer
 * ====================================================
 * Drives the retrieval golden set through an INJECTED retriever and renders the
 * report. Injection is deliberate (mirrors src/eval/runner.ts's `Invoker`):
 *   - unit tests pass a deterministic fake retriever → zero cost, reproducible,
 *     no Postgres and no Ollama
 *   - `pnpm eval:retrieval` passes the real hybrid pgvector retriever
 *
 * The runner never throws on a case failure — a retriever error is captured as a
 * failed observation so one dead query cannot abort the whole run.
 *
 * Reporting invariant, inherited from src/infra/rag-optimization-sweep.ts and
 * binding here: **a check that did not run and a check that came back clean must
 * never look the same from outside.** Three ways this run can be untrustworthy —
 * keyword-only degradation (the embedder was down), a retrieval error, or a
 * golden document missing from the corpus — each get their own named line at the
 * TOP of the report, and each makes the run non-trustworthy so the CLI can exit
 * non-zero. A recall figure computed under keyword-only retrieval is never
 * printed as if it measured semantic retrieval.
 */

import {
  RETRIEVAL_TOP_K,
  aggregateRetrieval,
  scoreRetrievalCase,
  type RetrievalCaseResult,
  type RetrievalCorpusContext,
  type RetrievalObservation,
  type RetrievalReport,
} from "./retrieval-scoring.js";
import type { RetrievalGoldenCase } from "./retrieval-golden.js";

export type { RetrievalObservation, RetrievalReport } from "./retrieval-scoring.js";

/** Runs one golden query and reports the ranked documents retrieval returned. */
export type Retriever = (query: string, k: number) => Promise<RetrievalObservation>;

/** Corpus context with no measurement — used when the corpus could not be counted. */
export const UNKNOWN_CORPUS: RetrievalCorpusContext = {
  corpusChunks: null,
  corpusDocs: null,
  missingGoldenDocs: [],
};

/**
 * Run every case through `retrieve`, score it, and aggregate. Cases run
 * sequentially so load on the embedder and the vector store stays predictable;
 * order is preserved.
 */
export async function runRetrievalEval(
  cases: readonly RetrievalGoldenCase[],
  retrieve: Retriever,
  corpus: RetrievalCorpusContext = UNKNOWN_CORPUS,
  k: number = RETRIEVAL_TOP_K,
): Promise<RetrievalReport> {
  const results: RetrievalCaseResult[] = [];
  for (const goldenCase of cases) {
    let observation: RetrievalObservation;
    try {
      observation = await retrieve(goldenCase.query, k);
    } catch (err) {
      observation = {
        rankedDocs: [],
        mode: "vector",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(scoreRetrievalCase(goldenCase, observation, k));
  }
  return aggregateRetrieval(results, corpus, k);
}

/**
 * Can the headline numbers be read as a measurement of this system's retrieval?
 * False when any case degraded to keyword-only, any case errored, a golden
 * document is missing from the corpus, or the corpus could not be counted at all.
 */
export function isTrustworthy(report: RetrievalReport): boolean {
  return (
    report.retrievalErrors === 0 &&
    report.degradedCases === 0 &&
    report.missingGoldenDocs.length === 0 &&
    report.corpusChunks !== null &&
    report.scoredCases > 0
  );
}

/** Round a ratio in [0,1] to one decimal place of percent. */
function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** The named reasons this run's numbers cannot be trusted, worst first. */
function caveats(report: RetrievalReport): string[] {
  const lines: string[] = [];
  if (report.corpusChunks === null) {
    lines.push(
      "**Corpus not counted.** The run could not read the size of `brain.turicks_brain`, " +
        "so the denominator behind every number below is unknown.",
    );
  }
  if (report.degradedCases > 0) {
    const reason =
      report.results.find((r) => r.degraded)?.observation.degradedReason ?? "reason not reported";
    lines.push(
      `**DEGRADED RETRIEVAL — ${report.degradedCases} of ${report.scoredCases} scored queries ran ` +
        `keyword-only because semantic search was unavailable (${reason}). The recall and MRR ` +
        "below therefore do NOT measure semantic retrieval. Bring the embedder up and re-run " +
        "before quoting these numbers.",
    );
  }
  if (report.retrievalErrors > 0) {
    lines.push(
      `**${report.retrievalErrors} query/queries failed outright** and are excluded from recall ` +
        `and MRR — the metrics below are computed over ${report.scoredCases} queries, not the ` +
        `full golden set.`,
    );
  }
  if (report.missingGoldenDocs.length > 0) {
    lines.push(
      `**${report.missingGoldenDocs.length} golden document(s) are not in the corpus**, so their ` +
        "cases cannot pass no matter how good retrieval is — this deflates recall for a reason " +
        `that is not retrieval quality: ${report.missingGoldenDocs.join(", ")}.`,
    );
  }
  return lines;
}

/** The denominator block — what was measured, against what, at what cutoff. */
function denominator(report: RetrievalReport): string[] {
  const corpus =
    report.corpusChunks === null || report.corpusDocs === null
      ? "not counted"
      : `${report.corpusChunks} chunks across ${report.corpusDocs} distinct documents`;
  const modes = new Map<string, number>();
  for (const r of report.results) {
    if (r.retrievalError) continue;
    modes.set(r.observation.mode, (modes.get(r.observation.mode) ?? 0) + 1);
  }
  const modeLine =
    [...modes.entries()].map(([m, n]) => `${n} ${m}`).join(", ") || "no query returned results";
  return [
    "## What was measured",
    "",
    `- Corpus (\`brain.turicks_brain\`): ${corpus}`,
    `- Golden cases run: ${report.results.length} (${report.scoredCases} scored, ` +
      `${report.retrievalErrors} errored)`,
    `- Cutoff: top-${report.k} chunks, projected to the distinct documents the agent would see`,
    `- Retrieval mode per query: ${modeLine}`,
  ];
}

/** Cases that retrieval missed entirely, then partial hits — the fix list. */
function misses(report: RetrievalReport): string[] {
  const ranked = report.results
    .filter((r) => !r.retrievalError && r.recallAtK < 1)
    .sort((a, b) => a.recallAtK - b.recallAtK);
  if (ranked.length === 0) {
    return ["## Misses (0)", "", "Every expected document was retrieved within top-k."];
  }
  return [
    `## Misses (${ranked.length}) — worst first`,
    "",
    ...ranked.map((r) => {
      const want = r.goldenCase.expectedDocs.join(", ");
      const got = r.observation.rankedDocs.slice(0, report.k).join(", ") || "nothing";
      return (
        `- **${r.goldenCase.id}** — recall@${report.k} ${pct(r.recallAtK)}\n` +
        `  - query: "${r.goldenCase.query}"\n` +
        `  - expected: ${want}\n` +
        `  - retrieved: ${got}`
      );
    }),
  ];
}

/** Full per-case table, so no row is hidden behind the average. */
function caseTable(report: RetrievalReport): string[] {
  const rows = report.results.map((r) => {
    const rank = r.reciprocalRank > 0 ? String(Math.round(1 / r.reciprocalRank)) : "–";
    const status = r.retrievalError ? `error: ${r.observation.error ?? ""}` : r.observation.mode;
    return `| ${r.goldenCase.id} | ${pct(r.recallAtK)} | ${rank} | ${status} |`;
  });
  return [
    `## All cases (${report.results.length})`,
    "",
    `| case | recall@${report.k} | rank of first expected doc | retrieval mode |`,
    "|---|---|---|---|",
    ...rows,
  ];
}

/** Render the full retrieval eval report as markdown. Pure string generation. */
export function renderRetrievalReport(report: RetrievalReport): string {
  const trustworthy = isTrustworthy(report);
  const notes = caveats(report);

  const verdict = trustworthy
    ? `**Trustworthy run.** recall@${report.k} = ${pct(report.meanRecallAtK)}, ` +
      `MRR = ${report.mrr.toFixed(3)} over ${report.scoredCases} golden queries.`
    : `**NOT A CLEAN MEASUREMENT — do not quote these numbers as this system's retrieval ` +
      `quality.** ${notes.length} problem(s) below explain why.`;

  return [
    "# FounderOS — Retrieval Eval (recall@k + MRR)",
    "",
    `_Generated: ${report.generatedAt}_`,
    "",
    verdict,
    "",
    ...(notes.length > 0 ? ["## Why this run is not clean", "", ...notes.map((n) => `- ${n}`), ""] : []),
    "## Metrics",
    "",
    "| Metric | Value | Computed over |",
    "|---|---|---|",
    `| recall@${report.k} | ${pct(report.meanRecallAtK)} | ${report.scoredCases} scored queries |`,
    `| MRR (top-${report.k}) | ${report.mrr.toFixed(3)} | ${report.scoredCases} scored queries |`,
    "",
    ...denominator(report),
    "",
    ...misses(report),
    "",
    ...caseTable(report),
    "",
  ].join("\n");
}
