/**
 * Research department tools (read-only, no approval).
 *
 *   search_web     — snippet-level search (Gemini grounding → DuckDuckGo).
 *   scrape_url     — one URL → full clean Markdown (Apify rag-web-browser → fetch).
 *   deep_research  — query → top-N full pages + synthesis, always cited.
 *   crawl_site     — crawl a site/docs → bulk-ingest into research_cache.
 *
 * Every scrape is cached (Redis, dedup) and auto-ingested into the research_cache
 * vector store with citations (source_url + retrieved_at) — see research-memory.ts.
 * All read-only: NO HITL gate (rule #13 — gates guard external SENDS, not reads).
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { webSearchTool } from "../../tools/web-search.js";
import { scrapeUrl, ragSearch, crawlSite, type ScrapeResult } from "../../tools/apify.js";
import { getCachedScrape, setCachedScrape, ingestResearch } from "../../infra/research-memory.js";
import { recordEventTool } from "../../tools/memory.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tool:research" });

const DEEP_RESEARCH_MAX_PAGES = 3; // hard cap — protects RUN_BUDGET_* + Apify credits
const CRAWL_MAX_PAGES_DEFAULT = 10;
const CRAWL_MAX_PAGES_CEILING = 25;
const EXCERPT_MAX = 1_500; // per-page content bound in tool output (token control)

// ── search_web (read-only, NO approval) ───────────────────────────────────────

export const searchWeb = tool(
  async ({ query, limit }) => {
    const res = await webSearchTool.execute({ query, limit: limit ?? 5 });
    if (!res.success) {
      return `Web search failed: ${res.error ?? "unknown error"}. (Primary is Gemini grounding via GOOGLE_GENERATIVE_AI_API_KEY; the keyless DuckDuckGo fallback may be rate-limited — retry shortly.)`;
    }
    const results = (res.data as Array<{ title: string; url: string; snippet: string }>) ?? [];
    if (results.length === 0) return `No web results found for "${query}".`;

    const pages = searchHitsToPages(query, results);
    await persist(`search:${query}`, pages);
    logResearchEvent(
      `Researched: ${query}`,
      `Web search — ${results.length} results saved to research memory: ${results.map((r) => r.url).join(", ")}`,
      "search_web",
    );

    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  },
  {
    name: "search_web",
    description:
      "Search the web for current information, news, or company/market research. Returns titles, URLs, and snippets only (no full page text). " +
      "Results are cached and saved to research memory (searchable later via search_research_cache). " +
      "For full page content use scrape_url or deep_research. Read-only — no approval needed.",
    schema: z.object({
      query: z.string().describe("The search query"),
      limit: z.number().optional().nullable().describe("Max results (default 5)"),
    }),
  },
);

// ── Shared formatting ─────────────────────────────────────────────────────────

function formatPages(label: string, pages: ScrapeResult[]): string {
  const body = pages
    .map((p, i) => {
      const excerpt = p.markdown.slice(0, EXCERPT_MAX) + (p.markdown.length > EXCERPT_MAX ? "…" : "");
      return `### ${i + 1}. ${p.title}\n${p.url}\n\n${excerpt}`;
    })
    .join("\n\n");
  const sources = pages.map((p, i) => `${i + 1}. ${p.title} — ${p.url}`).join("\n");
  return `${label}\n\n${body}\n\nSources:\n${sources}`;
}

/** Best-effort ingest + cache so a scrape becomes durable, searchable memory. */
async function persist(cacheKey: string, pages: ScrapeResult[]): Promise<void> {
  await setCachedScrape(cacheKey, pages);
  await ingestResearch(pages); // fail-open inside (Ollama/DB errors logged, not thrown)
}

/** Log research activity to episodic memory (non-HITL, best-effort). */
function logResearchEvent(title: string, summary: string, tag: string): void {
  void recordEventTool
    .invoke({
      title: title.slice(0, 120),
      summary: summary.slice(0, 500),
      tags: ["research", tag],
      event_type: "task_completed",
    })
    .catch((err) => log.warn({ err }, `${tag}: episodic log failed (non-fatal)`));
}

/** Turn search_web hits into lightweight ScrapeResults for research_cache. */
function searchHitsToPages(
  query: string,
  hits: Array<{ title: string; url: string; snippet: string }>,
): ScrapeResult[] {
  const retrieved_at = new Date().toISOString();
  return hits.map((h) => ({
    url: h.url,
    title: h.title,
    markdown: `## ${h.title}\n\n${h.snippet}\n\nSource: ${h.url}\n\n_Search query: "${query}"_`,
    retrieved_at,
  }));
}

// ── scrape_url ────────────────────────────────────────────────────────────────

export const scrapeUrlTool = tool(
  async ({ url }) => {
    const cached = await getCachedScrape(url);
    if (cached && cached.length > 0) {
      return formatPages(`Scraped "${url}" (from cache):`, cached);
    }
    const res = await scrapeUrl(url);
    if (!res.ok) {
      return `Scrape failed for ${url}: ${res.error}. (Set APIFY_TOKEN for the Apify rag-web-browser; the keyless fetch fallback may be blocked by the site.)`;
    }
    await persist(url, res.data);
    return formatPages(`Scraped "${url}" (via ${res.source}):`, res.data);
  },
  {
    name: "scrape_url",
    description:
      "Fetch the FULL clean Markdown content of a single web page (not just a snippet). " +
      "Use when you have a specific URL and need its actual text — pricing pages, docs, articles, company sites. " +
      "Result is cached and saved to research memory (searchable later via search_research_cache). " +
      "Read-only — no approval needed.",
    schema: z.object({
      url: z.string().describe("The full URL to scrape, e.g. https://example.com/pricing"),
    }),
  },
);

// ── deep_research ─────────────────────────────────────────────────────────────

export const deepResearch = tool(
  async ({ query, max_pages }) => {
    const cap = Math.min(Math.max(max_pages ?? DEEP_RESEARCH_MAX_PAGES, 1), DEEP_RESEARCH_MAX_PAGES);

    const cached = await getCachedScrape(query);
    if (cached && cached.length > 0) {
      return formatPages(`Deep research on "${query}" (from cache):`, cached);
    }

    // Primary: Apify rag-web-browser does search + scrape in one call.
    let pages: ScrapeResult[] = [];
    let source = "apify";
    const rag = await ragSearch(query, cap);
    if (rag.ok) {
      pages = rag.data.slice(0, cap);
    } else {
      // Fallback: reuse search_web for top URLs, then fetch-scrape each (≤cap).
      log.warn({ query, error: rag.error }, "deep_research: Apify unavailable — search_web + fetch fallback");
      source = "search_web+fetch";
      const search = await webSearchTool.execute({ query, limit: cap });
      const hits = (search.success ? (search.data as Array<{ url: string }>) : []) ?? [];
      const urls = hits.map((h) => h.url).filter((u) => u && u.startsWith("http")).slice(0, cap);
      for (const url of urls) {
        const one = await scrapeUrl(url);
        if (one.ok) pages.push(...one.data);
      }
    }

    if (pages.length === 0) {
      return `Deep research found no readable pages for "${query}". Try search_web for snippet-level results, or rephrase the query.`;
    }

    await persist(query, pages);
    logResearchEvent(
      `Researched: ${query}`,
      `Deep research via ${source} — ${pages.length} sources: ${pages.map((p) => p.url).join(", ")}`,
      "deep_research",
    );

    return formatPages(`Deep research on "${query}" (${pages.length} sources via ${source}):`, pages);
  },
  {
    name: "deep_research",
    description:
      "Thoroughly research a topic: searches the web AND reads the full text of the top pages, then returns the content with citations. " +
      "Use for company/market deep-dives, comparisons, or any question where snippets aren't enough. " +
      "Costs more than search_web — prefer search_research_cache first if you've researched this before. " +
      "Read-only — no approval needed.",
    schema: z.object({
      query: z.string().describe("What to research, e.g. 'Acme Corp pricing and positioning'"),
      max_pages: z
        .number()
        .optional()
        .nullable()
        .describe(`Max pages to read (1–${DEEP_RESEARCH_MAX_PAGES}, default ${DEEP_RESEARCH_MAX_PAGES})`),
    }),
  },
);

// ── crawl_site ────────────────────────────────────────────────────────────────

export const crawlSiteTool = tool(
  async ({ start_url, max_pages }) => {
    const cap = Math.min(Math.max(max_pages ?? CRAWL_MAX_PAGES_DEFAULT, 1), CRAWL_MAX_PAGES_CEILING);
    const res = await crawlSite(start_url, cap);
    if (!res.ok) {
      return `Crawl failed for ${start_url}: ${res.error}. (Set APIFY_TOKEN for the Apify website-content-crawler.)`;
    }
    const chunks = await ingestResearch(res.data);

    logResearchEvent(
      `Crawled site: ${start_url}`,
      `Ingested ${res.data.length} pages (${chunks} chunks) from ${start_url} into research memory.`,
      "crawl_site",
    );

    const list = res.data.map((p, i) => `${i + 1}. ${p.title} — ${p.url}`).join("\n");
    return (
      `Crawled ${res.data.length} pages from ${start_url} (via ${res.source}) and saved them to research memory ` +
      `(${chunks} searchable chunks). Query them anytime with search_research_cache.\n\nPages:\n${list}`
    );
  },
  {
    name: "crawl_site",
    description:
      "Crawl an entire website/docs site and save every page to research memory for later semantic search. " +
      "Use for deliberate ingestion of a company's site or a documentation set — NOT for a single page (use scrape_url). " +
      "Read-only — no approval needed.",
    schema: z.object({
      start_url: z.string().describe("The site/docs root URL to crawl, e.g. https://docs.example.com"),
      max_pages: z
        .number()
        .optional()
        .nullable()
        .describe(`Max pages to crawl (1–${CRAWL_MAX_PAGES_CEILING}, default ${CRAWL_MAX_PAGES_DEFAULT})`),
    }),
  },
);
