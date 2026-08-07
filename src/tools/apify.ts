/**
 * FounderOS — Apify Scrape Engine
 * ================================
 * Real-data engine for the research department. Apify (https://apify.com) is the
 * largest scraper marketplace; we drive two of its actors through the REST API:
 *
 *   apify/rag-web-browser       → query OR url → top-N pages as clean Markdown
 *                                 (purpose-built for RAG/agents). Powers
 *                                 scrape_url + deep_research.
 *   apify/website-content-crawler → crawl a whole site/docs → Markdown for bulk
 *                                 ingestion. Powers crawl_site.
 *
 * One token, all environments: APIFY_TOKEN (Bearer auth). Base URL configurable
 * via APIFY_BASE_URL. SCRAPE_BACKEND="fetch" forces the keyless fallback.
 *
 * Fail-open (mirrors web-search.ts): if Apify is unset/errors, fall back to an
 * in-process `fetch` → strip-to-markdown so the tool NEVER hard-fails. This is
 * the lesson from the removed Firecrawl integration (402 once credits ran out,
 * see web-search.ts header): a paid scraper must degrade, not break.
 *
 * This module only does NETWORK + MAPPING. Caching, embedding, and memory
 * ingestion live in src/infra/research-memory.ts so each concern is testable
 * in isolation. Pure mappers are exported for unit tests (no live network).
 */

import { childLogger } from "../infra/logger.js";
import { stripHtml } from "./web-search.js";
import { readPageViaJina } from "./agent-reach.js";
import { env } from "../core/config.js";

const log = childLogger({ module: "tool:apify" });

// ── Actor ids (Apify uses `~` instead of `/` in the REST path) ────────────────
export const RAG_BROWSER_ACTOR = "apify~rag-web-browser";
export const CONTENT_CRAWLER_ACTOR = "apify~website-content-crawler";

const DEFAULT_SCRAPE_TIMEOUT_MS = 60_000;
const DEFAULT_CRAWL_TIMEOUT_MS = 120_000; // well under Apify's 300s sync ceiling
const FETCH_FALLBACK_TIMEOUT_MS = 15_000;
const MARKDOWN_MAX = 12_000; // bound a single page so one scrape can't blow the budget

// ── Public types ──────────────────────────────────────────────────────────────

export interface ScrapeResult {
  url: string;
  title: string;
  markdown: string;
  /** ISO-8601 timestamp of when this content was retrieved (citation metadata). */
  retrieved_at: string;
}

export type ScrapeOutcome =
  | { ok: true; data: ScrapeResult[]; source: "apify" | "fetch" | "jina" }
  | { ok: false; error: string };

// ── Low-level: run an Apify actor synchronously ───────────────────────────────

type ActorRun = { ok: true; items: unknown[] } | { ok: false; error: string };

/**
 * POST /v2/acts/{actorId}/run-sync-get-dataset-items — run an actor and get its
 * dataset items back in one call. Bearer auth. Never throws (fail-open).
 * Runs exceeding 300s return HTTP 408; we cap our inputs well under that.
 */
export async function runActorSync(
  actorId: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): Promise<ActorRun> {
  const token = env.APIFY_TOKEN;
  if (!token) return { ok: false, error: "APIFY_TOKEN not set" };

  const url = `${env.APIFY_BASE_URL}/acts/${actorId}/run-sync-get-dataset-items`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // The BODY, not just the status. Apify puts the actual complaint there —
      // which input key it rejected, which value was out of range. On 2026-08-03
      // the NL query failed with a bare "returned HTTP 400" recorded, and that
      // sentence is undiagnosable: it cannot distinguish a malformed input from
      // a rate limit from an actor that changed its schema. Truncated because an
      // error string ends up in a Telegram message and a database column.
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // allow-failopen: the STATUS is the finding; the body is the detail. A
        // body we cannot read must never cost us the status code too, which is
        // what turns a diagnosable 400 into "response.text is not a function".
        detail = "";
      }
      const suffix = detail.trim() ? `: ${detail.trim().slice(0, 500)}` : "";
      return {
        ok: false,
        error: `Apify actor ${actorId} returned HTTP ${response.status}${suffix}`,
      };
    }
    const json = (await response.json()) as unknown;
    if (!Array.isArray(json)) {
      return { ok: false, error: `Apify actor ${actorId} returned a non-array dataset` };
    }
    return { ok: true, items: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Pure mappers (exported for unit tests — no network) ───────────────────────

/** First non-empty string among the candidates, else "". */
function firstString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * Map apify/rag-web-browser dataset items → ScrapeResult[]. Item shape (defensive):
 *   { metadata: { url, title }, markdown, text, searchResult: { url, title } }
 */
export function mapRagBrowserItems(items: unknown[], retrievedAt: string): ScrapeResult[] {
  return items.map((raw) => {
    const item = asRecord(raw);
    const meta = asRecord(item["metadata"]);
    const search = asRecord(item["searchResult"]);
    const url = firstString(meta["url"], item["url"], search["url"]);
    const title = firstString(meta["title"], item["title"], search["title"], url, "Untitled");
    const markdown = firstString(item["markdown"], item["text"], meta["description"]).slice(0, MARKDOWN_MAX);
    return { url, title, markdown, retrieved_at: retrievedAt };
  }).filter((r) => r.markdown.length > 0 || r.url.length > 0);
}

/**
 * Map apify/website-content-crawler dataset items → ScrapeResult[]. Item shape:
 *   { url, title, markdown, text, metadata: { canonicalUrl, title } }
 */
export function mapCrawlerItems(items: unknown[], retrievedAt: string): ScrapeResult[] {
  return items.map((raw) => {
    const item = asRecord(raw);
    const meta = asRecord(item["metadata"]);
    const url = firstString(item["url"], meta["canonicalUrl"]);
    const title = firstString(item["title"], meta["title"], url, "Untitled");
    const markdown = firstString(item["markdown"], item["text"]).slice(0, MARKDOWN_MAX);
    return { url, title, markdown, retrieved_at: retrievedAt };
  }).filter((r) => r.markdown.length > 0);
}

// ── Keyless fallback: fetch a single URL → markdown-ish text ───────────────────

const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Extract a <title> from raw HTML, else fall back to the URL. */
export function extractTitle(html: string, url: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? stripHtml(m[1]) : url;
}

/** Fetch one URL and strip it to plain text. Never throws (fail-open). */
export async function fetchToMarkdown(url: string, timeoutMs = FETCH_FALLBACK_TIMEOUT_MS): Promise<ScrapeOutcome> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": FALLBACK_USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { ok: false, error: `fetch fallback: ${url} returned HTTP ${response.status}` };
    }
    const html = await response.text();
    const title = extractTitle(html, url);
    // Drop script/style blocks before stripping tags so we don't keep JS/CSS noise.
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ");
    const markdown = stripHtml(body).slice(0, MARKDOWN_MAX);
    if (markdown.length === 0) {
      return { ok: false, error: `fetch fallback: no readable text at ${url}` };
    }
    return {
      ok: true,
      source: "fetch",
      data: [{ url, title, markdown, retrieved_at: new Date().toISOString() }],
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── High-level fail-open operations (used by the tool wrappers) ────────────────

function useApify(): boolean {
  return env.SCRAPE_BACKEND === "apify" && Boolean(env.APIFY_TOKEN);
}

/** Scrape a single URL → clean markdown. Apify rag-web-browser → fetch fallback. */
export async function scrapeUrl(url: string, timeoutMs = DEFAULT_SCRAPE_TIMEOUT_MS): Promise<ScrapeOutcome> {
  if (useApify()) {
    const run = await runActorSync(
      RAG_BROWSER_ACTOR,
      { query: url, maxResults: 1, outputFormats: ["markdown"] },
      timeoutMs,
    );
    if (run.ok) {
      const data = mapRagBrowserItems(run.items, new Date().toISOString());
      if (data.length > 0) return { ok: true, data, source: "apify" };
      log.warn({ url }, "Apify rag-web-browser returned no items — trying fetch fallback");
    } else {
      log.warn({ url, error: run.error }, "Apify scrape failed — trying fetch fallback");
    }
  }
  const fetched = await fetchToMarkdown(url);
  if (fetched.ok) return fetched;

  // Last resort: Jina Reader (agent-reach's keyless web backend). Reaches pages
  // that block a plain fetch or render their body via JS, with no token. Only
  // runs once the two cheaper tiers have already failed.
  const jina = await readPageViaJina(url);
  if (jina.ok) {
    log.info({ url }, "scrapeUrl: recovered via Jina Reader after fetch fallback failed");
    return {
      ok: true,
      data: [{ url, title: jina.title, markdown: jina.markdown.slice(0, MARKDOWN_MAX), retrieved_at: new Date().toISOString() }],
      source: "jina",
    };
  }
  // Report the fetch tier's error — it names the component the caller can act on.
  return fetched;
}

/**
 * Search-and-scrape: query → top-N pages as markdown. Apify rag-web-browser does
 * search + scrape in one call. Caller (deep_research) supplies a fetch-based
 * fallback by combining search_web + scrapeUrl when Apify is unavailable.
 */
export async function ragSearch(
  query: string,
  maxResults: number,
  timeoutMs = DEFAULT_SCRAPE_TIMEOUT_MS,
): Promise<ScrapeOutcome> {
  if (!useApify()) {
    return { ok: false, error: "APIFY_TOKEN not set (or SCRAPE_BACKEND=fetch) — deep_research falls back to search_web + per-URL fetch" };
  }
  const run = await runActorSync(
    RAG_BROWSER_ACTOR,
    { query, maxResults, outputFormats: ["markdown"] },
    timeoutMs,
  );
  if (!run.ok) return { ok: false, error: run.error };
  const data = mapRagBrowserItems(run.items, new Date().toISOString());
  if (data.length === 0) return { ok: false, error: `Apify rag-web-browser returned no results for "${query}"` };
  return { ok: true, data, source: "apify" };
}

/** Crawl a site/docs → markdown pages. Apify website-content-crawler → single-page fetch fallback. */
export async function crawlSite(
  startUrl: string,
  maxPages: number,
  timeoutMs = DEFAULT_CRAWL_TIMEOUT_MS,
): Promise<ScrapeOutcome> {
  if (useApify()) {
    const run = await runActorSync(
      CONTENT_CRAWLER_ACTOR,
      { startUrls: [{ url: startUrl }], maxCrawlPages: maxPages, saveMarkdown: true },
      timeoutMs,
    );
    if (run.ok) {
      const data = mapCrawlerItems(run.items, new Date().toISOString());
      if (data.length > 0) return { ok: true, data, source: "apify" };
      log.warn({ startUrl }, "Apify crawler returned no pages — trying single-page fetch fallback");
    } else {
      log.warn({ startUrl, error: run.error }, "Apify crawl failed — trying single-page fetch fallback");
    }
  }
  return fetchToMarkdown(startUrl);
}
