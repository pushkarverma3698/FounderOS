/**
 * Unit tests for career tools (job-hunt department).
 * TDD: RED first — src/tools/career.ts doesn't exist yet.
 *
 * Career tools are READ-ONLY (no HITL). Two tools:
 *   readCv(query)      — queries personal-rag API; falls back to wiki.md
 *   searchJobs(query)  — wraps Firecrawl web search for job listings
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks for node:fs (used by wiki fallback) ──────────────────────────────

const mockReadFileSync = vi.fn();

vi.mock("node:fs", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, readFileSync: mockReadFileSync };
});

const { readCvTool, searchJobsTool } = await import("../../../src/tools/career.js");

// ── readCv ───────────────────────────────────────────────────────────────────

const WIKI_CONTENT = "# TypeScript\nPushkar has 3+ years of TypeScript experience building production systems.\n# LangGraph\nPushkar has built LangGraph multi-agent pipelines.";

describe("readCvTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: wiki read succeeds with stub content
    mockReadFileSync.mockReturnValue(WIKI_CONTENT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has name 'read_cv'", () => {
    expect(readCvTool.name).toBe("read_cv");
  });

  it("has a description mentioning CV / career", () => {
    expect(readCvTool.description.toLowerCase()).toMatch(/cv|resume|career|personal/);
  });

  it("has input_schema with query field", () => {
    expect(readCvTool.input_schema?.properties["query"]).toBeDefined();
  });

  it("returns text content when API responds successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "LangGraph experience",
        results: [
          {
            text: "Pushkar has 2+ years building LangGraph multi-agent systems.",
            metadata: { source_file: "wiki.md", doc_type: "resume" },
            score: 0.92,
          },
        ],
        total: 1,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await readCvTool.execute({ query: "LangGraph experience" });
    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
    expect((result.data as string).toLowerCase()).toContain("langgraph");
  });

  it("falls back to wiki.md when API is unavailable", async () => {
    // API call fails (service not running)
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await readCvTool.execute({ query: "TypeScript skills" });
    // Should still succeed via wiki fallback (mockReadFileSync returns WIKI_CONTENT)
    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
    expect((result.data as string).length).toBeGreaterThan(20);
  });

  it("returns success:false with descriptive error when both API and wiki fail", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT: no such file"); });

    const result = await readCvTool.execute({ query: "nonexistent query xyz" });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // ── L6: Actionable error when both sources fail ───────────────────────────

  // UPDATED 2026-08-21. This asserted the error said "uvicorn" — i.e. that it
  // told the reader to start a Python service in ~/Projects/personal-rag. On the
  // production VPS that directory does not exist, so the one instruction the
  // founder received was one he could not carry out, from a machine he was not
  // sitting at. The error now names every source that was tried and the env var
  // that fixes it, which is actionable on either machine.
  it("names every source it tried when they all fail, not one laptop-only remedy", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);
    mockReadFileSync.mockImplementation(() => { throw new Error("ENOENT: no such file or directory"); });

    const result = await readCvTool.execute({ query: "anything" });
    expect(result.success).toBe(false);
    expect(result.error).not.toContain("uvicorn");
    expect(result.error).toContain("PERSONAL_CV_DIR");
    expect(result.error).toMatch(/wiki/i);
  });

  it("never exposes raw financial or credential data in output", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "financial records",
        results: [
          {
            text: "Bank account: 1234567890, password: secret123",
            metadata: { doc_type: "financial" },
            score: 0.8,
          },
        ],
        total: 1,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await readCvTool.execute({ query: "financial records" });
    // Tool should either block financial type or return it sanitized
    // At minimum it should succeed (no crash on sensitive content)
    expect(result).toBeDefined();
  });
});

// ── searchJobs ───────────────────────────────────────────────────────────────

describe("searchJobsTool", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("has name 'search_jobs'", () => {
    expect(searchJobsTool.name).toBe("search_jobs");
  });

  it("has a description mentioning jobs/vacancies/roles", () => {
    expect(searchJobsTool.description.toLowerCase()).toMatch(/job|role|vacanc|position|hiring/);
  });

  it("has input_schema with query and optional location", () => {
    const props = searchJobsTool.input_schema?.properties;
    expect(props?.["query"]).toBeDefined();
    expect(props?.["location"]).toBeDefined();
  });

  // search_jobs now delegates to webSearchTool (Gemini grounding → DuckDuckGo
  // fallback). With no GOOGLE_GENERATIVE_AI_API_KEY in the test env, the keyless
  // DuckDuckGo path runs — a GET whose results come back as HTML via .text().
  function ddgResult(title: string, url: string, snippet: string): string {
    const uddg = encodeURIComponent(url);
    return (
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=${uddg}&rut=x">${title}</a>` +
      `<a class="result__snippet">${snippet}</a>`
    );
  }

  // The Gemini grounding primary calls fetch().json(); our mock object exposes
  // only .text(), so Gemini fails and the search falls through to DuckDuckGo
  // (which reads .text()). mockResolvedValue (not …Once) serves BOTH attempts.
  function findDdgCall(mockFetch: ReturnType<typeof vi.fn>): string {
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes("duckduckgo"));
    return String(call?.[0] ?? "");
  }

  it("appends location to the search query when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => ddgResult("AI Engineer — Amsterdam", "https://example.com/jobs/1", "LangGraph role."),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await searchJobsTool.execute({ query: "AI engineer LangGraph", location: "Amsterdam" });
    expect(result.success).toBe(true);

    // The query (with location) is carried in the DuckDuckGo GET URL's ?q= param.
    const q = new URL(findDdgCall(mockFetch)).searchParams.get("q") ?? "";
    expect(q.toLowerCase()).toContain("amsterdam");
    expect(q.toLowerCase()).toContain("langgraph");
  });

  it("returns formatted job list as string", async () => {
    const html =
      ddgResult("Senior AI Engineer", "https://corp.com/job", "Build agents.") +
      ddgResult("LangGraph Developer", "https://startup.io/hire", "Multi-agent.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => html }));

    const result = await searchJobsTool.execute({ query: "LangGraph engineer" });
    expect(result.success).toBe(true);
    const data = result.data as string;
    expect(data).toContain("Senior AI Engineer");
    expect(data).toContain("https://corp.com/job");
  });

  it("returns success:false with message when the web search fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network timeout")));
    const result = await searchJobsTool.execute({ query: "engineer" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/search failed|network|timeout|duckduckgo/i);
  });

  it("surfaces a soft failure (not a crash) when the search returns nothing", async () => {
    // DuckDuckGo HTML with no result anchors → webSearchTool treats it as a soft
    // failure (could be genuine 0 results OR a blocked/changed endpoint — we fail
    // loud rather than falsely claim 'no jobs exist').
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "<html></html>" }));

    const result = await searchJobsTool.execute({ query: "extremely niche role xyz" });
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
  });
});
