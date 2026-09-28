/**
 * RAG database tool wrappers for the kernel workers.
 *
 * Exposes read-only vector-search tools:
 *   searchPersonalRag   — personal-rag (career/personal knowledge, ChromaDB at :8765)
 *   searchResearchCache — research_cache (web pages the research worker scraped)
 *
 * Both are ungated (no HITL) — read-only, no side effects.
 * ADR-013/015: personal-rag ↔ turicks-brain NEVER cross-write from agent layer.
 *
 * searchTuricksBrain lived here until 2026-09-28. It read brain_memories, the
 * table search_knowledge already reads, and research held both — so it was
 * called twice for one query. Its worker binding is gone; the UnifiedTool in
 * src/tools/rag.ts stays for the scripts that probe the brain directly.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { orchestrateRagQuery } from "../../infra/rag-orchestrator.js";

// ── search_personal_rag ────────────────────────────────────────────────────────

export const searchPersonalRag = tool(
  async ({ query, doc_type, top_k }) => {
    return orchestrateRagQuery({
      store: "personal",
      query,
      doc_type,
      top_k,
    });
  },
  {
    name: "search_personal_rag",
    description:
      "Semantic search over Pushkar's personal knowledge base (personal-rag). " +
      "Contains: CV, career history, skills, certifications, payslips, education, personal identity docs. " +
      "Use for: career questions, 'what are my skills?', salary data, portfolio signals, background checks. " +
      "Read-only, no approval needed.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "What to search. E.g. 'TypeScript experience', 'salary history', 'AI projects'. " +
            "Be specific — this is a semantic vector search.",
        ),
      doc_type: z
        .string()
        .optional()
        .nullable()
        .describe(
          "Optional filter: resume | work_experience | certification | education | personal_identity | legal_document | financial",
        ),
      top_k: z
        .number()
        .optional()
        .nullable()
        .describe("Number of results (1–10, default 5)"),
    }),
  },
);

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
