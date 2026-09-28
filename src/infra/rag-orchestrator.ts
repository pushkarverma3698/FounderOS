/**
 * RAG orchestrator — shared entry for agent-tool RAG wrappers.
 * Delegates to pgvector tools in tools/rag.ts (Ollama embed + Postgres query).
 */

import { searchPersonalRagTool, searchResearchCacheTool } from "../tools/rag.js";
import type { UnifiedTool } from "../tools/index.js";

/** One store per agent-tool wrapper. "turicks" went with its wrapper on 2026-09-28. */
export type RagStore = "personal" | "research";

export interface RagOrchestratorInput {
  store: RagStore;
  query: string;
  doc_type?: string | null;
  top_k?: number | null;
}

const TOOLS: Record<RagStore, UnifiedTool> = {
  personal: searchPersonalRagTool,
  research: searchResearchCacheTool,
};

/** Run a read-only vector search against personal-rag or the research cache. */
export async function orchestrateRagQuery(input: RagOrchestratorInput): Promise<string> {
  const query = input.query.trim();
  if (!query) return "ERROR: query is required";

  const tool = TOOLS[input.store];
  const result = await tool.execute({
    query,
    ...(input.doc_type ? { doc_type: input.doc_type } : {}),
    ...(input.top_k != null ? { top_k: input.top_k } : {}),
  });

  return result.success
    ? String(result.data ?? "No results.")
    : `ERROR: ${result.error ?? "unknown"}`;
}

/** Alias kept for agentic-RAG WIP imports. */
export const runRagOrchestrator = orchestrateRagQuery;
