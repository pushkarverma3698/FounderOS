/**
 * FounderOS — retrieval quality eval against the REAL corpus.
 *
 *   pnpm eval:retrieval
 *
 * Measures recall@5 and MRR for the retrieval golden set against
 * `brain.turicks_brain`, using the SAME hybrid path production uses
 * (`hybridRagSearch` = pgvector vector search ⊕ keyword ILIKE, fused with RRF).
 * $0: embeddings come from local Ollama, ranking is arithmetic, no LLM is called.
 *
 * This file is the collector — it holds every piece of I/O (Postgres, Ollama) so
 * the scoring and reporting in src/eval/retrieval-*.ts stay pure and testable.
 *
 * Exit codes:
 *   0 — the run was clean and the numbers mean what they say
 *   1 — the run happened but is NOT a measurement of semantic retrieval
 *       (embedder down → keyword-only, a query errored, a golden document is
 *       missing from the corpus, or the corpus could not be counted)
 *   2 — the harness itself could not run
 * There is deliberately NO pass threshold on recall. A low recall we can see is
 * the deliverable; gating on a score would only create pressure to tune the
 * golden set until the number looks good.
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { RETRIEVAL_GOLDEN_SET } from "../src/eval/retrieval-golden.js";
import {
  RETRIEVAL_TOP_K,
  findMissingGoldenDocs,
  toRankedDocIds,
  type RetrievalObservation,
} from "../src/eval/retrieval-scoring.js";
import {
  isTrustworthy,
  renderRetrievalReport,
  runRetrievalEval,
  type Retriever,
} from "../src/eval/retrieval-runner.js";
import { hybridRagSearch, RagStageError, type HybridDeps } from "../src/db/rag-hybrid.js";
import { keywordSearchRagTable, searchRagTable, type RagTable } from "../src/db/rag-search.js";
import { embedTextCached } from "../src/lib/embed.js";
import { db, closeDatabaseConnections } from "../src/db/client.js";

/** The store under measurement. The golden set is authored against this table. */
const TABLE: RagTable = "turicks_brain";

/** Where the rendered report is written, alongside the existing eval-report.md. */
const REPORT_PATH = "retrieval-eval-report.md";

/**
 * Embed via Ollama then query pgvector, tagging which stage failed. Mirrors
 * `realVectorSearch` in src/tools/rag.ts, which is not exported and which this
 * task may not modify; the stage tagging is what lets a dead embedder be
 * reported as degradation rather than as bad recall.
 */
async function vectorSearch(table: RagTable, query: string, topK: number) {
  let embedding: number[];
  try {
    embedding = await embedTextCached(query);
  } catch (err) {
    throw new RagStageError("embed", err instanceof Error ? err.message : String(err));
  }
  try {
    return await searchRagTable(table, embedding, topK);
  } catch (err) {
    throw new RagStageError("query", err instanceof Error ? err.message : String(err));
  }
}

const DEPS: HybridDeps = { vectorSearch, keywordSearch: keywordSearchRagTable };

/** The live retriever: production's hybrid path, projected to ranked documents. */
const liveRetriever: Retriever = async (query, k): Promise<RetrievalObservation> => {
  const result = await hybridRagSearch(TABLE, query, k, DEPS);
  if ("error" in result) {
    return {
      rankedDocs: [],
      mode: "vector",
      error: `${result.error.stage}: ${result.error.message}`,
    };
  }
  return {
    rankedDocs: toRankedDocIds(result.hits),
    mode: result.mode,
    ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
  };
};

interface CorpusFacts {
  readonly chunks: number | null;
  readonly docs: number | null;
  readonly paths: readonly string[];
}

/**
 * Count the corpus and list its document paths. Returns nulls rather than
 * throwing, so a DB that cannot be counted is reported as "not counted" instead
 * of aborting the run or, worse, looking like an empty corpus.
 */
async function readCorpusFacts(): Promise<CorpusFacts> {
  try {
    const rows = (await db.execute(sql`
      SELECT metadata->>'source_path' AS source_path, count(*)::int AS chunks
      FROM brain.turicks_brain
      GROUP BY 1
    `)) as unknown as Array<{ source_path: string | null; chunks: number }>;

    let chunks = 0;
    const paths: string[] = [];
    for (const row of rows) {
      const n = Number(row.chunks);
      if (!Number.isFinite(n)) continue; // a NaN would silently poison the total
      chunks += n;
      if (typeof row.source_path === "string" && row.source_path.trim().length > 0) {
        paths.push(row.source_path.trim());
      }
    }
    return { chunks, docs: paths.length, paths };
  } catch (err) {
    process.stderr.write(
      `retrieval-eval: could not count the corpus — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { chunks: null, docs: null, paths: [] };
  }
}

async function main(): Promise<void> {
  const corpusFacts = await readCorpusFacts();
  const report = await runRetrievalEval(
    RETRIEVAL_GOLDEN_SET,
    liveRetriever,
    {
      corpusChunks: corpusFacts.chunks,
      corpusDocs: corpusFacts.docs,
      missingGoldenDocs: findMissingGoldenDocs(RETRIEVAL_GOLDEN_SET, corpusFacts.paths),
    },
    RETRIEVAL_TOP_K,
  );

  const rendered = renderRetrievalReport(report);
  process.stdout.write(`${rendered}\n`);

  const out = resolve(REPORT_PATH);
  await writeFile(out, rendered);
  process.stdout.write(`Report written to ${out}\n`);

  await closeDatabaseConnections().catch(() => undefined); // allow-failopen: eval teardown
  process.exit(isTrustworthy(report) ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`retrieval-eval: harness failed — ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
