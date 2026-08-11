/**
 * Unit tests for searchKnowledge tool (turicks-brain ILIKE search)
 * =================================================================
 * This tool is the memory layer for research/sales/marketing agents.
 * Two search paths:
 *   - With entry_type → getKnowledgeByType (filtered by content category)
 *   - Without entry_type → searchKnowledgeEntries (full-text keyword search)
 *
 * Edge cases covered:
 *  1. entry_type provided → calls getKnowledgeByType, NOT searchKnowledgeEntries
 *  2. No entry_type → calls searchKnowledgeEntries, NOT getKnowledgeByType
 *  3. Empty results → returns the "No knowledge entries found" message with brain:sync hint
 *  4. Empty results with entry_type → message includes the type filter
 *  5. Results are formatted as numbered list with title, tags, and preview
 *  6. Content >400 chars → truncated at 400 with "…" appended
 *  7. Content ≤400 chars → not truncated, no "…"
 *  8. Tags present → shown as "Tags: tag1, tag2"
 *  9. Empty/missing tags → tags line omitted
 * 10. Multiple results → all present, numbered sequentially
 * 11. Throws propagated → error surfaces to caller (tool catches at langchain level)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted, declared before dynamic import) ───────────────────────────

const mockSearchKnowledgeEntries = vi.fn();
const mockGetKnowledgeByType = vi.fn();

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    searchKnowledgeEntries: mockSearchKnowledgeEntries,
    getKnowledgeByType: mockGetKnowledgeByType,
  };
});

vi.mock("../../../src/infra/logger.js", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { searchKnowledge } = await import("../../../src/tools/knowledge.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<{
  title: string;
  content: string;
  tags: string[];
  entry_type: string;
}> = {}) {
  return {
    title: overrides.title ?? "ADR-002: Use Composio for tool integrations",
    content: overrides.content ?? "We chose Composio because it handles OAuth flows for Gmail, LinkedIn, and GitHub.",
    tags: overrides.tags ?? ["adr", "composio", "tooling"],
    entry_type: overrides.entry_type ?? "adr",
  };
}

// ── Routing tests ─────────────────────────────────────────────────────────────

describe("searchKnowledge — routing by entry_type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keyword-searches even when entry_type is provided — never drops the query", async () => {
    // Regression for prod 2026-06-15: entry_type used to call getKnowledgeByType
    // and ignore the query, so a zero-row type guess returned empty → hallucination.
    mockSearchKnowledgeEntries.mockResolvedValueOnce([makeEntry({ entry_type: "adr" })]);
    await searchKnowledge.invoke({ query: "composio", entry_type: "adr" });

    expect(mockSearchKnowledgeEntries).toHaveBeenCalledWith("turicks", "composio", 15);
    expect(mockGetKnowledgeByType).not.toHaveBeenCalled();
  });

  it("calls searchKnowledgeEntries when no entry_type — NOT getKnowledgeByType", async () => {
    mockSearchKnowledgeEntries.mockResolvedValueOnce([makeEntry()]);
    await searchKnowledge.invoke({ query: "composio" });

    expect(mockSearchKnowledgeEntries).toHaveBeenCalledOnce();
    expect(mockGetKnowledgeByType).not.toHaveBeenCalled();
  });

  it("filters keyword results by entry_type when both match", async () => {
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ title: "Brand voice", entry_type: "brand" }),
      makeEntry({ title: "An ADR", entry_type: "adr" }),
    ]);
    const result = await searchKnowledge.invoke({ query: "voice", entry_type: "brand" });

    expect(result).toContain("Brand voice");
    expect(result).not.toContain("An ADR");
  });

  it("falls back to unfiltered keyword hits when the type filter wipes everything", async () => {
    // Type label drifted (synced as "strategy", model guessed "strategic_pillar").
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ title: "Turicks ICP", entry_type: "strategy" }),
    ]);
    const result = await searchKnowledge.invoke({ query: "ICP", entry_type: "strategic_pillar" });

    expect(result).toContain("Turicks ICP");
  });

  it("lists by type when the query has no usable keywords", async () => {
    mockGetKnowledgeByType.mockResolvedValueOnce([makeEntry({ entry_type: "brand" })]);
    await searchKnowledge.invoke({ query: "  ", entry_type: "brand" });

    expect(mockGetKnowledgeByType).toHaveBeenCalledWith("turicks", "brand", 5);
    expect(mockSearchKnowledgeEntries).not.toHaveBeenCalled();
  });

  it("passes TENANT and query to searchKnowledgeEntries", async () => {
    mockSearchKnowledgeEntries.mockResolvedValueOnce([]);
    await searchKnowledge.invoke({ query: "LinkedIn positioning" });

    expect(mockSearchKnowledgeEntries).toHaveBeenCalledWith("turicks", "LinkedIn positioning", 15);
  });
});

// ── Empty results ─────────────────────────────────────────────────────────────

describe("searchKnowledge — empty results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchKnowledgeEntries.mockResolvedValue([]);
    mockGetKnowledgeByType.mockResolvedValue([]);
  });

  it("returns a 'No knowledge entries found' message with the query", async () => {
    const result = await searchKnowledge.invoke({ query: "unknown topic" });

    expect(result).toContain("No knowledge entries found");
    expect(result).toContain("unknown topic");
  });

  it("tells the model not to fabricate and points to fallback search tools", async () => {
    const result = await searchKnowledge.invoke({ query: "test" });
    expect(result).toContain("Do NOT fabricate");
    expect(result).toContain("search_web");
    expect(result).not.toContain("search_turicks_brain");
  });

  it("includes the entry_type filter in the empty message when type was specified", async () => {
    const result = await searchKnowledge.invoke({ query: "fintech", entry_type: "case_study" });
    expect(result).toContain("case_study");
  });
});

// ── Result formatting ─────────────────────────────────────────────────────────

describe("searchKnowledge — result formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("numbers results starting from 1", async () => {
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ title: "First" }),
      makeEntry({ title: "Second" }),
    ]);

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).toContain("1.");
    expect(result).toContain("2.");
  });

  it("includes the entry title in each result", async () => {
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ title: "ADR-009: LinkedIn ban risk mitigation" }),
    ]);

    const result = await searchKnowledge.invoke({ query: "linkedin" });

    expect(result).toContain("ADR-009: LinkedIn ban risk mitigation");
  });

  it("shows tags in 'Tags: tag1, tag2' format when tags are present", async () => {
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ tags: ["composio", "email", "gmail"] }),
    ]);

    const result = await searchKnowledge.invoke({ query: "email" });

    expect(result).toContain("Tags: composio, email, gmail");
  });

  it("omits the Tags line when tags array is empty", async () => {
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ tags: [] }),
    ]);

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).not.toContain("Tags:");
  });

  it("truncates content preview at 400 chars and appends '…'", async () => {
    const longContent = "a".repeat(450); // 450 chars — over the 400-char limit
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ content: longContent }),
    ]);

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).toContain("…");
    // The preview in the output should contain 400 'a's then '…'
    expect(result).toContain("a".repeat(400) + "…");
  });

  it("does not append '…' when content is exactly 400 chars", async () => {
    const exactContent = "b".repeat(400);
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ content: exactContent }),
    ]);

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).not.toContain("…");
  });

  it("does not append '…' when content is under 400 chars", async () => {
    const shortContent = "Short content under the limit.";
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ content: shortContent }),
    ]);

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).toContain("Short content under the limit.");
    expect(result).not.toContain("…");
  });

  it("collapses multiple newlines in content preview to a single space", async () => {
    const contentWithNewlines = "Line 1\n\nLine 2\n\nLine 3";
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ content: contentWithNewlines }),
    ]);

    const result = await searchKnowledge.invoke({ query: "test" });

    // Newlines collapsed → no raw newlines in the preview portion
    expect(result).toContain("Line 1 Line 2 Line 3");
  });

  it("formats multiple results separated by blank lines", async () => {
    mockSearchKnowledgeEntries.mockResolvedValueOnce([
      makeEntry({ title: "Entry A" }),
      makeEntry({ title: "Entry B" }),
      makeEntry({ title: "Entry C" }),
    ]);

    const result = await searchKnowledge.invoke({ query: "test" });

    expect(result).toContain("Entry A");
    expect(result).toContain("Entry B");
    expect(result).toContain("Entry C");
    // Results joined with double newline
    expect(result).toContain("\n\n");
  });
});
