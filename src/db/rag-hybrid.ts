/**
 * Hybrid RAG orchestration (spec §1.1 F2 + the keyword-fallback half of F1).
 * ==========================================================================
 * Runs semantic (pgvector) and keyword retrieval in PARALLEL and fuses them
 * with Reciprocal Rank Fusion. Two wins in one path:
 *
 *   1. Recall (F2): a document strong in either signal surfaces; documents
 *      strong in both rank top. Fusion is deterministic (RRF), so no LLM routing
 *      decision is introduced — retrieval stays code, not a prompt (v3 doctrine).
 *   2. Resilience (F1): if the embedder (Ollama) is down, the query no longer
 *      degrades to ZERO results — it falls back to keyword-only, LABELLED as
 *      degraded so the founder knows recall is reduced rather than silently thin.
 *
 * The two retrieval calls are injected (HybridDeps) so every branch is unit-
 * tested at $0; the real wiring lives in src/tools/rag.ts.
 */

import type { RagHit, RagTable } from "./rag-search.js";
import { reciprocalRankFusion } from "./rrf.js";

/** Which retrieval signals actually produced the returned hits. */
export type HybridMode = "hybrid" | "vector" | "keyword-fallback";

export interface HybridOk {
  hits: RagHit[];
  mode: HybridMode;
  /** Set only for `keyword-fallback` — why semantic search was unavailable. */
  degradedReason?: string;
}

export interface HybridErr {
  error: { stage: "embed" | "query"; message: string };
}

export type HybridResult = HybridOk | HybridErr;

/**
 * Error carrying WHICH stage of the vector path failed, so a total failure can
 * still name the real component (embedder vs vector store) — preserving the
 * stage-tagged error UX the single-path tool already had (CLAUDE.md rule #22).
 */
export class RagStageError extends Error {
  constructor(
    public readonly stage: "embed" | "query",
    message: string,
  ) {
    super(message);
    this.name = "RagStageError";
  }
}

export interface HybridDeps {
  /** Embed + pgvector nearest-neighbour. Throws RagStageError on failure. */
  vectorSearch: (table: RagTable, query: string, topK: number) => Promise<RagHit[]>;
  /** Keyword (ILIKE term-overlap) over the same table. Throws on DB failure. */
  keywordSearch: (table: RagTable, query: string, topK: number) => Promise<RagHit[]>;
}

/**
 * Readable text for any thrown value. Exported because every RAG stage must
 * label its failure the same way.
 *
 * The AggregateError branch is load-bearing: Node's happy-eyeballs connect
 * reports a refused Postgres as `AggregateError` over the IPv6 and IPv4
 * attempts, and that wrapper's own `.message` is the empty string. Returning it
 * verbatim rendered a dead database as "Search failed at stage embed: " in the
 * IDE brain MCP — an outage that reads as blank.
 */
export function errText(reason: unknown): string {
  if (reason instanceof AggregateError && reason.errors.length > 0) {
    const causes = reason.errors.map((e) => errText(e)).filter(Boolean);
    if (causes.length > 0) return causes.join("; ");
  }
  if (reason instanceof Error) return reason.message || reason.name;
  return String(reason);
}

/**
 * Retrieve `topK` hits for `query` from `table`, fusing vector + keyword.
 * Never throws — every outcome is a typed result the tool can render.
 */
export async function hybridRagSearch(
  table: RagTable,
  query: string,
  topK: number,
  deps: HybridDeps,
): Promise<HybridResult> {
  const [vec, kw] = await Promise.allSettled([
    deps.vectorSearch(table, query, topK),
    deps.keywordSearch(table, query, topK),
  ]);

  // Both signals available → fuse. (An empty corpus fuses to [] — not an error.)
  if (vec.status === "fulfilled" && kw.status === "fulfilled") {
    const fused = reciprocalRankFusion([vec.value, kw.value], (h) => h.content)
      .slice(0, topK)
      .map((f) => f.item);
    return { hits: fused, mode: "hybrid" };
  }

  // Keyword is an accelerant — its failure must never reduce recall below vector.
  if (vec.status === "fulfilled") {
    return { hits: vec.value.slice(0, topK), mode: "vector" };
  }

  // Embedder/vector down but keyword alive → labelled keyword fallback (F1).
  if (kw.status === "fulfilled") {
    return {
      hits: kw.value.slice(0, topK),
      mode: "keyword-fallback",
      degradedReason: errText(vec.reason),
    };
  }

  // Both failed → surface the vector failure, tagged with its real stage.
  const stage = vec.reason instanceof RagStageError ? vec.reason.stage : "query";
  return { error: { stage, message: errText(vec.reason) } };
}
