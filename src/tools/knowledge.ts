/**
 * FounderOS — Knowledge Search Tool (turicks-brain)
 * ===================================================
 * Search over `brain_memories` — the pgvector-backed knowledge base synced via
 * `pnpm brain:sync` (ADR-038; the store was `turicks_brain` until 0038 carried
 * the corpus across), through the shared hybrid (vector ⊕ keyword, RRF-fused)
 * engine in src/db/rag-query.ts. This is the ONE worker tool over that table
 * (RETRIEVAL_TOOL_TABLE, src/agents/capabilities.ts): it carries both the
 * entry_type filter and a top_k of up to 10, the wider result count that was
 * the only reason research also held search_turicks_brain — which reads the
 * same rows, and on 2026-09-26 was called for the same query in the same turn.
 *
 * Content types stored:
 *   adr            — Architecture Decision Records (e.g. ADR-029: Direct Platform Integrations)
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
import { env, TENANT } from "../core/config.js";
import { visibilityFilter } from "../db/brain-visibility.js";

const log = childLogger({ module: "tool:knowledge" });

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 10;

export const searchKnowledge = tool(
  async ({ query, entry_type, top_k }, config) =>
    withToolErrorBoundary("db", "query brain_memories (hybrid) in Postgres", async () => {
      const topK = Math.min(Math.max(Math.round(top_k ?? DEFAULT_TOP_K), 1), MAX_TOP_K);
      log.debug({ query, entry_type, topK }, "Knowledge search");

      // Group-chat privacy (AG-027): the thread comes from the run, never from an argument. Only the founder DM
      // reads `visibility: founder` rows (Mac capture); no thread (the IDE MCP does not use this tool) counts as not the DM.
      const threadId = String(config?.configurable?.["thread_id"] ?? "");
      const visibility = visibilityFilter(threadId, TENANT, env.TELEGRAM_CHAT_ID);
      const scoped = { ...visibility };
      const typed = entry_type ? { ...visibility, entry_type } : visibility;
      const optsFor = (filter: typeof typed) => (Object.keys(filter).length > 0 ? { filter } : undefined);

      let result = await runRagSearch("brain_memories", query, topK, optsFor(typed));

      // entry_type is a FORGIVING post-filter, never a query-dropping
      // replacement. A model that guesses a type with zero rows (e.g.
      // "strategic_pillar" when content was synced as "strategy") must not get
      // an empty result and then HALLUCINATE an answer (prod 2026-06-15:
      // fabricated Turicks ICP). If the filtered search comes back empty, retry
      // unfiltered before reporting nothing found — real content over a false miss.
      if (entry_type && !("error" in result) && result.hits.length === 0) {
        const unfiltered = await runRagSearch("brain_memories", query, topK, optsFor(scoped));
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
      "Search the shared brain — architectural decisions (ADRs), brand rules, past case studies, strategic pillars, phase notes, and the decisions, bugs and work that Claude and Antigravity recorded (each hit shows its date and origin; a weak match is labelled 'No strong match', so say that rather than guess). Use for 'what did we decide about X', 'what did Claude/Antigravity do', and when you need company-specific context that web search can't provide. E.g. 'our LinkedIn brand voice', 'what we decided about direct integrations', 'FinTech client case studies'.",
    schema: z.object({
      query: z.string().describe("Keyword search query — what to look for"),
      entry_type: z
        .enum(["adr", "brand", "case_study", "strategy", "strategic_pillar", "phase", "founder_profile", "session"])
        .optional()
        .nullable()
        .describe("Optional: filter by content type"),
      top_k: z.number().optional().nullable().describe("Number of results (1–10, default 5)"),
    }),
  },
);
