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
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:rag" });

// ── Shared helpers ────────────────────────────────────────────────────────────

async function runRagSearch(
  table: RagTable,
  query: string,
  topK: number,
): Promise<RagHit[] | null> {
  try {
    const embedding = await embedText(query);
    return await searchRagTable(table, embedding, topK);
  } catch (err) {
    log.debug({ table, query, err }, "RAG search unavailable");
    return null;
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

    const hits = await runRagSearch("personal_rag", query, topK);

    if (!hits) {
      return {
        success: false,
        error:
          "personal-rag search unavailable — check that Ollama is running with 'nomic-embed-text' pulled",
      };
    }

    log.debug({ query, count: hits.length }, "personal-rag search");
    return {
      success: true,
      data:
        `Personal knowledge search for "${query}" (${hits.length} results):\n\n` +
        formatResults(hits, query, "source_file"),
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

    const hits = await runRagSearch("turicks_brain", query, topK);

    if (!hits) {
      return {
        success: false,
        error:
          "turicks-brain search unavailable — check that Ollama is running with 'nomic-embed-text' pulled",
      };
    }

    log.debug({ query, count: hits.length }, "turicks-brain search");
    return {
      success: true,
      data:
        `Turicks Brain search for "${query}" (${hits.length} results):\n\n` +
        formatResults(hits, query, "source_path"),
    };
  },
};
