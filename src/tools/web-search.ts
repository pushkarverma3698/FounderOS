/**
 * FounderOS — Web Search Tool
 * ============================
 * Primary: Gemini google_search grounding (same GOOGLE_GENERATIVE_AI_API_KEY
 * the office already uses — zero extra vendor, free, live-verified 2026-06-11).
 * Fallback: DuckDuckGo HTML endpoint (html.duckduckgo.com) — free, keyless,
 * no billing, scraped + parsed in-process. Replaced Firecrawl (2026-06-11),
 * which required a paid key and was returning 402 once credits ran out.
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

type SearchOutcome = { ok: true; results: SearchResult[] } | { ok: false; error: string };

const DDG_HTML_URL = "https://html.duckduckgo.com/html/";
const DDG_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DDG_TIMEOUT_MS = 12_000;
// A hung grounding call must fail fast into the DDG fallback — without this a
// single stuck request ate the whole 180s turn budget (2026-07-11 ed826c52).
const GROUNDING_TIMEOUT_MS = 25_000;
const GEMINI_GROUNDING_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";
const GROUNDED_SNIPPET_MAX = 300;
const GROUNDED_ANSWER_MAX = 1_500;
const DDG_SNIPPET_MAX = 300;

// ── Fallback: DuckDuckGo HTML scrape ──────────────────────────────────────────

/** Strip HTML tags and decode the handful of entities DDG emits.
 *  Exported + reused by the Apify keyless fallback (src/tools/apify.ts). */
export function stripHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** DDG wraps every result URL in a redirect: //duckduckgo.com/l/?uddg=<encoded>&rut=… */
function decodeDuckDuckGoUrl(href: string): string {
  const match = href.match(/[?&]uddg=([^&"]+)/);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  // Direct (non-redirect) link — normalise protocol-relative URLs.
  return href.startsWith("//") ? `https:${href}` : href;
}

/**
 * Parse the DuckDuckGo HTML results page into SearchResult[]. Exported for unit
 * tests so we never depend on a live network call to assert the parser is correct.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m !== null; m = snippetRe.exec(html)) {
    snippets.push(stripHtml(m[1] ?? "").slice(0, DDG_SNIPPET_MAX));
  }

  const results: SearchResult[] = [];
  let i = 0;
  for (let m = titleRe.exec(html); m !== null && results.length < limit; m = titleRe.exec(html)) {
    const title = stripHtml(m[2] ?? "");
    const url = decodeDuckDuckGoUrl(m[1] ?? "");
    if (!title || !url) {
      i += 1;
      continue;
    }
    results.push({ title, url, snippet: snippets[i] ?? "" });
    i += 1;
  }
  return results;
}

async function duckDuckGoSearch(query: string, limit: number): Promise<SearchOutcome> {
  try {
    const response = await fetch(`${DDG_HTML_URL}?q=${encodeURIComponent(query)}`, {
      method: "GET",
      headers: { "User-Agent": DDG_USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(DDG_TIMEOUT_MS),
    });

    if (!response.ok) {
      return { ok: false, error: `DuckDuckGo returned HTTP ${response.status}` };
    }

    const html = await response.text();
    const results = parseDuckDuckGoHtml(html, limit);
    if (results.length === 0) {
      return { ok: false, error: "DuckDuckGo returned no parseable results" };
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Gemini grounding ──────────────────────────────────────────────────────────

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
      signal: AbortSignal.timeout(GROUNDING_TIMEOUT_MS),
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

    const geminiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    let primaryError = "GOOGLE_GENERATIVE_AI_API_KEY not set";

    if (geminiKey) {
      const primary = await geminiGroundedSearch(finalQuery, limit, geminiKey);
      if (primary.ok) return { success: true, data: primary.results };
      primaryError = primary.error;
      log.warn({ query: finalQuery, error: primaryError }, "Gemini grounding failed — trying DuckDuckGo fallback");
    }

    // Free, keyless fallback — always available, no billing.
    const fallback = await duckDuckGoSearch(finalQuery, limit);
    if (fallback.ok) {
      log.info({ query: finalQuery, results: fallback.results.length }, "DuckDuckGo fallback succeeded");
      return { success: true, data: fallback.results };
    }

    return {
      success: false,
      data: [],
      error:
        `webSearchTool: ${primaryError}; DuckDuckGo fallback also failed: ${fallback.error}. ` +
        `STOP — do not call search_web again this turn. Answer from prior results or say search failed.`,
    };
  },
};
