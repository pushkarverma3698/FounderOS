/**
 * RAG orchestrator — shared entry for agent-tool RAG wrappers.
 * Delegates to pgvector tools in tools/rag.ts (Ollama embed + Postgres query).
 */

import {
  searchPersonalRagTool,
  searchTuricksBrainTool,
  searchResearchCacheTool,
} from "../tools/rag.js";
import type { UnifiedTool } from "../tools/index.js";

export type RagStore = "personal" | "turicks" | "research";

export interface RagOrchestratorInput {
  store: RagStore;
  query: string;
  doc_type?: string | null;
  top_k?: number | null;
}

const TOOLS: Record<RagStore, UnifiedTool> = {
  personal: searchPersonalRagTool,
  turicks: searchTuricksBrainTool,
  research: searchResearchCacheTool,
};

/** Run a read-only vector search against personal-rag or turicks-brain. */
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
