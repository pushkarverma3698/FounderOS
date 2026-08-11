/**
 * FounderOS — Knowledge Search Tool (turicks-brain)
 * ===================================================
 * Full-text search over the `knowledge_entries` table — the Postgres-backed
 * turicks-brain store synced via `pnpm brain:sync`.
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
 *
 * Search is ILIKE keyword match — no embedding cost. Good for known-term lookup.
 * For semantic ("find content about uncertainty") use search_web instead.
 */

import { tool } from "@langchain/core/tools";
import { TENANT } from "../core/config.js";
import { z } from "zod";
import { searchKnowledgeEntries, getKnowledgeByType } from "../db/queries.js";
import { withToolErrorBoundary } from "../agents/tool-result.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:knowledge" });


export const searchKnowledge = tool(
  async ({ query, entry_type }) =>
    withToolErrorBoundary("db", "query turicks_brain (knowledge_entries) in Postgres", async () => {
    log.debug({ query, entry_type }, "Knowledge search");

    // Keyword-search-first. `entry_type` is a FORGIVING post-filter, never a
    // query-dropping replacement. The old behaviour ran getKnowledgeByType and
    // ignored `query`, so a model that guessed a type with zero rows (e.g.
    // "strategic_pillar" when prod was synced from a script that labelled the
    // same content "strategy") got an empty result and then HALLUCINATED an
    // answer (prod 2026-06-15: fabricated Turicks ICP). We always run the keyword
    // search, filter by type when asked, and fall back to the unfiltered keyword
    // hits if the type filter wipes everything — real content over a false miss.
    const hasQuery = query.trim().length > 0;
    let results: Array<{ title: string; content: string; tags: string[] | null; entry_type?: string }>;

    if (entry_type && !hasQuery) {
      results = await getKnowledgeByType(TENANT, entry_type, 5);
    } else {
      const matches = await searchKnowledgeEntries(TENANT, query, 15);
      if (entry_type) {
        const filtered = matches.filter((r) => r.entry_type === entry_type);
        results = (filtered.length > 0 ? filtered : matches).slice(0, 5);
      } else {
        results = matches.slice(0, 5);
      }
    }

    if (results.length === 0) {
      return `No knowledge entries found for "${query}"${entry_type ? ` (type: ${entry_type})` : ""}. The turicks-brain may not have this — try \`search_web\`. Do NOT fabricate an answer; report the missing information to the founder rather than fabricate or substitute unrelated context.`;
    }

    return results
      .map((r, i) => {
        const tags = (r.tags ?? []).join(", ");
        const preview = r.content.slice(0, 400).replace(/\n+/g, " ");
        return `${i + 1}. [${r.entry_type ?? entry_type ?? ""}] ${r.title}${tags ? `\n   Tags: ${tags}` : ""}\n   ${preview}${r.content.length > 400 ? "…" : ""}`;
      })
      .join("\n\n");
    }),
  {
    name: "search_knowledge",
    description:
      "Search the turicks-brain knowledge base — architectural decisions (ADRs), brand rules, past case studies, strategic pillars, and phase notes. Use when you need company-specific context that web search can't provide. E.g. 'our LinkedIn brand voice', 'what we decided about Composio', 'FinTech client case studies'.",
    schema: z.object({
      query: z.string().describe("Keyword search query — what to look for"),
      entry_type: z
        .enum(["adr", "brand", "case_study", "strategy", "strategic_pillar", "phase", "founder_profile"])
        .optional()
        .nullable()
        .describe("Optional: filter by content type"),
    }),
  },
);
