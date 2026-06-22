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
import { embedText } from "../lib/embed.js";
import { searchRagTable, type RagTable, type RagHit } from "../db/rag-search.js";
import { getRagflowClient } from "../infra/ragflow.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:rag" });

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Discriminated failure so the tool can report the REAL failing component.
 * The old code collapsed every error into "Ollama unavailable" — so a missing
 * table, an empty store, or a DB outage all got blamed on Ollama, and the error
 * was logged at debug level (invisible). That mislabeling cost a production
 * debugging session (see CLAUDE.md rule #22). Stage-tagged errors fix that.
 */
type RagFailure = { stage: "embed" | "query"; message: string };

async function runRagSearch(
  table: RagTable,
  query: string,
  topK: number,
): Promise<{ hits: RagHit[] } | { error: RagFailure }> {
  // RAGFlow backend: skip Ollama entirely, query RAGFlow's managed pipeline.
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
      return { hits };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ table, query, err }, "RAGFlow search failed");
      return { error: { stage: "query", message } };
    }
  }

  // pgvector backend (default): embed via Ollama, query Postgres.
  // Stage 1: embed the query (Ollama). Failure here = embedding/Ollama problem.
  let embedding: number[];
  try {
    embedding = await embedText(query);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ table, query, err }, "RAG embed (Ollama) failed");
    return { error: { stage: "embed", message } };
  }

  // Stage 2: vector query (Postgres/pgvector). Failure here = DB/store problem,
  // NOT Ollama. An empty store is NOT an error — it returns zero hits.
  try {
    const hits = await searchRagTable(table, embedding, topK);
    return { hits };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ table, query, err }, "RAG vector query failed");
    return { error: { stage: "query", message } };
  }
}

function formatResults(hits: RagHit[], query: string, sourceField: string): string {
  if (hits.length === 0) {
    return `No results found for "${query}". The knowledge base may not have this information yet.`;
  }
  return hits
    .map((r, i) => {
      const src = (r.metadata[sourceField] as string | undefined) ?? "unknown";
      return `${i + 1}. [${src}] (score ${r.score.toFixed(2)})\n${r.content.trim()}`;
    })
    .join("\n\n");
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

    log.debug({ query, count: result.hits.length }, "personal-rag search");
    return {
      success: true,
      data:
        `Personal knowledge search for "${query}" (${result.hits.length} results):\n\n` +
        formatResults(result.hits, query, "source_file"),
    };
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

    log.debug({ query, count: result.hits.length }, "turicks-brain search");
    return {
      success: true,
      data:
        `Turicks Brain search for "${query}" (${result.hits.length} results):\n\n` +
        formatResults(result.hits, query, "source_path"),
    };
  },
};
