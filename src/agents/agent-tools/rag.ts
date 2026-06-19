/**
 * RAG database tool wrappers for the personal department.
 *
 * Exposes two read-only vector-search tools:
 *   searchPersonalRag  — personal-rag (career/personal knowledge, ChromaDB at :8765)
 *   searchTuricksBrain — turicks-brain (business/strategy knowledge, ChromaDB at :8766)
 *
 * Both are ungated (no HITL) — read-only, no side effects.
 * ADR-013/015: personal-rag ↔ turicks-brain NEVER cross-write from agent layer.
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

// ── search_turicks_brain ───────────────────────────────────────────────────────

export const searchTuricksBrain = tool(
  async ({ query, doc_type, top_k }) => {
    return orchestrateRagQuery({
      store: "turicks",
      query,
      doc_type,
      top_k,
    });
  },
  {
    name: "search_turicks_brain",
    description:
      "Semantic search over the Turicks Brain knowledge base (vector DB). " +
      "Contains: architectural decisions, business strategy, ADRs, conversation transcripts, " +
      "founder notes, product plans, Turicks/Naggar context. " +
      "Read-only, no approval needed.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "What to search. E.g. 'ICP strategy', 'why we chose LangGraph', 'Naggar pricing'. " +
            "Specific queries work best.",
        ),
      doc_type: z
        .string()
        .optional()
        .nullable()
        .describe(
          "Optional filter: decision | conversation | doc | note | wiki | website",
        ),
      top_k: z
        .number()
        .optional()
        .nullable()
        .describe("Number of results (1–10, default 5)"),
    }),
  },
);
