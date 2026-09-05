/**
 * Unit tests for searchKnowledge (turicks-brain, hybrid engine)
 * =================================================================
 * search_knowledge now delegates to the SAME hybrid (vector ⊕ keyword, RRF)
 * engine as search_turicks_brain (src/db/rag-query.ts) — mocked at the same
 * layer as tests/unit/tools/rag.test.ts (embedTextCached + searchRagTable +
 * keywordSearchRagTable), so these tests exercise the real runRagSearch
 * composition, not a stub of it.
 *
 * Coverage:
 *  1. Delegates to the turicks_brain table via the hybrid engine
 *  2. entry_type, when given, is passed as a filter to both search legs
 *  3. No entry_type → no filter passed
 *  4. Forgiving fallback: a filtered search that returns zero hits retries
 *     unfiltered before reporting nothing found (prod 2026-06-15 guard)
 *  5. A filtered search that DOES find hits never falls back
 *  6. Empty results (filtered AND unfiltered) → the exact legacy message,
 *     including the type in the message and the "do NOT fabricate" instruction
 *  7. Success formatting via the shared renderRagSuccess (citation + score)
 *  8. Error attribution: embed-stage names Ollama, query-stage names the vector
 *     store — unchanged from the shared engine's existing guarantee
 *  9. Tool contract (name, description, schema) unchanged — MCP contract
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RagHit } from "../../../src/db/rag-search.js";

// ── Mocks (hoisted, declared before dynamic import) ───────────────────────────

vi.mock("../../../src/lib/embed.js", () => ({
  embedTextCached: vi.fn(),
}));

vi.mock("../../../src/db/rag-search.js", () => ({
  searchRagTable: vi.fn(),
  keywordSearchRagTable: vi.fn(),
  ALLOWED_RAG_TABLES: new Set(["personal_rag", "turicks_brain", "research_cache"]),
  assertAllowedRagTable: vi.fn(),
}));

vi.mock("../../../src/infra/logger.js", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { embedTextCached } = await import("../../../src/lib/embed.js");
const { searchRagTable, keywordSearchRagTable } = await import("../../../src/db/rag-search.js");
const { searchKnowledge } = await import("../../../src/tools/knowledge.js");

const mockEmbed = vi.mocked(embedTextCached);
const mockVector = vi.mocked(searchRagTable);
const mockKeyword = vi.mocked(keywordSearchRagTable);

const DUMMY_VEC = new Array<number>(768).fill(0.1);

function makeHit(overrides: Partial<RagHit> = {}): RagHit {
  return {
    content: overrides.content ?? "We chose Composio because it handles OAuth flows for Gmail, LinkedIn, and GitHub.",
    metadata: overrides.metadata ?? { source_path: "docs/adr/ADR-002-composio.md", entry_type: "adr" },
    score: overrides.score ?? 0.9,
  };
}

/** Vector returns `hits`; keyword defaults to no matches → fused = vector order. */
function mockSuccess(hits: RagHit[]) {
  mockEmbed.mockResolvedValueOnce(DUMMY_VEC);
  mockVector.mockResolvedValueOnce(hits);
  mockKeyword.mockResolvedValueOnce([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKeyword.mockResolvedValue([]); // default: keyword finds nothing unless overridden
});

// ── Delegation + filter shape ──────────────────────────────────────────────────

describe("searchKnowledge — delegates to the hybrid engine", () => {
  it("queries the brain_memories table — the one brain:sync writes", async () => {
    // Was pinned to turicks_brain, and stayed green while ADR-038 moved the
    // writer to brain_memories and left this reader behind. A table name pinned
    // on the reader alone cannot catch that; tests/unit/db/brain-store-parity
    // asserts the two agree.
    mockSuccess([makeHit()]);
    await searchKnowledge.invoke({ query: "composio" });

    expect(mockVector).toHaveBeenCalledOnce();
    expect(mockVector.mock.calls[0]![0]).toBe("brain_memories");
  });

  it("embeds the exact query via the Redis-cached embedder", async () => {
    mockSuccess([makeHit()]);
    await searchKnowledge.invoke({ query: "composio" });

    expect(mockEmbed).toHaveBeenCalledWith("composio");
  });

  it("passes entry_type as a filter to both the vector and keyword legs", async () => {
    mockSuccess([makeHit({ metadata: { source_path: "x.md", entry_type: "adr" } })]);
    await searchKnowledge.invoke({ query: "composio", entry_type: "adr" });

    expect(mockVector.mock.calls[0]![3]).toEqual({ filter: { entry_type: "adr" } });
    expect(mockKeyword.mock.calls[0]![3]).toEqual({ filter: { entry_type: "adr" } });
  });

  it("passes no filter when entry_type is omitted", async () => {
    mockSuccess([makeHit()]);
    await searchKnowledge.invoke({ query: "composio" });

    expect(mockVector.mock.calls[0]![3]).toBeUndefined();
  });
});

// ── Forgiving post-filter (prod 2026-06-15 guard) ───────────────────────────────

describe("searchKnowledge — entry_type is a forgiving post-filter", () => {
  it("retries unfiltered when the filtered search returns zero hits, and returns those hits", async () => {
    // First call (filtered): embed + vector + keyword all return nothing.
    mockEmbed.mockResolvedValueOnce(DUMMY_VEC);
    mockVector.mockResolvedValueOnce([]);
    mockKeyword.mockResolvedValueOnce([]);
    // Retry (unfiltered): real content shows up.
    mockEmbed.mockResolvedValueOnce(DUMMY_VEC);
    mockVector.mockResolvedValueOnce([
      makeHit({ content: "Turicks ICP is seed-Series A AI/dev-tool startups.", metadata: { source_path: "strategy.md", entry_type: "strategy" } }),
    ]);
    mockKeyword.mockResolvedValueOnce([]);

    const result = await searchKnowledge.invoke({ query: "ICP", entry_type: "strategic_pillar" });

    expect(mockVector).toHaveBeenCalledTimes(2);
    // Retry call carries no filter.
    expect(mockVector.mock.calls[1]![3]).toBeUndefined();
    expect(result).toContain("Turicks ICP is seed-Series A");
  });

  it("does NOT retry when the filtered search already found hits", async () => {
    mockSuccess([makeHit({ metadata: { source_path: "brand.md", entry_type: "brand" } })]);
    await searchKnowledge.invoke({ query: "voice", entry_type: "brand" });

    expect(mockVector).toHaveBeenCalledOnce();
  });

  it("does NOT retry when no entry_type was given (nothing to be forgiving about)", async () => {
    mockEmbed.mockResolvedValueOnce(DUMMY_VEC);
    mockVector.mockResolvedValueOnce([]);
    mockKeyword.mockResolvedValueOnce([]);

    await searchKnowledge.invoke({ query: "nonexistent topic" });

    expect(mockVector).toHaveBeenCalledOnce();
  });
});

// ── Empty results ─────────────────────────────────────────────────────────────

describe("searchKnowledge — empty results", () => {
  beforeEach(() => {
    mockEmbed.mockResolvedValue(DUMMY_VEC);
    mockVector.mockResolvedValue([]);
    mockKeyword.mockResolvedValue([]);
  });

  it("returns the 'No knowledge entries found' message with the query", async () => {
    const result = await searchKnowledge.invoke({ query: "unknown topic" });

    expect(result).toContain("No knowledge entries found");
    expect(result).toContain("unknown topic");
  });

  it("tells the model not to fabricate and points to search_web", async () => {
    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).toContain("Do NOT fabricate");
    expect(result).toContain("search_web");
  });

  it("includes the entry_type in the empty message after the fallback also misses", async () => {
    const result = await searchKnowledge.invoke({ query: "fintech", entry_type: "case_study" });

    expect(result).toContain("case_study");
    expect(mockVector).toHaveBeenCalledTimes(2); // filtered, then the forgiving retry
  });
});

// ── Success formatting (shared renderRagSuccess) ────────────────────────────────

describe("searchKnowledge — result formatting", () => {
  it("includes the query, the source path citation, and the score", async () => {
    mockSuccess([makeHit({ content: "ADR-009: LinkedIn ban risk mitigation.", metadata: { source_path: "docs/adr/ADR-009.md" }, score: 0.87 })]);

    const result = await searchKnowledge.invoke({ query: "linkedin" });

    expect(result).toContain("linkedin");
    expect(result).toContain("docs/adr/ADR-009.md");
    expect(result).toContain("ADR-009: LinkedIn ban risk mitigation.");
    expect(result).toContain("0.87");
  });

  it("numbers multiple results sequentially", async () => {
    mockSuccess([
      makeHit({ content: "First entry.", metadata: { source_path: "a.md" } }),
      makeHit({ content: "Second entry.", metadata: { source_path: "b.md" } }),
    ]);

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).toContain("1. [a.md]");
    expect(result).toContain("2. [b.md]");
  });
});

// ── Error attribution (shared with the other RAG tools) ─────────────────────────

describe("searchKnowledge — error attribution", () => {
  it("names Ollama when the embedder is down and keyword also fails", async () => {
    mockEmbed.mockRejectedValueOnce(new Error("Ollama unreachable"));
    mockKeyword.mockRejectedValueOnce(new Error("Ollama unreachable"));

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).toMatch(/turicks-brain/i);
    expect(result).toMatch(/ollama/i);
  });

  it("blames the vector store (NOT Ollama) when the pgvector query fails", async () => {
    mockEmbed.mockResolvedValueOnce(DUMMY_VEC);
    mockVector.mockRejectedValueOnce(new Error('relation "turicks_brain" does not exist'));
    mockKeyword.mockRejectedValueOnce(new Error('relation "turicks_brain" does not exist'));

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).toMatch(/pgvector|vector store/i);
    expect(result).not.toMatch(/ollama is unavailable/i);
  });
});

// ── Tool contract (MCP surface — must not change) ───────────────────────────────

describe("searchKnowledge — tool contract", () => {
  it("keeps the name 'search_knowledge'", () => {
    expect(searchKnowledge.name).toBe("search_knowledge");
  });

  it("keeps the entry_type enum", () => {
    const schema = searchKnowledge.schema as { shape: { entry_type: { unwrap: () => { unwrap: () => { options: string[] } } } } };
    const options = schema.shape.entry_type.unwrap().unwrap().options;
    expect(options).toEqual([
      "adr",
      "brand",
      "case_study",
      "strategy",
      "strategic_pillar",
      "phase",
      "founder_profile",
      "session",
    ]);
  });
});
