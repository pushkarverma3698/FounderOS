/**
 * Unit tests for the Apify scrape engine (src/tools/apify.ts)
 * ==========================================================
 * Mocked fetch — $0, no live Apify call (Cost Gate, rule #23). Covers:
 *  - pure mappers (mapRagBrowserItems, mapCrawlerItems, extractTitle)
 *  - runActorSync: no-token guard, Bearer auth + URL, HTTP error, non-array, throw
 *  - fetchToMarkdown fallback: success (script/style stripped), error, empty, throw
 *  - scrapeUrl / ragSearch / crawlSite: Apify-primary → fetch fail-open contract
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const {
  mapRagBrowserItems,
  mapCrawlerItems,
  extractTitle,
  runActorSync,
  fetchToMarkdown,
  scrapeUrl,
  ragSearch,
  crawlSite,
  RAG_BROWSER_ACTOR,
  CONTENT_CRAWLER_ACTOR,
} = await import("../../../src/tools/apify.js");
const { env } = await import("../../../src/core/config.js");

const AT = "2026-06-24T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  delete env.APIFY_TOKEN;
  env.SCRAPE_BACKEND = "apify";
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}
function htmlResponse(html: string, ok = true, status = 200) {
  return { ok, status, text: async () => html };
}

// ── Pure mappers ────────────────────────────────────────────────────────────

describe("mapRagBrowserItems", () => {
  it("maps metadata.url/title + markdown into a ScrapeResult", () => {
    const out = mapRagBrowserItems(
      [{ metadata: { url: "https://a.com", title: "A Co" }, markdown: "# Hello" }],
      AT,
    );
    expect(out).toEqual([{ url: "https://a.com", title: "A Co", markdown: "# Hello", retrieved_at: AT }]);
  });

  it("falls back title → url → 'Untitled' and reads text when markdown absent", () => {
    const out = mapRagBrowserItems([{ metadata: { url: "https://b.com" }, text: "plain body" }], AT);
    expect(out[0]!.title).toBe("https://b.com");
    expect(out[0]!.markdown).toBe("plain body");
  });

  it("drops items with neither markdown nor url", () => {
    const out = mapRagBrowserItems([{ metadata: { title: "ghost" } }, { markdown: "real", url: "https://c.com" }], AT);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe("https://c.com");
  });
});

describe("mapCrawlerItems", () => {
  it("maps url/title/markdown and filters empty pages", () => {
    const out = mapCrawlerItems(
      [
        { url: "https://docs.x/1", title: "P1", markdown: "body1" },
        { url: "https://docs.x/2", title: "P2", markdown: "" },
      ],
      AT,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ url: "https://docs.x/1", title: "P1", markdown: "body1", retrieved_at: AT });
  });
});

describe("extractTitle", () => {
  it("extracts and strips the <title>, else falls back to the URL", () => {
    expect(extractTitle("<html><title>Hello &amp; Co</title></html>", "https://x.com")).toBe("Hello & Co");
    expect(extractTitle("<html>no title</html>", "https://x.com")).toBe("https://x.com");
  });
});

// ── runActorSync ────────────────────────────────────────────────────────────

describe("runActorSync", () => {
  it("returns ok:false without calling fetch when APIFY_TOKEN is unset", async () => {
    const res = await runActorSync(RAG_BROWSER_ACTOR, { query: "q" }, 1000);
    expect(res).toEqual({ ok: false, error: "APIFY_TOKEN not set" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POSTs to run-sync-get-dataset-items with a Bearer token and returns items", async () => {
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockResolvedValueOnce(jsonResponse([{ markdown: "x", url: "https://a.com" }]));

    const res = await runActorSync(RAG_BROWSER_ACTOR, { query: "q", maxResults: 1 }, 1000);

    expect(res).toEqual({ ok: true, items: [{ markdown: "x", url: "https://a.com" }] });
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/acts/${RAG_BROWSER_ACTOR}/run-sync-get-dataset-items`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer apify_test");
    expect(JSON.parse(init?.body as string)).toEqual({ query: "q", maxResults: 1 });
  });

  it("returns ok:false with the status on a non-2xx response", async () => {
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockResolvedValueOnce(jsonResponse({}, false, 408));
    const res = await runActorSync(RAG_BROWSER_ACTOR, {}, 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("408");
  });

  it("keeps the actor's own complaint, not just the status code", async () => {
    // "returned HTTP 400" is undiagnosable: it cannot tell a malformed input
    // from a rate limit from an actor whose schema changed. On 2026-08-03 the
    // Netherlands Indeed query failed and that bare sentence is all that was
    // recorded, so the cause could not be established afterwards at any price.
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"Input is not valid: remote"}}',
    });

    const res = await runActorSync(RAG_BROWSER_ACTOR, {}, 1000);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Input is not valid: remote");
  });

  it("still reports the status when the error body cannot be read", async () => {
    // The body is the detail; the status is the finding. Losing both because a
    // stream failed would be strictly worse than what we had before.
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => {
        throw new Error("stream already consumed");
      },
    });

    const res = await runActorSync(RAG_BROWSER_ACTOR, {}, 1000);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("429");
  });

  it("returns ok:false when the dataset is not an array", async () => {
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockResolvedValueOnce(jsonResponse({ not: "array" }));
    const res = await runActorSync(RAG_BROWSER_ACTOR, {}, 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("non-array");
  });

  it("never throws when fetch rejects", async () => {
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
    const res = await runActorSync(RAG_BROWSER_ACTOR, {}, 1000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("ECONNRESET");
  });
});

// ── fetchToMarkdown (keyless fallback) ──────────────────────────────────────

describe("fetchToMarkdown", () => {
  it("strips script/style + tags and returns markdown + title", async () => {
    const html =
      "<html><head><title>Pricing</title><style>.x{}</style></head>" +
      "<body><script>evil()</script><h1>Plans</h1><p>From $10</p></body></html>";
    mockFetch.mockResolvedValueOnce(htmlResponse(html));

    const res = await fetchToMarkdown("https://x.com/pricing");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source).toBe("fetch");
      expect(res.data[0]!.title).toBe("Pricing");
      expect(res.data[0]!.markdown).toContain("Plans");
      expect(res.data[0]!.markdown).toContain("From $10");
      expect(res.data[0]!.markdown).not.toContain("evil");
      expect(res.data[0]!.markdown).not.toContain(".x{}");
    }
  });

  it("returns ok:false on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce(htmlResponse("", false, 403));
    const res = await fetchToMarkdown("https://x.com");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("403");
  });

  it("returns ok:false when the page has no readable text", async () => {
    mockFetch.mockResolvedValueOnce(htmlResponse("<html><body></body></html>"));
    const res = await fetchToMarkdown("https://x.com");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("no readable text");
  });

  it("never throws when fetch rejects", async () => {
    mockFetch.mockRejectedValueOnce("boom");
    const res = await fetchToMarkdown("https://x.com");
    expect(res.ok).toBe(false);
  });
});

// ── scrapeUrl: Apify primary → fetch fail-open ───────────────────────────────

describe("scrapeUrl", () => {
  it("uses Apify rag-web-browser when a token is set", async () => {
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ metadata: { url: "https://a.com", title: "A" }, markdown: "full text" }]),
    );

    const res = await scrapeUrl("https://a.com");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.source).toBe("apify");
      expect(res.data[0]?.markdown).toBe("full text");
    }
    const [callUrl1] = mockFetch.mock.calls[0] ?? [];
    expect(String(callUrl1)).toContain(RAG_BROWSER_ACTOR);
  });

  it("falls back to fetch when Apify returns no items", async () => {
    env.APIFY_TOKEN = "apify_test";
    mockFetch
      .mockResolvedValueOnce(jsonResponse([])) // Apify empty
      .mockResolvedValueOnce(htmlResponse("<title>Fallback</title><p>hi there</p>")); // fetch

    const res = await scrapeUrl("https://a.com");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source).toBe("fetch");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("goes straight to fetch when no token is set", async () => {
    mockFetch.mockResolvedValueOnce(htmlResponse("<title>T</title><p>body</p>"));
    const res = await scrapeUrl("https://a.com");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source).toBe("fetch");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [callUrl2] = mockFetch.mock.calls[0] ?? [];
    expect(String(callUrl2)).toBe("https://a.com");
  });

  it("honors SCRAPE_BACKEND=fetch even when a token is present", async () => {
    env.APIFY_TOKEN = "apify_test";
    env.SCRAPE_BACKEND = "fetch";
    mockFetch.mockResolvedValueOnce(htmlResponse("<title>T</title><p>body</p>"));
    const res = await scrapeUrl("https://a.com");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source).toBe("fetch");
    const [callUrl3] = mockFetch.mock.calls[0] ?? [];
    expect(String(callUrl3)).toBe("https://a.com");
  });
});

// ── ragSearch ────────────────────────────────────────────────────────────────

describe("ragSearch", () => {
  it("returns ok:false (guiding to the fallback) when no token is set", async () => {
    const res = await ragSearch("acme pricing", 3);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("APIFY_TOKEN");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns mapped pages from Apify when a token is set", async () => {
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { metadata: { url: "https://a.com", title: "A" }, markdown: "a body" },
        { metadata: { url: "https://b.com", title: "B" }, markdown: "b body" },
      ]),
    );
    const res = await ragSearch("topic", 3);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toHaveLength(2);
  });
});

// ── crawlSite ────────────────────────────────────────────────────────────────

describe("crawlSite", () => {
  it("uses the content-crawler actor when a token is set", async () => {
    env.APIFY_TOKEN = "apify_test";
    mockFetch.mockResolvedValueOnce(
      jsonResponse([{ url: "https://docs.x/1", title: "P1", markdown: "body" }]),
    );
    const res = await crawlSite("https://docs.x", 5);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source).toBe("apify");
    const [callUrl4] = mockFetch.mock.calls[0] ?? [];
    expect(String(callUrl4)).toContain(CONTENT_CRAWLER_ACTOR);
  });

  it("falls back to a single-page fetch when no token is set", async () => {
    mockFetch.mockResolvedValueOnce(htmlResponse("<title>Root</title><p>landing</p>"));
    const res = await crawlSite("https://docs.x", 5);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.source).toBe("fetch");
  });
});
