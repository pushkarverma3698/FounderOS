/**
 * RAG database tool wrapper for the research worker.
 *
 * Exposes one read-only vector-search tool:
 *   searchResearchCache — research_cache (web pages the research worker scraped)
 *
 * Ungated (no HITL) — read-only, no side effects.
 *
 * Two more wrappers lived here until 2026-09-28; the UnifiedTools behind both
 * stay in src/tools/rag.ts, bound to no worker:
 *   searchTuricksBrain — read brain_memories, the table search_knowledge already
 *     reads, and research held both, so it was called twice for one query.
 *   searchPersonalRag  — gave the personal worker a CV answer from personal_rag,
 *     4 prod rows last written 2026-06-15. CV questions are jobhunt's: read_cv.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { orchestrateRagQuery } from "../../infra/rag-orchestrator.js";

// ── search_research_cache ──────────────────────────────────────────────────────

export const searchResearchCache = tool(
  async ({ query, top_k }) => {
    return orchestrateRagQuery({
      store: "research",
      query,
      top_k,
    });
  },
  {
    name: "search_research_cache",
    description:
      "Semantic search over web pages this department already scraped (research_cache). " +
      "Each result carries its source URL + retrieval date. " +
      "ALWAYS try this before scrape_url/deep_research — prior findings are instant and free. " +
      "Read-only, no approval needed.",
    schema: z.object({
      query: z
        .string()
        .describe("What to search. E.g. 'Acme pricing', 'competitor positioning'. Specific queries work best."),
      top_k: z.number().optional().nullable().describe("Number of results (1–10, default 5)"),
    }),
  },
);
