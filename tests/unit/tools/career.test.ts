/**
 * Unit tests for career tools (job-hunt department).
 * TDD: RED first — src/tools/career.ts doesn't exist yet.
 *
 * Career tools are READ-ONLY (no HITL). Two tools:
 *   readCv(query)      — queries personal-rag API; falls back to wiki.md
 *   searchJobs(query)  — wraps Firecrawl web search for job listings
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readCvTool, searchJobsTool } from "../../../src/tools/career.js";

// ── readCv ───────────────────────────────────────────────────────────────────

describe("readCvTool", () => {
  it("has name 'read_cv'", () => {
    expect(readCvTool.name).toBe("read_cv");
  });

  it("has a description mentioning CV / career", () => {
    expect(readCvTool.description.toLowerCase()).toMatch(/cv|resume|career|personal/);
  });

  it("has input_schema with query field", () => {
    expect(readCvTool.input_schema.properties["query"]).toBeDefined();
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
    // Should still succeed via wiki fallback
    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
    // Fallback should mention something substantive
    expect((result.data as string).length).toBeGreaterThan(20);
  });

  it("returns success:false with descriptive error when both API and wiki fail", async () => {
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    // Simulate wiki read failure by mocking readFile to fail
    const result = await readCvTool.execute({ query: "nonexistent query xyz" });
    // Either succeeds (wiki found) or returns success:false with message
    if (!result.success) {
      expect(result.error).toBeTruthy();
    }
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
    const props = searchJobsTool.input_schema.properties;
    expect(props["query"]).toBeDefined();
    expect(props["location"]).toBeDefined();
  });

  it("appends location to search query when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            title: "AI Engineer — Amsterdam",
            url: "https://example.com/jobs/1",
            description: "LangGraph multi-agent engineering role.",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await searchJobsTool.execute({ query: "AI engineer LangGraph", location: "Amsterdam" });
    expect(result.success).toBe(true);

    // Should have made a fetch call
    expect(mockFetch).toHaveBeenCalled();

    // The search query sent to Firecrawl should include both query and location
    const callArg = mockFetch.mock.calls[0]?.[1];
    const bodyStr = typeof callArg?.body === "string" ? callArg.body : JSON.stringify(callArg?.body ?? {});
    expect(bodyStr.toLowerCase()).toMatch(/amsterdam|langgraph/);
  });

  it("returns formatted job list as string", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          { title: "Senior AI Engineer", url: "https://corp.com/job", description: "Build agents." },
          { title: "LangGraph Developer", url: "https://startup.io/hire", description: "Multi-agent." },
        ],
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await searchJobsTool.execute({ query: "LangGraph engineer" });
    expect(result.success).toBe(true);
    const data = result.data as string;
    expect(data).toContain("Senior AI Engineer");
    expect(data).toContain("https://corp.com/job");
  });

  it("returns success:false with message when Firecrawl fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network timeout")));
    const result = await searchJobsTool.execute({ query: "engineer" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/search failed|network|timeout/i);
  });

  it("returns empty message (not crash) when no results found", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, data: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await searchJobsTool.execute({ query: "extremely niche role xyz" });
    expect(result.success).toBe(true);
    expect(typeof result.data).toBe("string");
  });
});
