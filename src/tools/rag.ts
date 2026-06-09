/**
 * FounderOS — RAG Database Tools
 * ================================
 * Two read-only vector-search tools that let the personal department query
 * the founder's two knowledge bases directly:
 *
 *   searchPersonalRagTool  — searches personal-rag (ChromaDB at localhost:8765).
 *                            Career, CV, background, skills, payslips, certs.
 *
 *   searchTuricksBrainTool — searches turicks-brain (ChromaDB at localhost:8766).
 *                            Business decisions, strategy, ADRs, chats, notes.
 *
 * Both call REST APIs with a 4-second timeout.
 * Neither writes to the DB (ADR-013/015 boundary: read-only from agent layer).
 *
 * Fallback: if the target service is down, returns a plain "unavailable" message
 * with the start command so the agent can surface it to the founder.
 */

import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:rag" });

// ── Config ────────────────────────────────────────────────────────────────────

const PERSONAL_RAG_URL =
  process.env["PERSONAL_RAG_URL"] ?? "http://localhost:8765";

const TURICKS_BRAIN_URL =
  process.env["TURICKS_BRAIN_URL"] ?? "http://localhost:8766";

// ── Shared types ──────────────────────────────────────────────────────────────

interface RagSearchResponse {
  query: string;
  results: Array<{
    text: string;
    metadata: Record<string, unknown>;
    score: number;
  }>;
  total: number;
}

// ── Shared fetch helper ────────────────────────────────────────────────────────

async function callRagApi(
  baseUrl: string,
  query: string,
  topK: number,
  docType?: string,
): Promise<RagSearchResponse | null> {
  try {
    const body: Record<string, unknown> = { query, top_k: topK };
    if (docType) body["doc_type"] = docType;

    const resp = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });

    if (!resp.ok) {
      log.warn({ baseUrl, status: resp.status }, "RAG API non-OK response");
      return null;
    }

    return (await resp.json()) as RagSearchResponse;
  } catch {
    log.debug({ baseUrl, query }, "RAG API unavailable");
    return null;
  }
}

function formatResults(
  results: RagSearchResponse["results"],
  query: string,
  sourceField: string,
): string {
  if (results.length === 0) {
    return `No results found for "${query}". The knowledge base may not have this information yet.`;
  }
  const lines = results.map((r, i) => {
    const src = (r.metadata[sourceField] as string | undefined) ?? "unknown";
    const score = r.score.toFixed(2);
    return `${i + 1}. [${src}] (score ${score})\n${r.text.trim()}`;
  });
  return lines.join("\n\n");
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
    const docType = args["doc_type"] as string | undefined;

    const data = await callRagApi(PERSONAL_RAG_URL, query, topK, docType);

    if (!data) {
      return {
        success: false,
        error:
          "personal-rag is not running. Start it with: cd ~/Projects/personal-rag && uvicorn src.api:app --port 8765",
      };
    }

    log.debug({ query, total: data.total }, "personal-rag search");
    return {
      success: true,
      data:
        `Personal knowledge search for "${query}" (${data.total} results):\n\n` +
        formatResults(data.results, query, "source_file"),
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
    const docType = args["doc_type"] as string | undefined;

    const data = await callRagApi(TURICKS_BRAIN_URL, query, topK, docType);

    if (!data) {
      return {
        success: false,
        error:
          "turicks-brain is not running. Start it with: cd ~/Projects/turicks-brain-rag && uvicorn src.api:app --port 8766",
      };
    }

    log.debug({ query, total: data.total }, "turicks-brain search");
    return {
      success: true,
      data:
        `Turicks Brain search for "${query}" (${data.total} results):\n\n` +
        formatResults(data.results, query, "source_path"),
    };
  },
};
