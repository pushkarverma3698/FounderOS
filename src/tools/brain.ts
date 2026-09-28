/**
 * FounderOS — Turicks Brain RAG Tool & Pre-Filtering
 * ===================================================
 * Search over brain_memories vector/RAG knowledge base with Jev AI context pre-filtering.
 */

import { runRagSearch } from "../db/rag-query.js";
import { renderRagSuccess, ragErrorMessage } from "../db/retrieval-result.js";
import { preFilterJevRagContext, type JevRagContextFilterInput, type JevRagContextFilterOutput } from "../services/jev-ai.js";
import type { UnifiedTool, ToolResult } from "./index.js";

/**
 * Applies Jev AI context pre-filtering to trim, filter, and deduplicate RAG context items.
 */
export function turicksBrainPreFilter(
  items: readonly JevRagContextFilterInput[],
  options?: { topK?: number },
): JevRagContextFilterOutput {
  return preFilterJevRagContext(items, options);
}

export const searchTuricksBrainTool: UnifiedTool = {
  name: "search_turicks_brain",
  description:
    "Semantic search over the Turicks Brain knowledge base with Jev AI pre-filtering. " +
    "Contains: architectural decisions, business strategy, ADRs, conversation transcripts, " +
    "founder notes, product plans, Turicks/Naggar context. " +
    "Read-only, no approval needed.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for in Turicks Brain knowledge base.",
      },
      doc_type: {
        type: "string",
        description: "Optional filter: decision | conversation | doc | note | wiki | website",
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

    const result = await runRagSearch("brain_memories", query, topK);

    if ("error" in result) {
      return { success: false, error: ragErrorMessage("turicks-brain", result.error) };
    }

    // Apply Jev AI context pre-filtering to RAG search hits
    const rawHits = result.hits.map((h) => ({
      text: h.content,
      score: h.score,
      source: h.metadata?.["source_path"] as string | undefined,
      ...h.metadata,
    }));

    const preFiltered = turicksBrainPreFilter(rawHits, { topK });

    // Re-pack filtered hits back into RagSearchResult shape
    const filteredSearchResult = {
      ...result,
      hits: preFiltered.filtered.map((item) => ({
        content: item.text,
        score: item.score ?? 1.0,
        metadata: { source_path: item.source },
      })),
    };

    return {
      success: true,
      data: renderRagSuccess(filteredSearchResult, query, "Turicks Brain", "source_path"),
    };
  },
};
