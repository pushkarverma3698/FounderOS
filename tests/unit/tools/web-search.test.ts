/**
 * Unit tests for webSearchTool
 * ==========================================================
 * Primary: Gemini google_search grounding (GOOGLE_GENERATIVE_AI_API_KEY).
 * Fallback: DuckDuckGo HTML endpoint (html.duckduckgo.com) — free, keyless.
 * Fail-open contract: every error path returns { success:false, data:[], error }
 * — never throws. Callers depend on this guarantee.
 *
 * Coverage:
 *  - parseDuckDuckGoHtml (pure): title/url decode, snippet pairing, limit, malformed, empty
 *  - Gemini grounding primary: success without fallback, soft-fail → DuckDuckGo
 *  - DuckDuckGo fallback: happy path, HTTP error, no results, network throw
 *  - Query construction: site: prefix, plain query, custom limit
 *  - groundedResponseToResults (pure): chunk mapping, snippet selection, empty
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock global fetch ─────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { webSearchTool, groundedResponseToResults, parseDuckDuckGoHtml } = await import(
  "../../../src/tools/web-search.js"
);

// Default: no Gemini key, so suites exercise the DuckDuckGo fallback unless they
// explicitly set the key (the grounding suite does).
beforeEach(() => {
  delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
});

// ── DuckDuckGo HTML fixtures ───────────────────────────────────────────────────

interface DdgItem {
  title: string;
  url: string;
  snippet: string;
}

/** Build a DuckDuckGo HTML results page (redirect-wrapped URLs, like the real thing). */
function ddgHtml(items: DdgItem[]): string {
  return items
    .map((it) => {
      const redirect = `//duckduckgo.com/l/?uddg=${encodeURIComponent(it.url)}&amp;rut=abc123`;
      return (
        `<div class="result"><a rel="nofollow" class="result__a" href="${redirect}">${it.title}</a>` +
        `<a class="result__snippet" href="${redirect}">${it.snippet}</a></div>`
      );
    })
    .join("\n");
}

function makeDdgResponse(items: DdgItem[]) {
  return { ok: true, status: 200, text: async () => ddgHtml(items) };
}

function makeDdgRawResponse(html: string) {
  return { ok: true, status: 200, text: async () => html };
}

function makeErrorResponse(status: number) {
  return { ok: false, status, text: async () => "", json: async () => ({}) };
}

const DDG_ITEMS: DdgItem[] = [
  {
    title: "LangGraph Production Patterns",
    url: "https://blog.langchain.dev/langgraph",
    snippet: "How to run LangGraph in production with checkpointing.",
  },
];

const BASE_ARGS = { query: "LangGraph production" };

// ── parseDuckDuckGoHtml (pure) ──────────────────────────────────────────────────

describe("parseDuckDuckGoHtml", () => {
  it("extracts title, decoded url, and snippet from a result block", () => {
    const html = ddgHtml(DDG_ITEMS);
    const results = parseDuckDuckGoHtml(html, 5);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: "LangGraph Production Patterns",
      url: "https://blog.langchain.dev/langgraph",
      snippet: "How to run LangGraph in production with checkpointing.",
    });
  });

  it("decodes the uddg redirect into the real destination URL", () => {
    const html = ddgHtml([
      { title: "T", url: "https://example.com/path?x=1&y=2", snippet: "s" },
    ]);
    const results = parseDuckDuckGoHtml(html, 5);
    expect(results[0]!.url).toBe("https://example.com/path?x=1&y=2");
  });

  it("strips inner HTML tags and decodes entities in title and snippet", () => {
    const html =
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://a.com")}">Tom &amp; <b>Jerry</b></a>` +
      `<a class="result__snippet" href="x">Bold <b>here</b> &amp; clear</a>`;
    const results = parseDuckDuckGoHtml(html, 5);
    expect(results[0]!.title).toBe("Tom & Jerry");
    expect(results[0]!.snippet).toBe("Bold here & clear");
  });

  it("pairs the Nth snippet with the Nth title in order", () => {
    const html = ddgHtml([
      { title: "A", url: "https://a.com", snippet: "snippet a" },
      { title: "B", url: "https://b.com", snippet: "snippet b" },
    ]);
    const results = parseDuckDuckGoHtml(html, 5);
    expect(results.map((r) => `${r.title}:${r.snippet}`)).toEqual(["A:snippet a", "B:snippet b"]);
  });

  it("caps results at the requested limit", () => {
    const html = ddgHtml(
      Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://x.com/${i}`, snippet: `s${i}` })),
    );
    expect(parseDuckDuckGoHtml(html, 3)).toHaveLength(3);
  });

  it("returns [] for HTML with no result anchors", () => {
    expect(parseDuckDuckGoHtml("<html><body>nothing here</body></html>", 5)).toEqual([]);
  });

  it("handles a protocol-relative direct link without a uddg param", () => {
    const html = `<a class="result__a" href="//direct.example.com/page">Direct</a>`;
    const results = parseDuckDuckGoHtml(html, 5);
    expect(results[0]!.url).toBe("https://direct.example.com/page");
  });
});

// ── DuckDuckGo fallback (Gemini key absent) ─────────────────────────────────────

describe("webSearchTool — DuckDuckGo fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success with parsed results when DuckDuckGo responds", async () => {
    mockFetch.mockResolvedValueOnce(makeDdgResponse(DDG_ITEMS));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    const items = result.data as Array<{ title: string; url: string; snippet: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("LangGraph Production Patterns");
    expect(items[0].url).toBe("https://blog.langchain.dev/langgraph");
    expect(items[0].snippet).toContain("checkpointing");
    // single GET to the DuckDuckGo HTML endpoint, no auth header
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("html.duckduckgo.com");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  it("returns soft failure on HTTP 500 with status in error message", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("500");
  });

  it("returns soft failure when DuckDuckGo returns no parseable results", async () => {
    mockFetch.mockResolvedValueOnce(makeDdgRawResponse("<html>no results</html>"));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("no parseable results");
  });

  it("returns soft failure when fetch throws a network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns soft failure when fetch throws a non-Error object", async () => {
    mockFetch.mockRejectedValueOnce("timeout");
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});

// ── Query construction ──────────────────────────────────────────────────────────

describe("webSearchTool — query construction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(makeDdgResponse(DDG_ITEMS));
  });

  it("prepends 'site:{site}' when site param is provided", async () => {
    await webSearchTool.execute({ query: "typescript tips", site: "stackoverflow.com" });

    const url = new URL(String(mockFetch.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe("site:stackoverflow.com typescript tips");
  });

  it("sends the query unchanged when site param is absent", async () => {
    await webSearchTool.execute({ query: "typescript tips" });

    const url = new URL(String(mockFetch.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe("typescript tips");
  });

  it("caps returned results at a custom limit", async () => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      makeDdgResponse(
        Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, url: `https://x.com/${i}`, snippet: `s${i}` })),
      ),
    );
    const result = await webSearchTool.execute({ query: "test", limit: 4 });
    expect(result.data).toHaveLength(4);
  });
});

// ── Gemini grounding (primary) ──────────────────────────────────────────────────

function makeGroundedResponse(
  answer: string,
  chunks: Array<{ uri: string; title: string }>,
  supports: Array<{ text: string; indices: number[] }> = [],
) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: { parts: [{ text: answer }] },
          groundingMetadata: {
            groundingChunks: chunks.map((c) => ({ web: c })),
            groundingSupports: supports.map((s) => ({
              segment: { text: s.text },
              groundingChunkIndices: s.indices,
            })),
          },
        },
      ],
    }),
  };
}

describe("webSearchTool — Gemini grounding (primary)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "gemini-key";
  });

  afterEach(() => {
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  });

  it("tries Gemini first and succeeds without calling DuckDuckGo", async () => {
    mockFetch.mockResolvedValueOnce(
      makeGroundedResponse(
        "LangGraph 1.0 shipped with durable execution.",
        [{ uri: "https://blog.langchain.dev/langgraph-1", title: "LangGraph 1.0" }],
        [{ text: "LangGraph 1.0 shipped with durable execution.", indices: [0] }],
      ),
    );

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    const items = result.data as Array<{ title: string; url: string; snippet: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("LangGraph 1.0");
    expect(items[0].url).toBe("https://blog.langchain.dev/langgraph-1");
    expect(items[0].snippet).toContain("durable execution");
    expect(mockFetch).toHaveBeenCalledTimes(1); // DuckDuckGo never called
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("gemini-key");
  });

  it("falls back to DuckDuckGo when Gemini fails (503 capacity)", async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(503)) // Gemini capacity error
      .mockResolvedValueOnce(makeDdgResponse(DDG_ITEMS)); // DuckDuckGo succeeds

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [geminiUrl] = mockFetch.mock.calls[0] as [string, unknown];
    const [ddgUrl] = mockFetch.mock.calls[1] as [string, unknown];
    expect(String(geminiUrl)).toContain("generativelanguage.googleapis.com"); // Gemini first
    expect(String(ddgUrl)).toContain("html.duckduckgo.com"); // DuckDuckGo second
  });

  it("reports BOTH errors when Gemini and DuckDuckGo fallback fail", async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500)) // Gemini
      .mockResolvedValueOnce(makeErrorResponse(429)); // DuckDuckGo

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("500");
    expect(result.error).toContain("429");
  });

  it("returns the bare answer as a single result when Gemini cites no sources", async () => {
    mockFetch.mockResolvedValueOnce(makeGroundedResponse("Plain answer with no citations.", []));

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    const items = result.data as Array<{ title: string; snippet: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].snippet).toBe("Plain answer with no citations.");
  });

  it("fails soft when Gemini returns an empty candidate, then tries DuckDuckGo", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ candidates: [] }) }) // Gemini empty
      .mockResolvedValueOnce(makeErrorResponse(404)); // DuckDuckGo also fails

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("no content"); // Gemini soft error
    expect(result.error).toContain("404"); // DuckDuckGo error surfaced too
  });
});

describe("groundedResponseToResults — pure mapping", () => {
  it("maps each grounding chunk to a result, capped at limit", () => {
    const json = {
      candidates: [
        {
          content: { parts: [{ text: "Full answer." }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://a.com", title: "A" } },
              { web: { uri: "https://b.com", title: "B" } },
              { web: { uri: "https://c.com", title: "C" } },
            ],
            groundingSupports: [],
          },
        },
      ],
    };
    const results = groundedResponseToResults(json, "q", 2);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "A", url: "https://a.com", snippet: "Full answer." });
  });

  it("uses citing segments as the chunk snippet when supports exist", () => {
    const json = {
      candidates: [
        {
          content: { parts: [{ text: "Long answer." }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://a.com", title: "A" } }],
            groundingSupports: [
              { segment: { text: "Cited fact one." }, groundingChunkIndices: [0] },
              { segment: { text: "Unrelated." }, groundingChunkIndices: [5] },
            ],
          },
        },
      ],
    };
    const results = groundedResponseToResults(json, "q", 5);
    expect(results[0]!.snippet).toBe("Cited fact one.");
  });

  it("returns [] for an empty response", () => {
    expect(groundedResponseToResults({}, "q", 5)).toEqual([]);
  });
});

// 2026-07-11 incidents ed826c52/cd4fea33: research turns hit the 180s turn kill
// because a hung grounding call had NO per-request timeout (DDG already has one).
describe("Gemini grounding — per-request timeout", () => {
  it("sends the grounding fetch with an abort signal so a hung call cannot eat the turn budget", async () => {
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "test-key";
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text: "answer" }] },
            groundingMetadata: {
              groundingChunks: [{ web: { uri: "https://a.com", title: "A" } }],
              groundingSupports: [],
            },
          },
        ],
      }),
    });

    const out = await webSearchTool.execute({ query: "anything" });
    expect(out.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
