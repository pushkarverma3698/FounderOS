/**
 * Unit tests for the research tool wrappers (src/agents/agent-tools/research.ts)
 * ============================================================================
 * Mocked engine + memory — $0. Covers the deterministic guarantees that must NOT
 * depend on a prompt: deep_research page cap, cache-first, and the Apify→search_web
 * fail-open fallback; scrape_url cache-first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const scrapeUrl = vi.fn();
const ragSearch = vi.fn();
const crawlSite = vi.fn();
const webExecute = vi.fn();
const getCachedScrape = vi.fn();
const setCachedScrape = vi.fn().mockResolvedValue(undefined);
const ingestResearch = vi.fn().mockResolvedValue(1);
const recordInvoke = vi.fn().mockResolvedValue("ok");

vi.mock("../../../src/tools/apify.js", () => ({ scrapeUrl, ragSearch, crawlSite }));
vi.mock("../../../src/tools/web-search.js", () => ({ webSearchTool: { execute: webExecute } }));
vi.mock("../../../src/infra/research-memory.js", () => ({ getCachedScrape, setCachedScrape, ingestResearch }));
vi.mock("../../../src/tools/memory.js", () => ({ recordEventTool: { invoke: recordInvoke } }));

const { scrapeUrlTool, deepResearch } = await import("../../../src/agents/agent-tools/research.js");

const mkPage = (url: string) => ({ url, title: url, markdown: `body of ${url}`, retrieved_at: "2026-06-24T00:00:00.000Z" });

beforeEach(() => {
  vi.clearAllMocks();
  getCachedScrape.mockResolvedValue(null);
});

describe("deep_research", () => {
  it("returns cached pages without calling the scraper", async () => {
    getCachedScrape.mockResolvedValueOnce([mkPage("https://cached.com")]);
    const out = (await deepResearch.invoke({ query: "acme" })) as string;
    expect(out).toContain("from cache");
    expect(out).toContain("https://cached.com");
    expect(ragSearch).not.toHaveBeenCalled();
  });

  it("clamps max_pages to the hard cap (3) when asked for more", async () => {
    ragSearch.mockResolvedValueOnce({ ok: true, source: "apify", data: [mkPage("https://a.com")] });
    await deepResearch.invoke({ query: "acme", max_pages: 10 });
    expect(ragSearch).toHaveBeenCalledWith("acme", 3);
  });

  it("falls back to search_web + per-URL scrape when Apify is unavailable", async () => {
    ragSearch.mockResolvedValueOnce({ ok: false, error: "APIFY_TOKEN not set" });
    webExecute.mockResolvedValueOnce({
      success: true,
      data: [{ url: "https://1.com" }, { url: "https://2.com" }, { url: "https://3.com" }, { url: "https://4.com" }],
    });
    scrapeUrl.mockResolvedValue({ ok: true, source: "fetch", data: [mkPage("https://x.com")] });

    const out = (await deepResearch.invoke({ query: "acme" })) as string;

    // cap = 3 → only the first three URLs are scraped
    expect(scrapeUrl).toHaveBeenCalledTimes(3);
    expect(out).toContain("search_web+fetch");
    expect(ingestResearch).toHaveBeenCalled();
  });

  it("reports honestly when nothing readable is found", async () => {
    ragSearch.mockResolvedValueOnce({ ok: false, error: "no token" });
    webExecute.mockResolvedValueOnce({ success: true, data: [] });
    const out = (await deepResearch.invoke({ query: "ghost topic" })) as string;
    expect(out).toContain("no readable pages");
    expect(ingestResearch).not.toHaveBeenCalled();
  });
});

describe("scrape_url", () => {
  it("returns cached content without re-scraping", async () => {
    getCachedScrape.mockResolvedValueOnce([mkPage("https://a.com")]);
    const out = (await scrapeUrlTool.invoke({ url: "https://a.com" })) as string;
    expect(out).toContain("from cache");
    expect(scrapeUrl).not.toHaveBeenCalled();
  });

  it("scrapes, persists, and formats with the source on a cache miss", async () => {
    scrapeUrl.mockResolvedValueOnce({ ok: true, source: "apify", data: [mkPage("https://a.com")] });
    const out = (await scrapeUrlTool.invoke({ url: "https://a.com" })) as string;
    expect(scrapeUrl).toHaveBeenCalledWith("https://a.com");
    expect(setCachedScrape).toHaveBeenCalled();
    expect(ingestResearch).toHaveBeenCalled();
    expect(out).toContain("via apify");
  });
});
