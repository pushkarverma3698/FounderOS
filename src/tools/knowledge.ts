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
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:knowledge" });


export const searchKnowledge = tool(
  async ({ query, entry_type }) => {
    log.debug({ query, entry_type }, "Knowledge search");

    const results = entry_type
      ? await getKnowledgeByType(TENANT, entry_type, 5)
      : await searchKnowledgeEntries(TENANT, query, 5);

    if (results.length === 0) {
      return `No knowledge entries found for "${query}"${entry_type ? ` (type: ${entry_type})` : ""}. The turicks-brain may not have been synced yet — run \`pnpm brain:sync\` to populate it.`;
    }

    return results
      .map((r, i) => {
        const tags = (r.tags ?? []).join(", ");
        const preview = r.content.slice(0, 400).replace(/\n+/g, " ");
        return `${i + 1}. [${("entry_type" in r ? (r as Record<string,string>)["entry_type"] : entry_type) ?? ""}] ${r.title}${tags ? `\n   Tags: ${tags}` : ""}\n   ${preview}${r.content.length > 400 ? "…" : ""}`;
      })
      .join("\n\n");
  },
  {
    name: "search_knowledge",
    description:
      "Search the turicks-brain knowledge base — architectural decisions (ADRs), brand rules, past case studies, strategic pillars, and phase notes. Use when you need company-specific context that web search can't provide. E.g. 'our LinkedIn brand voice', 'what we decided about Composio', 'FinTech client case studies'.",
    schema: z.object({
      query: z.string().describe("Keyword search query — what to look for"),
      entry_type: z
        .enum(["adr", "brand", "case_study", "strategic_pillar", "phase", "decision"])
        .optional()
        .describe("Optional: filter by content type"),
    }),
  },
);
