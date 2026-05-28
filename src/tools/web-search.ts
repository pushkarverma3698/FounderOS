/**
 * FounderOS — Web Search Tool
 * ============================
 * Firecrawl search API (POST /v1/search).
 * Fail-open: any error returns { success: false, data: [] } — never throws.
 *
 * Used by: bidding_sniper, social_researcher, lead_intel, seo_specialist
 */

import type { UnifiedTool, ToolResult } from "./index.js";

export interface WebSearchArgs {
  query: string;
  /** Max results to return (default: 5) */
  limit?: number;
  /** Restrict to this domain if specified */
  site?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
}

interface FirecrawlSearchResult {
  title: string;
  url: string;
  description: string;
  publishedAt?: string | null;
}

interface FirecrawlResponse {
  success: boolean;
  data: FirecrawlSearchResult[];
}

const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/search";

export const webSearchTool: UnifiedTool = {
  name: "search_web",
  description:
    "Search the web for up-to-date information, news, or research. Returns a list of relevant results with title, URL, and snippet.",

  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      limit: { type: "number", description: "Max results (default: 5)" },
      site: { type: "string", description: "Restrict results to this domain (e.g. 'notion.so')" },
    },
    required: ["query"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const { query, limit = 5, site } = args as unknown as WebSearchArgs;

    const apiKey = process.env["FIRECRAWL_API_KEY"];
    if (!apiKey) {
      return {
        success: false,
        data: [],
        error: "webSearchTool: FIRECRAWL_API_KEY not set",
      };
    }

    const finalQuery = site ? `site:${site} ${query}` : query;

    try {
      const response = await fetch(FIRECRAWL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query: finalQuery, limit }),
      });

      if (!response.ok) {
        return {
          success: false,
          data: [],
          error: `webSearchTool: Firecrawl returned HTTP ${response.status}`,
        };
      }

      const json = (await response.json()) as FirecrawlResponse;

      const results: SearchResult[] = (json.data ?? []).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.description,
        ...(item.publishedAt ? { published_date: item.publishedAt } : {}),
      }));

      return { success: true, data: results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        data: [],
        error: `webSearchTool: ${message}`,
      };
    }
  },
};
