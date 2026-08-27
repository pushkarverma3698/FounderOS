/**
 * FounderOS — Knowledge Search Tool (turicks-brain)
 * ===================================================
 * Search over `turicks_brain` — the pgvector-backed knowledge base synced via
 * `pnpm brain:sync`. Delegates to the same hybrid (vector ⊕ keyword, RRF-fused)
 * engine as search_turicks_brain (src/db/rag-query.ts) — both tools query the
 * identical table through the identical engine; this tool adds an entry_type
 * filter, the other adds a wider top_k.
 *
 * Content types stored:
 *   adr            — Architecture Decision Records (e.g. ADR-002: Use Composio)
 *   brand          — Brand guidelines, voice rules, content pillars
 *   case_study     — Past client work and results
 *   strategic_pillar — 6 pillars of the business strategy
 *   phase          — Phase completion notes and outcomes
 *   decision       — Operational and product decisions
 *
 * Use cases for agents:
 *   research  — "what have we done for FinTech clients?" → case studies
 *   sales     — "what's our positioning against [competitor]?" → ADR / brand
 *   marketing — "what's our brand voice rule for LinkedIn?" → brand entries
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { runRagSearch } from "../db/rag-query.js";
import { ragErrorMessage, renderRagSuccess } from "../db/retrieval-result.js";
import { withToolErrorBoundary } from "../agents/tool-result.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:knowledge" });

const TOP_K = 5;

export const searchKnowledge = tool(
  async ({ query, entry_type }) =>
    withToolErrorBoundary("db", "query turicks_brain (hybrid) in Postgres", async () => {
      log.debug({ query, entry_type }, "Knowledge search");

      let result = await runRagSearch(
        "turicks_brain",
        query,
        TOP_K,
        entry_type ? { filter: { entry_type } } : undefined,
      );

      // entry_type is a FORGIVING post-filter, never a query-dropping
      // replacement. A model that guesses a type with zero rows (e.g.
      // "strategic_pillar" when content was synced as "strategy") must not get
      // an empty result and then HALLUCINATE an answer (prod 2026-06-15:
      // fabricated Turicks ICP). If the filtered search comes back empty, retry
      // unfiltered before reporting nothing found — real content over a false miss.
      if (entry_type && !("error" in result) && result.hits.length === 0) {
        const unfiltered = await runRagSearch("turicks_brain", query, TOP_K);
        if (!("error" in unfiltered)) result = unfiltered;
      }

      if ("error" in result) {
        return ragErrorMessage("turicks-brain", result.error);
      }

      if (result.hits.length === 0) {
        return `No knowledge entries found for "${query}"${entry_type ? ` (type: ${entry_type})` : ""}. The turicks-brain may not have this — try \`search_web\`. Do NOT fabricate an answer; report the missing information to the founder rather than fabricate or substitute unrelated context.`;
      }

      return renderRagSuccess(result, query, "Turicks Brain", "source_path");
    }),
  {
    name: "search_knowledge",
    description:
      "Search the turicks-brain knowledge base — architectural decisions (ADRs), brand rules, past case studies, strategic pillars, and phase notes. Use when you need company-specific context that web search can't provide. E.g. 'our LinkedIn brand voice', 'what we decided about Composio', 'FinTech client case studies'.",
    schema: z.object({
      query: z.string().describe("Keyword search query — what to look for"),
      entry_type: z
        .enum(["adr", "brand", "case_study", "strategy", "strategic_pillar", "phase", "founder_profile", "session"])
        .optional()
        .nullable()
        .describe("Optional: filter by content type"),
    }),
  },
);
