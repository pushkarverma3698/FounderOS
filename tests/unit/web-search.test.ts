/**
 * TDD — web-search.ts (Firecrawl implementation)
 * RED → write these tests first, watch them fail, then implement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SearchResult } from "../../src/tools/web-search.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_FIRECRAWL_RESPONSE = {
  success: true,
  data: [
    {
      title: "Notion — The all-in-one workspace",
      url: "https://notion.so",
      description: "Notion is the connected workspace where better, faster work happens.",
      publishedAt: "2024-01-15",
    },
    {
      title: "Notion pricing",
      url: "https://notion.so/pricing",
      description: "Explore Notion's plans for individuals and teams.",
      publishedAt: null,
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("webSearchTool", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env["FIRECRAWL_API_KEY"] = "fc-test-key-123";
    // Pin the Gemini grounding fallback OFF — the host shell may carry a real
    // key, and these tests assert the legacy Firecrawl-only contract.
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => MOCK_FIRECRAWL_RESPONSE,
    } as Response);
  });

  afterEach(() => {
    delete process.env["FIRECRAWL_API_KEY"];
    vi.restoreAllMocks();
  });

  it("returns mapped SearchResult[] from Firecrawl response", async () => {
    const { webSearchTool } = await import("../../src/tools/web-search.js");

    const result = await webSearchTool.execute({ query: "notion workspace", limit: 5 });

    expect(result.success).toBe(true);
    const results = result.data as SearchResult[];
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "Notion — The all-in-one workspace",
      url: "https://notion.so",
      snippet: "Notion is the connected workspace where better, faster work happens.",
      published_date: "2024-01-15",
    });
  });

  it("calls Firecrawl API with correct URL and Authorization header", async () => {
    process.env["FIRECRAWL_API_KEY"] = "fc-test-key-123";
    const { webSearchTool } = await import("../../src/tools/web-search.js");

    await webSearchTool.execute({ query: "saas pricing strategies", limit: 3 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.firecrawl.dev/v1/search");
    expect((options.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer fc-test-key-123",
    );
    const body = JSON.parse(options.body as string);
    expect(body.query).toBe("saas pricing strategies");
    expect(body.limit).toBe(3);
  });

  it("prepends site: to query when site param is provided", async () => {
    process.env["FIRECRAWL_API_KEY"] = "fc-test-key-123";
    const { webSearchTool } = await import("../../src/tools/web-search.js");

    await webSearchTool.execute({ query: "pricing", site: "notion.so" });

    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.query).toBe("site:notion.so pricing");
  });

  it("returns empty array and success:false when Firecrawl returns non-ok (fail-open)", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "rate limited" }),
    } as Response);
    const { webSearchTool } = await import("../../src/tools/web-search.js");

    const result = await webSearchTool.execute({ query: "test query" });

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("429");
  });

  it("returns empty array when fetch throws (network error — fail-open)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const { webSearchTool } = await import("../../src/tools/web-search.js");

    const result = await webSearchTool.execute({ query: "test query" });

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns empty array when FIRECRAWL_API_KEY is not set (no key — fail-open)", async () => {
    delete process.env["FIRECRAWL_API_KEY"];
    const { webSearchTool } = await import("../../src/tools/web-search.js");

    const result = await webSearchTool.execute({ query: "test query" });

    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
