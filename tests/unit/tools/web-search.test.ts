/**
 * Unit tests for webSearchTool
 * ==========================================================
 * Primary: Gemini google_search grounding (GOOGLE_GENERATIVE_AI_API_KEY).
 * Fallback: Firecrawl POST /v1/search (FIRECRAWL_API_KEY, optional).
 * Fail-open contract: every error path returns { success:false, data:[], error }
 * — never throws. Callers depend on this guarantee.
 *
 * Edge cases covered:
 *  1. Missing GOOGLE_GENERATIVE_AI_API_KEY (+ no Firecrawl key) → soft failure
 *  2. HTTP 500 → soft failure with status code in error
 *  3. HTTP 404 → soft failure with status code in error
 *  4. Network error (fetch throws) → soft failure, error message propagated
 *  5. Happy path → success:true, correct SearchResult shape
 *  6. json.data is undefined → success:true, data:[] (null-coalescing guard)
 *  7. json.data is null → success:true, data:[]
 *  8. publishedAt present in result → published_date included in SearchResult
 *  9. publishedAt absent → published_date NOT included in SearchResult
 * 10. publishedAt null → published_date NOT included in SearchResult
 * 11. site param → query prepended with "site:{site} {query}"
 * 12. No site param → query sent unchanged
 * 13. limit param passed through to Firecrawl request body
 * 14. Authorization header uses Bearer token format
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock global fetch ─────────────────────────────────────────────────────────

const mockFetch = vi.fn();

// Dynamic import AFTER mock setup so the module captures our mock
vi.stubGlobal("fetch", mockFetch);

const { webSearchTool, groundedResponseToResults } = await import("../../../src/tools/web-search.js");

// Suites below the grounding suite pin the Gemini key absent so they exercise
// Firecrawl as the sole provider (consistent with the fail-open contract).
beforeEach(() => {
  delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOkResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  };
}

function makeErrorResponse(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
  };
}

const MOCK_RESULT = {
  title: "LangGraph Production Patterns",
  url: "https://blog.langchain.dev/langgraph",
  description: "How to run LangGraph in production with checkpointing.",
  publishedAt: "2026-01-15",
};

const BASE_ARGS = { query: "LangGraph production" };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("webSearchTool — API key guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns soft failure when FIRECRAWL_API_KEY is missing", async () => {
    const saved = process.env["FIRECRAWL_API_KEY"];
    delete process.env["FIRECRAWL_API_KEY"];

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(mockFetch).not.toHaveBeenCalled(); // no Firecrawl key + no Gemini key → no network call

    if (saved !== undefined) process.env["FIRECRAWL_API_KEY"] = saved;
  });
});

describe("webSearchTool — HTTP error responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["FIRECRAWL_API_KEY"] = "test-key";
  });

  afterEach(() => {
    delete process.env["FIRECRAWL_API_KEY"];
  });

  it("returns soft failure on HTTP 500 with status in error message", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("500");
  });

  it("returns soft failure on HTTP 404 with status in error message", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("404");
  });

  it("returns soft failure on HTTP 401 (invalid API key)", async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(401));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("401");
  });
});

describe("webSearchTool — network errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["FIRECRAWL_API_KEY"] = "test-key";
  });

  afterEach(() => {
    delete process.env["FIRECRAWL_API_KEY"];
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

describe("webSearchTool — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["FIRECRAWL_API_KEY"] = "test-key";
  });

  afterEach(() => {
    delete process.env["FIRECRAWL_API_KEY"];
  });

  it("returns success:true with correctly shaped SearchResult array", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse([MOCK_RESULT]));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);

    const item = (result.data as Array<{ title: string; url: string; snippet: string; published_date?: string }>)[0];
    expect(item.title).toBe("LangGraph Production Patterns");
    expect(item.url).toBe("https://blog.langchain.dev/langgraph");
    expect(item.snippet).toBe("How to run LangGraph in production with checkpointing.");
  });

  it("includes published_date when Firecrawl returns publishedAt", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse([MOCK_RESULT]));
    const result = await webSearchTool.execute(BASE_ARGS);

    const item = (result.data as Array<{ published_date?: string }>)[0];
    expect(item.published_date).toBe("2026-01-15");
  });

  it("omits published_date when Firecrawl result has no publishedAt", async () => {
    const resultWithoutDate = { ...MOCK_RESULT, publishedAt: undefined };
    mockFetch.mockResolvedValueOnce(makeOkResponse([resultWithoutDate]));
    const result = await webSearchTool.execute(BASE_ARGS);

    const item = result.data as Array<Record<string, unknown>>;
    expect("published_date" in item[0]).toBe(false);
  });

  it("omits published_date when Firecrawl returns publishedAt:null", async () => {
    const resultNullDate = { ...MOCK_RESULT, publishedAt: null };
    mockFetch.mockResolvedValueOnce(makeOkResponse([resultNullDate]));
    const result = await webSearchTool.execute(BASE_ARGS);

    const item = result.data as Array<Record<string, unknown>>;
    expect("published_date" in item[0]).toBe(false);
  });

  it("returns success:true with empty data when json.data is undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true }), // no data field
    });
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("returns success:true with empty data when json.data is null", async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse(null));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it("returns multiple results in order", async () => {
    const results = [
      { ...MOCK_RESULT, title: "Result A", publishedAt: undefined },
      { ...MOCK_RESULT, title: "Result B", publishedAt: undefined },
      { ...MOCK_RESULT, title: "Result C", publishedAt: undefined },
    ];
    mockFetch.mockResolvedValueOnce(makeOkResponse(results));
    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.data).toHaveLength(3);
    expect((result.data as Array<{ title: string }>)[0].title).toBe("Result A");
    expect((result.data as Array<{ title: string }>)[2].title).toBe("Result C");
  });
});

describe("webSearchTool — query construction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["FIRECRAWL_API_KEY"] = "test-key";
    mockFetch.mockResolvedValue(makeOkResponse([]));
  });

  afterEach(() => {
    delete process.env["FIRECRAWL_API_KEY"];
  });

  it("prepends 'site:{site}' when site param is provided", async () => {
    await webSearchTool.execute({ query: "typescript tips", site: "stackoverflow.com" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.query).toBe("site:stackoverflow.com typescript tips");
  });

  it("sends the query unchanged when site param is absent", async () => {
    await webSearchTool.execute({ query: "typescript tips" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.query).toBe("typescript tips");
  });

  it("passes limit to Firecrawl request body (default 5)", async () => {
    await webSearchTool.execute({ query: "test" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.limit).toBe(5);
  });

  it("passes custom limit to Firecrawl request body", async () => {
    await webSearchTool.execute({ query: "test", limit: 10 });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.limit).toBe(10);
  });

  it("sends Authorization Bearer header with the API key", async () => {
    process.env["FIRECRAWL_API_KEY"] = "fc-secret-abc";
    await webSearchTool.execute({ query: "test" });

    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer fc-secret-abc");
  });
});

// ── Gemini grounding fallback ─────────────────────────────────────────────────

function makeGroundedResponse(answer: string, chunks: Array<{ uri: string; title: string }>, supports: Array<{ text: string; indices: number[] }> = []) {
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
    process.env["FIRECRAWL_API_KEY"] = "test-key";
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "gemini-key";
  });

  afterEach(() => {
    delete process.env["FIRECRAWL_API_KEY"];
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  });

  it("tries Gemini first and succeeds without calling Firecrawl", async () => {
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
    expect(mockFetch).toHaveBeenCalledTimes(1); // Firecrawl never called
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("gemini-key");
  });

  it("falls back when FIRECRAWL_API_KEY is missing entirely", async () => {
    delete process.env["FIRECRAWL_API_KEY"];
    mockFetch.mockResolvedValueOnce(
      makeGroundedResponse("Answer text.", [{ uri: "https://x.com/a", title: "A" }]),
    );

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1); // straight to Gemini
  });

  it("falls back to Firecrawl when Gemini fails with both keys set", async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(503)) // Gemini capacity error
      .mockResolvedValueOnce(makeOkResponse([MOCK_RESULT])); // Firecrawl succeeds

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [geminiUrl] = mockFetch.mock.calls[0] as [string, unknown];
    const [firecrawlUrl] = mockFetch.mock.calls[1] as [string, unknown];
    expect(String(geminiUrl)).toContain("generativelanguage.googleapis.com"); // Gemini first
    expect(String(firecrawlUrl)).toContain("firecrawl.dev"); // Firecrawl second
  });

  it("reports BOTH errors when Firecrawl and Gemini fallback fail", async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(402))
      .mockResolvedValueOnce(makeErrorResponse(429));

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("402");
    expect(result.error).toContain("429");
  });

  it("Firecrawl 402 fallback includes the credits-exhausted hint", async () => {
    mockFetch
      .mockResolvedValueOnce(makeErrorResponse(500)) // Gemini fails first
      .mockResolvedValueOnce(makeErrorResponse(402)); // Firecrawl 402

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.error).toContain("credits exhausted");
  });

  it("returns the bare answer as a single result when Gemini cites no sources", async () => {
    mockFetch.mockResolvedValueOnce(makeGroundedResponse("Plain answer with no citations.", []));

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(true);
    const items = result.data as Array<{ title: string; snippet: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].snippet).toBe("Plain answer with no citations.");
  });

  it("fails soft when Gemini returns an empty candidate, then tries Firecrawl", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ candidates: [] }) }) // Gemini empty
      .mockResolvedValueOnce(makeErrorResponse(404)); // Firecrawl also fails

    const result = await webSearchTool.execute(BASE_ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("no content"); // Gemini soft error
    expect(result.error).toContain("404"); // Firecrawl error surfaced too
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
