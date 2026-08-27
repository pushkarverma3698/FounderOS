/**
 * FounderOS — RAG Database Tools
 * ================================
 * Three read-only search tools over the isolated RAG tables, all built on the
 * shared engine in src/db/rag-query.ts (runRagSearch: vector ⊕ keyword, RRF-
 * fused, optionally reranked):
 *
 *   searchPersonalRagTool     — searches personal_rag (pgvector table).
 *                               Career, CV, background, skills, payslips, certs.
 *
 *   searchTuricksBrainTool    — searches turicks_brain (pgvector table).
 *                               Business decisions, strategy, ADRs, chats, notes.
 *                               search_knowledge (src/tools/knowledge.ts) hits
 *                               the same table through the same engine.
 *
 *   searchResearchCacheTool   — searches research_cache (pgvector table).
 *                               Previously-scraped web pages.
 *
 * Embeddings are generated locally via Ollama (nomic-embed-text) — RAG text
 * never leaves the machine. None of these tools write to the DB (ADR-013/015).
 *
 * Fallback: if Ollama is down the tool soft-fails with an actionable message.
 */

import { runRagSearch } from "../db/rag-query.js";
import { renderRagSuccess, ragErrorMessage } from "../db/retrieval-result.js";
import type { UnifiedTool, ToolResult } from "./index.js";

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
