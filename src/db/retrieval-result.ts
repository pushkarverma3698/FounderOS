/**
 * Typed retrieval results + mechanical citations (spec §1.1 F4).
 * ==============================================================
 * Every cross-boundary payload in v3 is Zod-validated except retrieval, which
 * returned free strings. This makes a retrieved passage a typed record: a
 * malformed or source-less "result" fails validation instead of flowing on as
 * something the synthesizer could present as a real citation. Rendering then
 * derives from validated data, so a citation always points at a real retrieved
 * source (zero-hallucination is a mechanism, not a hope).
 */
import { z } from "zod";
import type { RagHit } from "./rag-search.js";
import type { HybridOk } from "./rag-hybrid.js";

export const RetrievalResultSchema = z.object({
  /** Where the chunk came from — a file path, URL, or doc id. Never empty. */
  source: z.string().min(1),
  /** Optional document class (decision | conversation | resume | …). */
  doc_type: z.string().min(1).optional(),
  /** Retrieval score (cosine, RRF, or term-overlap depending on path). */
  score: z.number(),
  /** The retrieved text. Never empty — an empty chunk is not a citable result. */
  chunk: z.string().min(1),
  /** Pre-rendered citation token, e.g. "[ADR-001.md]". */
  citation: z.string().min(1),
});

export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

/**
 * Project a raw {@link RagHit} into a {@link RetrievalResult}. Source resolves
 * from the store's source field (source_path / source_file / source_url), then a
 * generic `source`, then "unknown" — so a citation is always renderable even for
 * a sparsely-tagged row.
 */
export function toRetrievalResult(hit: RagHit, sourceField: string): RetrievalResult {
  const source =
    (hit.metadata[sourceField] as string | undefined) ??
    (hit.metadata["source"] as string | undefined) ??
    "unknown";
  const docType = hit.metadata["doc_type"];
  const result: RetrievalResult = {
    source,
    score: hit.score,
    chunk: hit.content.trim(),
    citation: `[${source}]`,
  };
  if (typeof docType === "string" && docType.length > 0) result.doc_type = docType;
  return result;
}

/** Render validated results as numbered, cited passages (most-relevant first). */
export function renderRetrieval(results: readonly RetrievalResult[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}". The knowledge base may not have this information yet.`;
  }
  return results
    .map((r, i) => {
      const type = r.doc_type ? ` ${r.doc_type}` : "";
      return `${i + 1}. ${r.citation}${type} (score ${r.score.toFixed(2)})\n${r.chunk}`;
    })
    .join("\n\n");
}

/**
 * Discriminated failure so a tool can report the REAL failing component. Every
 * error case flows through here so a missing table, an empty store, or a DB
 * outage never gets mislabeled as "Ollama unavailable" (see ragErrorMessage) —
 * that mislabeling cost a production debugging session (CLAUDE.md rule #22).
 */
export interface RagFailure {
  stage: "embed" | "query";
  message: string;
}

/**
 * Render a successful hybrid result. Hits are projected into validated
 * RetrievalResults (F4) so citations render mechanically from real retrieved
 * sources; a degraded (keyword-only) run is banner-flagged so the founder never
 * mistakes thin results for the full set.
 */
export function renderRagSuccess(result: HybridOk, query: string, label: string, sourceField: string): string {
  const suffix =
    result.mode === "hybrid" ? ", hybrid" : result.mode === "keyword-fallback" ? ", keyword-only" : "";
  const banner =
    result.mode === "keyword-fallback"
      ? `⚠️ Semantic search unavailable (${result.degradedReason}) — showing keyword matches only; recall may be reduced.\n\n`
      : "";
  // Validate at the boundary: a malformed/source-less hit is dropped, never
  // rendered as a citable source (F4 — hallucinated sources become a typed miss).
  const results = result.hits
    .map((h) => RetrievalResultSchema.safeParse(toRetrievalResult(h, sourceField)))
    .filter((p) => p.success)
    .map((p) => p.data);
  return (
    `${banner}${label} search for "${query}" (${results.length} results${suffix}):\n\n` +
    renderRetrieval(results, query)
  );
}

/** Build an accurate, actionable error that names the REAL failing component. */
export function ragErrorMessage(store: string, failure: RagFailure): string {
  if (failure.stage === "embed") {
    return (
      `${store} search failed: could not embed the query — Ollama is unavailable. ` +
      `Check the ollama container is up and 'nomic-embed-text' is pulled. (${failure.message})`
    );
  }
  // stage === "query": Postgres/pgvector problem — do NOT blame Ollama.
  return (
    `${store} search failed: the vector store query errored (Postgres/pgvector), not Ollama. ` +
    `Check the pgvector extension is installed and the table exists + is populated ` +
    `(run 'pnpm brain:sync'). (${failure.message})`
  );
}
