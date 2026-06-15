/**
 * Unit tests for RAG tools (personal-rag + turicks-brain).
 *
 * Both tools embed the query via local Ollama then run pgvector similarity
 * search — no HTTP calls to external ChromaDB services.
 *
 * Coverage:
 *   - tool contract (name, description, input_schema)
 *   - happy-path formatting (content, metadata, score)
 *   - correct table routing (personal_rag / turicks_brain)
 *   - top_k default (5) and cap (10)
 *   - soft-fail when Ollama is unreachable
 *   - empty / whitespace query guard
 *   - no-results message
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RagHit } from "../../../src/db/rag-search.js";

// ── Mock dependencies (hoisted before dynamic imports) ────────────────────────

vi.mock("../../../src/lib/embed.js", () => ({
  embedText: vi.fn(),
}));

vi.mock("../../../src/db/rag-search.js", () => ({
  searchRagTable: vi.fn(),
  ALLOWED_RAG_TABLES: new Set(["personal_rag", "turicks_brain"]),
  assertAllowedRagTable: vi.fn(),
}));

// Dynamic imports AFTER mocks are hoisted
const { embedText } = await import("../../../src/lib/embed.js");
const { searchRagTable } = await import("../../../src/db/rag-search.js");
const { searchPersonalRagTool, searchTuricksBrainTool } = await import(
  "../../../src/tools/rag.js"
);

const mockEmbedText = vi.mocked(embedText);
const mockSearchRagTable = vi.mocked(searchRagTable);

const DUMMY_VEC = new Array<number>(768).fill(0.1);

function mockSuccess(hits: RagHit[]) {
  mockEmbedText.mockResolvedValueOnce(DUMMY_VEC);
  mockSearchRagTable.mockResolvedValueOnce(hits);
}

function mockEmbedFail() {
  mockEmbedText.mockRejectedValueOnce(
    new Error(
      "Ollama embeddings unreachable at http://localhost:11434. Is the ollama container up and is 'nomic-embed-text' pulled?",
    ),
  );
}

/** Embed succeeds but the pgvector query throws (e.g. missing table / DB down). */
function mockQueryFail(message: string) {
  mockEmbedText.mockResolvedValueOnce(DUMMY_VEC);
  mockSearchRagTable.mockRejectedValueOnce(new Error(message));
}

// ── searchPersonalRagTool ─────────────────────────────────────────────────────

describe("searchPersonalRagTool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has name 'search_personal_rag'", () => {
    expect(searchPersonalRagTool.name).toBe("search_personal_rag");
  });

  it("description mentions personal knowledge / CV / career", () => {
    const d = searchPersonalRagTool.description.toLowerCase();
    expect(d).toMatch(/personal|cv|career|resume/);
  });

  it("input_schema has required 'query' field", () => {
    expect(searchPersonalRagTool.input_schema!.required).toContain("query");
    expect(searchPersonalRagTool.input_schema!.properties["query"]).toBeDefined();
  });

  it("returns formatted results on success", async () => {
    mockSuccess([
      {
        content: "Pushkar has 3+ years of TypeScript.",
        metadata: { source_file: "resume.md" },
        score: 0.91,
      },
      {
        content: "Built LangGraph pipelines at Turicks.",
        metadata: { source_file: "work.md" },
        score: 0.85,
      },
    ]);

    const result = await searchPersonalRagTool.execute({
      query: "TypeScript experience",
    });

    expect(result.success).toBe(true);
    expect(result.data).toContain("TypeScript experience");
    expect(result.data).toContain("Pushkar has 3+ years of TypeScript.");
    expect(result.data).toContain("resume.md");
    expect(result.data).toContain("0.91");
  });

  it("calls searchRagTable with 'personal_rag' table", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "salary history" });

    expect(mockSearchRagTable).toHaveBeenCalledOnce();
    expect(mockSearchRagTable.mock.calls[0]![0]).toBe("personal_rag");
  });

  it("calls embedText with the exact query string", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "certifications" });

    expect(mockEmbedText).toHaveBeenCalledWith("certifications");
  });

  it("defaults top_k to 5 when not provided", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "skills" });

    expect(mockSearchRagTable).toHaveBeenCalledWith("personal_rag", DUMMY_VEC, 5);
  });

  it("caps top_k at 10", async () => {
    mockSuccess([]);
    await searchPersonalRagTool.execute({ query: "skills", top_k: 999 });

    expect(mockSearchRagTable).toHaveBeenCalledWith("personal_rag", DUMMY_VEC, 10);
  });

  it("returns error message when Ollama is unreachable (soft-fail)", async () => {
    mockEmbedFail();
    const result = await searchPersonalRagTool.execute({ query: "skills" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/personal-rag/i);
  });

  it("returns failure for empty query without calling embedText", async () => {
    const result = await searchPersonalRagTool.execute({ query: "" });

    expect(result.success).toBe(false);
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it("returns 'No results found' message when results array is empty", async () => {
    mockSuccess([]);
    const result = await searchPersonalRagTool.execute({ query: "rare query" });

    expect(result.success).toBe(true);
    expect(result.data).toContain("No results found");
  });
});

// ── searchTuricksBrainTool ────────────────────────────────────────────────────

describe("searchTuricksBrainTool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("has name 'search_turicks_brain'", () => {
    expect(searchTuricksBrainTool.name).toBe("search_turicks_brain");
  });

  it("description mentions business / strategy / decisions", () => {
    const d = searchTuricksBrainTool.description.toLowerCase();
    expect(d).toMatch(/business|strategy|decision|turicks/);
  });

  it("input_schema has required 'query' field", () => {
    expect(searchTuricksBrainTool.input_schema!.required).toContain("query");
    expect(searchTuricksBrainTool.input_schema!.properties["query"]).toBeDefined();
  });

  it("returns formatted results on success", async () => {
    mockSuccess([
      {
        content: "We chose LangGraph for stateful HITL checkpointing.",
        metadata: { source_path: "ADR-001.md" },
        score: 0.88,
      },
    ]);

    const result = await searchTuricksBrainTool.execute({ query: "why LangGraph" });

    expect(result.success).toBe(true);
    expect(result.data).toContain("why LangGraph");
    expect(result.data).toContain("LangGraph for stateful HITL");
    expect(result.data).toContain("ADR-001.md");
  });

  it("calls searchRagTable with 'turicks_brain' table and correct top_k", async () => {
    mockSuccess([]);
    await searchTuricksBrainTool.execute({ query: "ICP strategy", top_k: 2 });

    expect(mockSearchRagTable).toHaveBeenCalledOnce();
    expect(mockSearchRagTable.mock.calls[0]![0]).toBe("turicks_brain");
    expect(mockSearchRagTable.mock.calls[0]![2]).toBe(2);
  });

  it("calls embedText with the query", async () => {
    mockSuccess([]);
    await searchTuricksBrainTool.execute({ query: "Naggar pricing" });

    expect(mockEmbedText).toHaveBeenCalledWith("Naggar pricing");
  });

  it("returns error message when Ollama is unreachable (soft-fail)", async () => {
    mockEmbedFail();
    const result = await searchTuricksBrainTool.execute({ query: "Naggar pricing" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/turicks-brain/i);
  });

  it("returns failure for whitespace-only query without calling embedText", async () => {
    const result = await searchTuricksBrainTool.execute({ query: "   " });

    expect(result.success).toBe(false);
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it("returns 'No results found' message when results array is empty", async () => {
    mockSuccess([]);
    const result = await searchTuricksBrainTool.execute({ query: "obscure topic" });

    expect(result.success).toBe(true);
    expect(result.data).toContain("No results found");
  });

  // ── Regression: the production bug (CLAUDE.md rule #22) ──────────────────────
  // A DB/pgvector failure (missing table, empty store, DB down) was mislabeled
  // as "Ollama unavailable", sending every debugger down the wrong path.
  // A query-stage failure must blame the vector store, NOT Ollama, and point at
  // the real fix (pgvector + brain:sync).
  it("blames the vector store (NOT Ollama) when the pgvector query fails", async () => {
    mockQueryFail('relation "turicks_brain" does not exist');
    const result = await searchTuricksBrainTool.execute({ query: "ICP" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pgvector|vector store/i);
    expect(result.error).toMatch(/brain:sync/i);
    // Must NOT misattribute a DB error to Ollama.
    expect(result.error).not.toMatch(/ollama is unavailable/i);
  });

  it("embed-stage failure DOES name Ollama (correct attribution)", async () => {
    mockEmbedFail();
    const result = await searchTuricksBrainTool.execute({ query: "ICP" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ollama/i);
  });
});
