/**
 * Research department tools (read-only, no approval).
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { webSearchTool } from "../../tools/web-search.js";

// ── Research: web search (read-only, NO approval) ─────────────────────────────

export const searchWeb = tool(
  async ({ query, limit }) => {
    const res = await webSearchTool.execute({ query, limit: limit ?? 5 });
    if (!res.success) {
      return `Web search failed: ${res.error ?? "unknown error"}. (Check that FIRECRAWL_API_KEY is set.)`;
    }
    const results = (res.data as Array<{ title: string; url: string; snippet: string }>) ?? [];
    if (results.length === 0) return `No web results found for "${query}".`;
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  },
  {
    name: "search_web",
    description:
      "Search the web for current information, news, or company/market research. Returns titles, URLs, and snippets. Read-only — no approval needed.",
    schema: z.object({
      query: z.string().describe("The search query"),
      limit: z.number().optional().describe("Max results (default 5)"),
    }),
  },
);
