/**
 * Unit tests for searchKnowledge tool (Turicks Brain — vector RAG)
 * =================================================================
 * As of 2026-06-12 this tool no longer queries the Postgres `knowledge_entries`
 * table. It performs semantic search over the Turicks Brain vector store via the
 * shared `callRagApi` helper (turicks-brain-rag API on :8766). These tests pin
 * the new contract:
 *
 *  1. Empty/whitespace query → "query is required." (no API call)
 *  2. callRagApi is called with (TURICKS_BRAIN_URL, query, 5, doc_type|undefined)
 *  3. doc_type omitted → topK 5, no doc filter
 *  4. API unreachable (null) → honest degraded message with the manual start cmd
 *  5. Empty results → "No knowledge found" message (includes doc_type when given)
 *  6. Results → "Turicks Brain results …" header + formatted source/score/preview
 *  7. Multiple results → all present, numbered, source_path used as the label
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted, declared before dynamic import) ───────────────────────────

const mockCallRagApi = vi.fn();

vi.mock("../../../src/tools/rag.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual, // keep the real formatResults + TURICKS_BRAIN_URL
    callRagApi: mockCallRagApi,
  };
});

vi.mock("../../../src/infra/logger.js", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { searchKnowledge } = await import("../../../src/tools/knowledge.js");
const { TURICKS_BRAIN_URL } = await import("../../../src/tools/rag.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<{
  text: string;
  source_path: string;
  score: number;
}> = {}) {
  return {
    text: overrides.text ?? "We chose Composio because it handles OAuth flows for Gmail, LinkedIn, and GitHub.",
    metadata: { source_path: overrides.source_path ?? "docs/decisions/002-composio.md" },
    score: overrides.score ?? 0.82,
  };
}

function ragResponse(results: ReturnType<typeof makeResult>[]) {
  return { query: "q", results, total: results.length };
}

// ── Input guard ───────────────────────────────────────────────────────────────

describe("searchKnowledge — input guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 'query is required.' for an empty query without calling the API", async () => {
    const result = await searchKnowledge.invoke({ query: "" });
    expect(result).toBe("query is required.");
    expect(mockCallRagApi).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only query as empty", async () => {
    const result = await searchKnowledge.invoke({ query: "   " });
    expect(result).toBe("query is required.");
    expect(mockCallRagApi).not.toHaveBeenCalled();
  });
});

// ── API call contract ───────────────────────────────────────────────────────

describe("searchKnowledge — calls the vector store correctly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallRagApi.mockResolvedValue(ragResponse([]));
  });

  it("calls callRagApi with the brain URL, query, topK 5 and no doc filter", async () => {
    await searchKnowledge.invoke({ query: "composio" });
    expect(mockCallRagApi).toHaveBeenCalledWith(TURICKS_BRAIN_URL, "composio", 5, undefined);
  });

  it("forwards doc_type as the fourth argument when provided", async () => {
    await searchKnowledge.invoke({ query: "brand voice", doc_type: "decision" });
    expect(mockCallRagApi).toHaveBeenCalledWith(TURICKS_BRAIN_URL, "brand voice", 5, "decision");
  });

  it("trims the query before searching", async () => {
    await searchKnowledge.invoke({ query: "  LinkedIn positioning  " });
    expect(mockCallRagApi).toHaveBeenCalledWith(TURICKS_BRAIN_URL, "LinkedIn positioning", 5, undefined);
  });
});

// ── Degraded / unreachable ──────────────────────────────────────────────────

describe("searchKnowledge — API unreachable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallRagApi.mockResolvedValue(null);
  });

  it("returns an honest degraded message naming the query", async () => {
    const result = await searchKnowledge.invoke({ query: "uncertainty principle" });
    expect(result).toContain("not reachable");
    expect(result).toContain("uncertainty principle");
  });

  it("includes the manual start command so the founder can recover", async () => {
    const result = await searchKnowledge.invoke({ query: "test" });
    expect(result).toContain("uvicorn src.api:app");
  });
});

// ── Empty results ─────────────────────────────────────────────────────────────

describe("searchKnowledge — empty results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallRagApi.mockResolvedValue(ragResponse([]));
  });

  it("returns a 'No knowledge found' message with the query", async () => {
    const result = await searchKnowledge.invoke({ query: "unknown topic" });
    expect(result).toContain("No knowledge found");
    expect(result).toContain("unknown topic");
  });

  it("includes the doc_type filter in the empty message when type was specified", async () => {
    const result = await searchKnowledge.invoke({ query: "fintech", doc_type: "decision" });
    expect(result).toContain("decision");
  });
});

// ── Result formatting ─────────────────────────────────────────────────────────

describe("searchKnowledge — result formatting", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefixes results with the 'Turicks Brain results' header and total count", async () => {
    mockCallRagApi.mockResolvedValueOnce(ragResponse([makeResult()]));
    const result = await searchKnowledge.invoke({ query: "composio" });
    expect(result).toContain('Turicks Brain results for "composio" (1)');
  });

  it("labels each result with its source_path and score", async () => {
    mockCallRagApi.mockResolvedValueOnce(
      ragResponse([makeResult({ source_path: "docs/decisions/009-linkedin.md", score: 0.91 })]),
    );
    const result = await searchKnowledge.invoke({ query: "linkedin" });
    expect(result).toContain("docs/decisions/009-linkedin.md");
    expect(result).toContain("0.91");
  });

  it("includes the chunk text in the output", async () => {
    mockCallRagApi.mockResolvedValueOnce(
      ragResponse([makeResult({ text: "Hook on line 1, 150–300 words." })]),
    );
    const result = await searchKnowledge.invoke({ query: "brand" });
    expect(result).toContain("Hook on line 1, 150–300 words.");
  });

  it("numbers multiple results sequentially", async () => {
    mockCallRagApi.mockResolvedValueOnce(
      ragResponse([
        makeResult({ text: "First chunk" }),
        makeResult({ text: "Second chunk" }),
      ]),
    );
    const result = await searchKnowledge.invoke({ query: "test" });
    expect(result).toContain("1. ");
    expect(result).toContain("2. ");
    expect(result).toContain("First chunk");
    expect(result).toContain("Second chunk");
  });

  // Regression (2026-06-12): a single top_k-5 search of large vector chunks blew
  // the per-run token budget (52,991 ≥ 50,000) because formatResults emitted the
  // FULL chunk text. Each preview must now be bounded so the output stays small.
  it("truncates long chunk text and appends an ellipsis", async () => {
    const longText = "x".repeat(5_000);
    mockCallRagApi.mockResolvedValueOnce(ragResponse([makeResult({ text: longText })]));
    const result = await searchKnowledge.invoke({ query: "big" });
    expect(result).not.toContain(longText); // full text never emitted
    expect(result).toContain("…");
    // 5 chunks of this size used to be ~50k tokens; bounded output must stay tiny.
    expect(result.length).toBeLessThan(1_500);
  });
});
