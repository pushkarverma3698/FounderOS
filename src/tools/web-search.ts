/**
 * FounderOS — Web Search Tool
 * ============================
 * Primary: Firecrawl search API (POST /v1/search).
 * Fallback: Gemini google_search grounding (same GOOGLE_GENERATIVE_AI_API_KEY
 * the office already uses — zero extra vendor). Engaged whenever Firecrawl
 * fails for ANY reason (missing key, HTTP 402 credits exhausted, network).
 * Live QA 2026-06-11: Firecrawl 402 degraded 10/40 tasks — search must never
 * have a single point of failure.
 *
 * Fail-open: any error returns { success: false, data: [] } — never throws.
 */

import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:search_web" });

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

type SearchOutcome = { ok: true; results: SearchResult[] } | { ok: false; error: string };

const FIRECRAWL_URL = "https://api.firecrawl.dev/v1/search";
const GEMINI_GROUNDING_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const GROUNDED_SNIPPET_MAX = 300;
const GROUNDED_ANSWER_MAX = 1_500;

// ── Primary: Firecrawl ────────────────────────────────────────────────────────

async function firecrawlSearch(query: string, limit: number, apiKey: string): Promise<SearchOutcome> {
  try {
    const response = await fetch(FIRECRAWL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, limit }),
    });

    if (!response.ok) {
      const hint = response.status === 402 ? " (payment required — Firecrawl credits exhausted, top up at firecrawl.dev)" : "";
      return { ok: false, error: `Firecrawl returned HTTP ${response.status}${hint}` };
    }

    const json = (await response.json()) as FirecrawlResponse;
    const results: SearchResult[] = (json.data ?? []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
      ...(item.publishedAt ? { published_date: item.publishedAt } : {}),
    }));
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Fallback: Gemini google_search grounding ─────────────────────────────────

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

interface GroundingSupport {
  segment?: { text?: string };
  groundingChunkIndices?: number[];
}

interface GeminiGroundedResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: GroundingChunk[];
      groundingSupports?: GroundingSupport[];
    };
  }>;
}

/**
 * Map a Gemini grounded response to SearchResult[]. Exported for unit tests.
 * Each grounding chunk becomes a result; its snippet is the answer segments
 * that cite it (falling back to the head of the full answer). If Gemini
 * answered without citing sources, the whole answer is returned as one result.
 */
export function groundedResponseToResults(json: GeminiGroundedResponse, query: string, limit: number): SearchResult[] {
  const candidate = json.candidates?.[0];
  const answer = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const supports = candidate?.groundingMetadata?.groundingSupports ?? [];

  if (chunks.length === 0) {
    if (!answer) return [];
    return [{ title: `Grounded answer: ${query}`, url: "", snippet: answer.slice(0, GROUNDED_ANSWER_MAX) }];
  }

  const snippetForChunk = (index: number): string => {
    const segments = supports
      .filter((s) => s.groundingChunkIndices?.includes(index) && s.segment?.text)
      .map((s) => s.segment!.text!.trim());
    const joined = segments.join(" ");
    return (joined || answer).slice(0, GROUNDED_SNIPPET_MAX);
  };

  return chunks.slice(0, limit).map((chunk, i) => ({
    title: chunk.web?.title ?? "Untitled source",
    url: chunk.web?.uri ?? "",
    snippet: snippetForChunk(i),
  }));
}

async function geminiGroundedSearch(query: string, limit: number, apiKey: string): Promise<SearchOutcome> {
  try {
    const response = await fetch(GEMINI_GROUNDING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Search the web and report current factual findings for: ${query}` }] }],
        tools: [{ google_search: {} }],
      }),
    });

    if (!response.ok) {
      return { ok: false, error: `Gemini grounding returned HTTP ${response.status}` };
    }

    const json = (await response.json()) as GeminiGroundedResponse;
    const results = groundedResponseToResults(json, query, limit);
    if (results.length === 0) {
      return { ok: false, error: "Gemini grounding returned no content" };
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Tool ──────────────────────────────────────────────────────────────────────

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
    const finalQuery = site ? `site:${site} ${query}` : query;

    const firecrawlKey = process.env["FIRECRAWL_API_KEY"];
    let primaryError = "FIRECRAWL_API_KEY not set";

    if (firecrawlKey) {
      const primary = await firecrawlSearch(finalQuery, limit, firecrawlKey);
      if (primary.ok) return { success: true, data: primary.results };
      primaryError = primary.error;
      log.warn({ query: finalQuery, error: primaryError }, "Firecrawl failed — trying Gemini grounding fallback");
    }

    const geminiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    if (geminiKey) {
      const fallback = await geminiGroundedSearch(finalQuery, limit, geminiKey);
      if (fallback.ok) {
        log.info({ query: finalQuery, results: fallback.results.length }, "Gemini grounding fallback succeeded");
        return { success: true, data: fallback.results };
      }
      return {
        success: false,
        data: [],
        error: `webSearchTool: ${primaryError}; Gemini grounding fallback also failed: ${fallback.error}`,
      };
    }

    return { success: false, data: [], error: `webSearchTool: ${primaryError}` };
  },
};
