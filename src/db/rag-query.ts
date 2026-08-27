/**
 * The shared RAG retrieval engine — table + query + topK (+ optional metadata
 * filter) → a fused, optionally-reranked HybridResult. RAGFlow (if configured)
 * bypasses pgvector entirely; otherwise vector ⊕ keyword are fused with RRF
 * (src/db/rag-hybrid.ts) and optionally reranked (src/db/rag-rerank.ts).
 *
 * Every RAG-backed tool (search_knowledge, search_turicks_brain,
 * search_personal_rag, search_research_cache) calls `runRagSearch` — there is
 * exactly one retrieval path, so a chunking, fusion, or rerank change is felt
 * identically everywhere instead of drifting between tool-local copies.
 */
import { childLogger } from "../infra/logger.js";
import { embedTextCached } from "../lib/embed.js";
import { searchRagTable, keywordSearchRagTable, type RagTable, type RagHit, type RagFilter } from "./rag-search.js";
import {
  hybridRagSearch,
  RagStageError,
  type HybridDeps,
  type HybridResult,
} from "./rag-hybrid.js";
import { rerankHits, shouldRerank } from "./rag-rerank.js";
import { RAG_RERANK_ENABLED } from "../core/config.js";
import { getRagflowClient } from "../infra/ragflow.js";

const log = childLogger({ module: "db:rag-query" });

/** When rerank is on, fuse a wider candidate pool then let the model pick the
 *  top-k from it (spec §1.1 F5: "top-20 fused → rerank → top-5"). */
export const RERANK_CANDIDATE_POOL = 20;

export interface RunRagSearchOpts {
  filter?: RagFilter;
}

/**
 * Real vector retrieval: embed (Ollama) then pgvector query. Throws a
 * RagStageError so a failure keeps its stage — embedder vs vector store —
 * even after passing through the hybrid orchestrator's Promise.allSettled.
 */
async function realVectorSearch(
  table: RagTable,
  query: string,
  topK: number,
  opts?: RunRagSearchOpts,
): Promise<RagHit[]> {
  let embedding: number[];
  try {
    embedding = await embedTextCached(query); // Redis-cached (F3); fail-open to a fresh embed
  } catch (err) {
    throw new RagStageError("embed", err instanceof Error ? err.message : String(err));
  }
  try {
    // Only forward opts when set — keeps the call shape identical to the
    // pre-unification signature for the common (unfiltered) case.
    return opts ? await searchRagTable(table, embedding, topK, opts) : await searchRagTable(table, embedding, topK);
  } catch (err) {
    throw new RagStageError("query", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Retrieve `topK` hits for `query` from `table`. `opts.filter` narrows both the
 * vector and keyword legs by an ANDed metadata equality clause (bound param —
 * see searchRagTable/keywordSearchRagTable).
 */
export async function runRagSearch(
  table: RagTable,
  query: string,
  topK: number,
  opts?: RunRagSearchOpts,
): Promise<HybridResult> {
  // RAGFlow backend: skip Ollama/pgvector entirely, query RAGFlow's own hybrid
  // pipeline. Returned as a single ranked list (mode "vector" — no local fusion).
  // Metadata filtering is not supported on this backend.
  const ragflow = getRagflowClient();
  if (ragflow) {
    try {
      const chunks = await ragflow.search(query, topK);
      const hits: RagHit[] = chunks.map((c) => ({
        content: c.content,
        score: c.score,
        metadata: { source_path: c.document_name ?? "", dataset: c.dataset_name ?? "" },
      }));
      log.debug({ table, query, count: hits.length, backend: "ragflow" }, "RAG search");
      return { hits, mode: "vector" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ table, query, err }, "RAGFlow search failed");
      return { error: { stage: "query", message } };
    }
  }

  // pgvector backend (default): hybrid (vector ⊕ keyword) fused with RRF, with a
  // labelled keyword fallback if the embedder is down (see src/db/rag-hybrid.ts).
  // When rerank is on, fuse a wider pool so the reranker has candidates to pick from.
  const fetchK = RAG_RERANK_ENABLED ? Math.max(topK, RERANK_CANDIDATE_POOL) : topK;
  const deps: HybridDeps = {
    vectorSearch: (t, q, k) => realVectorSearch(t, q, k, opts),
    keywordSearch: (t, q, k) => (opts ? keywordSearchRagTable(t, q, k, opts) : keywordSearchRagTable(t, q, k)),
  };
  const result = await hybridRagSearch(table, query, fetchK, deps);
  if ("error" in result) {
    log.error({ table, query, stage: result.error.stage }, "RAG hybrid search failed");
    return result;
  }

  // Optional local rerank (F5, flag-gated, fail-open). Skipped in keyword-fallback
  // (the embedder/Ollama is down, so reranking would only burn the model timeout).
  const rerank = shouldRerank(RAG_RERANK_ENABLED, result.mode, result.hits.length);
  const hits = rerank ? await rerankHits(query, result.hits, topK) : result.hits.slice(0, topK);
  log.debug({ table, query, count: hits.length, mode: result.mode, reranked: rerank }, "RAG search");
  return { ...result, hits };
}
