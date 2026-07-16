/**
 * FounderOS — RAG Database Tools
 * ================================
 * Two read-only vector-search tools that let the personal department query
 * the founder's two knowledge bases:
 *
 *   searchPersonalRagTool  — searches personal_rag (pgvector table).
 *                            Career, CV, background, skills, payslips, certs.
 *
 *   searchTuricksBrainTool — searches turicks_brain (pgvector table).
 *                            Business decisions, strategy, ADRs, chats, notes.
 *
 * Embeddings are generated locally via Ollama (nomic-embed-text) — RAG text
 * never leaves the machine.  Neither tool writes to the DB (ADR-013/015).
 *
 * Fallback: if Ollama is down the tool soft-fails with an actionable message.
 */

import { childLogger } from "../infra/logger.js";
import { embedTextCached } from "../lib/embed.js";
import { searchRagTable, keywordSearchRagTable, type RagTable, type RagHit } from "../db/rag-search.js";
import {
  hybridRagSearch,
  RagStageError,
  type HybridDeps,
  type HybridOk,
  type HybridResult,
} from "../db/rag-hybrid.js";
import { toRetrievalResult, renderRetrieval, RetrievalResultSchema } from "../db/retrieval-result.js";
import { rerankHits } from "../db/rag-rerank.js";
import { RAG_RERANK_ENABLED } from "../core/config.js";
import { getRagflowClient } from "../infra/ragflow.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:rag" });

/** When rerank is on, fuse a wider candidate pool then let the model pick the
 *  top-k from it (spec §1.1 F5: "top-20 fused → rerank → top-5"). */
const RERANK_CANDIDATE_POOL = 20;

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Discriminated failure so the tool can report the REAL failing component.
 * The old code collapsed every error into "Ollama unavailable" — so a missing
 * table, an empty store, or a DB outage all got blamed on Ollama, and the error
 * was logged at debug level (invisible). That mislabeling cost a production
 * debugging session (see CLAUDE.md rule #22). Stage-tagged errors fix that.
 */
type RagFailure = { stage: "embed" | "query"; message: string };

/**
 * Real vector retrieval: embed (Ollama) then pgvector query. Throws a
 * RagStageError so a failure keeps its stage — embedder vs vector store —
 * even after passing through the hybrid orchestrator's Promise.allSettled.
 */
async function realVectorSearch(table: RagTable, query: string, topK: number): Promise<RagHit[]> {
  let embedding: number[];
  try {
    embedding = await embedTextCached(query); // Redis-cached (F3); fail-open to a fresh embed
  } catch (err) {
    throw new RagStageError("embed", err instanceof Error ? err.message : String(err));
  }
  try {
    return await searchRagTable(table, embedding, topK);
  } catch (err) {
    throw new RagStageError("query", err instanceof Error ? err.message : String(err));
  }
}

const HYBRID_DEPS: HybridDeps = {
  vectorSearch: realVectorSearch,
  keywordSearch: keywordSearchRagTable,
};

async function runRagSearch(table: RagTable, query: string, topK: number): Promise<HybridResult> {
  // RAGFlow backend: skip Ollama/pgvector entirely, query RAGFlow's own hybrid
  // pipeline. Returned as a single ranked list (mode "vector" — no local fusion).
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
  const result = await hybridRagSearch(table, query, fetchK, HYBRID_DEPS);
  if ("error" in result) {
    log.error({ table, query, stage: result.error.stage }, "RAG hybrid search failed");
    return result;
  }

  // Optional local rerank (F5, flag-gated, fail-open). rerankHits returns the
  // fused order unchanged if the model is unavailable — never fewer/worse results.
  const hits = RAG_RERANK_ENABLED
    ? await rerankHits(query, result.hits, topK)
    : result.hits.slice(0, topK);
  log.debug(
    { table, query, count: hits.length, mode: result.mode, reranked: RAG_RERANK_ENABLED },
    "RAG search",
  );
  return { ...result, hits };
}

/**
 * Render a successful hybrid result. Hits are projected into validated
 * RetrievalResults (F4) so citations render mechanically from real retrieved
 * sources; a degraded (keyword-only) run is banner-flagged so the founder never
 * mistakes thin results for the full set.
 */
function renderRagSuccess(result: HybridOk, query: string, label: string, sourceField: string): string {
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
function ragErrorMessage(store: string, failure: RagFailure): string {
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

// ── searchPersonalRagTool ──────────────────────────────────────────────────────

export const searchPersonalRagTool: UnifiedTool = {
  name: "search_personal_rag",
  description:
    "Semantic search over Pushkar's personal knowledge base (personal-rag). " +
    "Contains: CV, career history, skills, certifications, payslips, education, personal identity docs. " +
    "Use for: career questions, 'what are my skills?', salary data, portfolio signals, background checks. " +
    "Read-only, no approval needed. " +
    "Optional doc_type filter: resume | work_experience | certification | education | personal_identity | legal_document | financial.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to search for. E.g. 'TypeScript experience', 'salary history', 'AI projects'. " +
          "Be specific — this is a semantic vector search.",
      },
      doc_type: {
        type: "string",
        description:
          "Optional document type filter: resume | work_experience | certification | education | personal_identity | legal_document | financial",
      },
      top_k: {
        type: "number",
        description: "Number of results (1–10, default 5)",
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = ((args["query"] as string | undefined) ?? "").trim();
    if (!query) {
      return { success: false, error: "query is required" };
    }
    const topK = Math.min(Math.max(Number(args["top_k"] ?? 5), 1), 10);

    const result = await runRagSearch("personal_rag", query, topK);

    if ("error" in result) {
      return { success: false, error: ragErrorMessage("personal-rag", result.error) };
    }

    return { success: true, data: renderRagSuccess(result, query, "Personal knowledge", "source_file") };
  },
};

// ── searchTuricksBrainTool ─────────────────────────────────────────────────────

export const searchTuricksBrainTool: UnifiedTool = {
  name: "search_turicks_brain",
  description:
    "Semantic search over the Turicks Brain knowledge base (vector DB). " +
    "Contains: architectural decisions, business strategy, ADRs, conversation transcripts, " +
    "founder notes, product plans, Turicks/Naggar context. " +
    "Use for: 'what did we decide about X?', 'what is Turicks strategy?', business context, " +
    "prior conversation recall, Naggar Retreat operations. " +
    "Read-only, no approval needed. " +
    "Optional doc_type filter: decision | conversation | doc | note | wiki | website.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to search for. E.g. 'ICP strategy', 'why we chose LangGraph', 'Naggar pricing'. " +
          "Specific queries work best.",
      },
      doc_type: {
        type: "string",
        description:
          "Optional filter: decision | conversation | doc | note | wiki | website",
      },
      top_k: {
        type: "number",
        description: "Number of results (1–10, default 5)",
      },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = ((args["query"] as string | undefined) ?? "").trim();
    if (!query) {
      return { success: false, error: "query is required" };
    }
    const topK = Math.min(Math.max(Number(args["top_k"] ?? 5), 1), 10);

    const result = await runRagSearch("turicks_brain", query, topK);

    if ("error" in result) {
      return { success: false, error: ragErrorMessage("turicks-brain", result.error) };
    }

    return { success: true, data: renderRagSuccess(result, query, "Turicks Brain", "source_path") };
  },
};

// ── searchResearchCacheTool ────────────────────────────────────────────────────

export const searchResearchCacheTool: UnifiedTool = {
  name: "search_research_cache",
  description:
    "Semantic search over previously-scraped web pages (research_cache vector DB). " +
    "Contains: full-text Markdown of pages the research department scraped via Apify " +
    "(company sites, docs, articles), each with its source URL + retrieval date. " +
    "Use BEFORE scraping again — prior findings are instant and free. " +
    "Read-only, no approval needed.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to search. E.g. 'Acme pricing tiers', 'competitor positioning'. Specific queries work best.",
      },
      top_k: { type: "number", description: "Number of results (1–10, default 5)" },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = ((args["query"] as string | undefined) ?? "").trim();
    if (!query) {
      return { success: false, error: "query is required" };
    }
    const topK = Math.min(Math.max(Number(args["top_k"] ?? 5), 1), 10);

    const result = await runRagSearch("research_cache", query, topK);

    if ("error" in result) {
      return { success: false, error: ragErrorMessage("research-cache", result.error) };
    }

    return { success: true, data: renderRagSuccess(result, query, "Research cache", "source_url") };
  },
};
