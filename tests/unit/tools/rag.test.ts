/**
 * Unit tests for RAG database tools (personal department).
 *
 * Two read-only tools:
 *   searchPersonalRagTool  — queries personal-rag ChromaDB at localhost:8765
 *   searchTuricksBrainTool — queries turicks-brain ChromaDB at localhost:8766
 *
 * Both have 4-second timeouts and soft-fail (return error message, not throw)
 * when the target service is unavailable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock global fetch ─────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { searchPersonalRagTool, searchTuricksBrainTool } = await import(
  "../../../src/tools/rag.js"
);

// ── Shared test helpers ───────────────────────────────────────────────────────

function mockSuccess(results: Array<{ text: string; metadata: Record<string, unknown>; score: number }>, query = "test") {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ query, results, total: results.length }),
  });
}

function mockHttpError(status: number) {
  mockFetch.mockResolvedValueOnce({ ok: false, status });
}

function mockNetworkError() {
  mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
}

function mockTimeout() {
  mockFetch.mockRejectedValueOnce(Object.assign(new Error("Timeout"), { name: "TimeoutError" }));
}

// ── searchPersonalRagTool ─────────────────────────────────────────────────────

describe("searchPersonalRagTool", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("has name 'search_personal_rag'", () => {
    expect(searchPersonalRagTool.name).toBe("search_personal_rag");
  });

  it("description mentions personal knowledge / CV / career", () => {
    const d = searchPersonalRagTool.description.toLowerCase();
    expect(d).toMatch(/personal|cv|career|resume/);
  });

  it("input_schema has required 'query' field", () => {
    expect(searchPersonalRagTool.input_schema.required).toContain("query");
    expect(searchPersonalRagTool.input_schema.properties["query"]).toBeDefined();
  });

  it("returns formatted results on success", async () => {
    mockSuccess(
      [
        { text: "Pushkar has 3+ years of TypeScript.", metadata: { source_file: "resume.md" }, score: 0.91 },
        { text: "Built LangGraph pipelines at Turicks.", metadata: { source_file: "work.md" }, score: 0.85 },
      ],
      "TypeScript experience",
    );

    const result = await searchPersonalRagTool.execute({ query: "TypeScript experience" });

    expect(result.success).toBe(true);
    expect(result.data).toContain("TypeScript experience");
    expect(result.data).toContain("Pushkar has 3+ years of TypeScript.");
    expect(result.data).toContain("resume.md");
    expect(result.data).toContain("0.91");
  });

  it("posts to PERSONAL_RAG_URL /search with correct body", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "salary history", top_k: 3 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/search");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body["query"]).toBe("salary history");
    expect(body["top_k"]).toBe(3);
  });

  it("includes doc_type in body when provided", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "certifications", doc_type: "certification" });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body["doc_type"]).toBe("certification");
  });

  it("omits doc_type from body when not provided", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "skills" });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body["doc_type"]).toBeUndefined();
  });

  it("defaults top_k to 5 when not provided", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "skills" });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body["top_k"]).toBe(5);
  });

  it("caps top_k at 10", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "skills", top_k: 999 });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body["top_k"]).toBe(10);
  });

  it("returns error message when service returns HTTP 500 (soft-fail)", async () => {
    mockHttpError(500);
    const result = await searchPersonalRagTool.execute({ query: "skills" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/personal-rag/i);
  });

  it("returns error message when service is unreachable (soft-fail)", async () => {
    mockNetworkError();
    const result = await searchPersonalRagTool.execute({ query: "skills" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/personal-rag/i);
  });

  it("returns error message on timeout (soft-fail)", async () => {
    mockTimeout();
    const result = await searchPersonalRagTool.execute({ query: "skills" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/personal-rag/i);
  });

  it("returns failure for empty query", async () => {
    const result = await searchPersonalRagTool.execute({ query: "" });

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 'No results found' message when results array is empty", async () => {
    mockSuccess([], "rare query");
    const result = await searchPersonalRagTool.execute({ query: "rare query" });

    expect(result.success).toBe(true);
    expect(result.data).toContain("No results found");
  });

  it("error message includes start command hint", async () => {
    mockNetworkError();
    const result = await searchPersonalRagTool.execute({ query: "anything" });

    expect(result.error).toContain("8765");
  });
});

// ── searchTuricksBrainTool ────────────────────────────────────────────────────

describe("searchTuricksBrainTool", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("has name 'search_turicks_brain'", () => {
    expect(searchTuricksBrainTool.name).toBe("search_turicks_brain");
  });

  it("description mentions business / strategy / decisions", () => {
    const d = searchTuricksBrainTool.description.toLowerCase();
    expect(d).toMatch(/business|strategy|decision|turicks/);
  });

  it("input_schema has required 'query' field", () => {
    expect(searchTuricksBrainTool.input_schema.required).toContain("query");
    expect(searchTuricksBrainTool.input_schema.properties["query"]).toBeDefined();
  });

  it("returns formatted results on success", async () => {
    mockSuccess(
      [
        { text: "We chose LangGraph for stateful HITL checkpointing.", metadata: { source_path: "ADR-001.md" }, score: 0.88 },
      ],
      "why LangGraph",
    );

    const result = await searchTuricksBrainTool.execute({ query: "why LangGraph" });

    expect(result.success).toBe(true);
    expect(result.data).toContain("why LangGraph");
    expect(result.data).toContain("LangGraph for stateful HITL");
    expect(result.data).toContain("ADR-001.md");
  });

  it("posts to TURICKS_BRAIN_URL /search with correct body", async () => {
    mockSuccess([]);
    await searchTuricksBrainTool.execute({ query: "ICP strategy", top_k: 2 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(":8766");
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body["query"]).toBe("ICP strategy");
    expect(body["top_k"]).toBe(2);
  });

  it("includes doc_type filter when provided", async () => {
    mockSuccess([]);
    await searchTuricksBrainTool.execute({ query: "architecture decision", doc_type: "decision" });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body["doc_type"]).toBe("decision");
  });

  it("returns error message when service is unreachable (soft-fail)", async () => {
    mockNetworkError();
    const result = await searchTuricksBrainTool.execute({ query: "Naggar pricing" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/turicks-brain/i);
  });

  it("error message includes port 8766 and start command hint", async () => {
    mockHttpError(503);
    const result = await searchTuricksBrainTool.execute({ query: "anything" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("8766");
  });

  it("returns failure for empty query", async () => {
    const result = await searchTuricksBrainTool.execute({ query: "   " });

    expect(result.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 'No results found' message when results array is empty", async () => {
    mockSuccess([], "obscure topic");
    const result = await searchTuricksBrainTool.execute({ query: "obscure topic" });

    expect(result.success).toBe(true);
    expect(result.data).toContain("No results found");
  });
});
