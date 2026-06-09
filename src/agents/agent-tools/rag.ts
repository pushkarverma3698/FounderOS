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
import {
  searchPersonalRagTool,
  searchTuricksBrainTool,
} from "../../tools/rag.js";

// ── search_personal_rag ────────────────────────────────────────────────────────

export const searchPersonalRag = tool(
  async ({ query, doc_type, top_k }) => {
    const result = await searchPersonalRagTool.execute({
      query,
      ...(doc_type ? { doc_type } : {}),
      ...(top_k ? { top_k } : {}),
    });
    return result.success
      ? (result.data ?? "No results.")
      : `ERROR: ${result.error}`;
  },
  {
    name: searchPersonalRagTool.name,
    description: searchPersonalRagTool.description,
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
    const result = await searchTuricksBrainTool.execute({
      query,
      ...(doc_type ? { doc_type } : {}),
      ...(top_k ? { top_k } : {}),
    });
    return result.success
      ? (result.data ?? "No results.")
      : `ERROR: ${result.error}`;
  },
  {
    name: searchTuricksBrainTool.name,
    description: searchTuricksBrainTool.description,
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
