/**
 * FounderOS — Knowledge Search Tool (turicks-brain)
 * ===================================================
 * Semantic search over the Turicks Brain — the single business knowledge base,
 * served as a vector store (ChromaDB) by the turicks-brain-rag API on :8766.
 *
 * History (2026-06-12): this tool used to query a Postgres `knowledge_entries`
 * table (ILIKE keyword match, ~39 rows synced from docs/** by `brain:sync`).
 * That was a thin keyword *shadow* of the vector store, which already holds the
 * same docs and decisions — plus conversation transcripts — as 7k+ semantically
 * searchable chunks. We deleted the shadow and repointed this tool at the vector
 * store so the business departments (research / marketing / sales) get real
 * semantic retrieval. `search_turicks_brain` (personal dept) hits the SAME store
 * via the same client — one knowledge source, no duplication.
 *
 * Read-only. If the vector API is down the bot auto-starts it on boot
 * (src/infra/rag-service.ts); if it is still unreachable we say so honestly.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { callRagApi, formatResults, TURICKS_BRAIN_URL } from "./rag.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:knowledge" });

/** Vector doc types in the Turicks Brain store (see turicks-brain-rag/src/store.py). */
const DOC_TYPES = ["decision", "conversation", "doc", "note", "wiki", "website"] as const;

export const searchKnowledge = tool(
  async ({ query, doc_type }) => {
    const q = (query ?? "").trim();
    if (!q) return "query is required.";

    log.debug({ query: q, doc_type }, "Knowledge search (vector)");
    const data = await callRagApi(TURICKS_BRAIN_URL, q, 5, doc_type ?? undefined);

    if (!data) {
      return (
        `The Turicks Brain knowledge base is not reachable right now, so I couldn't search company ` +
        `decisions/docs for "${q}". It normally auto-starts with the bot — if this persists, start it with: ` +
        `cd ~/Projects/turicks-brain-rag && uvicorn src.api:app --port 8766`
      );
    }

    if (data.results.length === 0) {
      return `No knowledge found for "${q}"${doc_type ? ` (type: ${doc_type})` : ""}.`;
    }

    return `Turicks Brain results for "${q}" (${data.total}):\n\n${formatResults(data.results, q, "source_path")}`;
  },
  {
    name: "search_knowledge",
    description:
      "Search the Turicks Brain — the company's semantic knowledge base of architectural decisions (ADRs), " +
      "strategy, brand rules, past case studies, phase notes, and prior conversations. Use when you need " +
      "company-specific context that web search can't provide. E.g. 'our LinkedIn brand voice', " +
      "'why we chose LangGraph', 'FinTech client case studies'.",
    schema: z.object({
      query: z.string().describe("What to look for — phrase it as a question or topic; this is semantic search"),
      doc_type: z
        .enum(DOC_TYPES)
        .optional()
        .nullable()
        .describe("Optional: filter by document type (decision | conversation | doc | note | wiki | website)"),
    }),
  },
);
