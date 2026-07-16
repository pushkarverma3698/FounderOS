/**
 * Hybrid RAG orchestration (spec §1.1 F2 + the keyword-fallback half of F1).
 * Runs vector + keyword retrieval in parallel and fuses with RRF, but the
 * load-bearing behaviour is graceful degradation — pinned here with injected
 * fakes so every branch is verified at $0 (no DB, no Ollama):
 *   - both succeed        → fused hybrid results
 *   - keyword fails       → vector-only (keyword is an accelerant; never fatal)
 *   - vector/embed fails  → keyword-only, LABELLED degraded (F1: never zero results)
 *   - both fail           → typed error naming the real stage (embed vs query)
 *
 * TDD: RED until src/db/rag-hybrid.ts exists.
 */
import { describe, it, expect } from "vitest";
import { hybridRagSearch, RagStageError, type HybridDeps } from "../../../src/db/rag-hybrid.js";
import type { RagHit } from "../../../src/db/rag-search.js";

const hit = (content: string, score = 0.5): RagHit => ({ content, metadata: {}, score });

function deps(over: Partial<HybridDeps>): HybridDeps {
  return {
    vectorSearch: async () => [],
    keywordSearch: async () => [],
    ...over,
  };
}

describe("hybridRagSearch", () => {
  it("fuses vector + keyword results when both succeed (mode: hybrid)", async () => {
    const res = await hybridRagSearch("turicks_brain", "langgraph hitl", 5, deps({
      vectorSearch: async () => [hit("A"), hit("B"), hit("C")],
      keywordSearch: async () => [hit("B"), hit("D"), hit("A")],
    }));
    expect("hits" in res).toBe(true);
    if (!("hits" in res)) return;
    expect(res.mode).toBe("hybrid");
    // B and A appear in both lists → they lead (RRF).
    expect(res.hits.slice(0, 2).map((h) => h.content)).toEqual(["B", "A"]);
    expect(res.degradedReason).toBeUndefined();
  });

  it("respects top_k on the fused output", async () => {
    const res = await hybridRagSearch("turicks_brain", "q", 2, deps({
      vectorSearch: async () => [hit("A"), hit("B"), hit("C")],
      keywordSearch: async () => [hit("D"), hit("E")],
    }));
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.hits).toHaveLength(2);
  });

  it("falls back to vector-only when keyword search fails (non-fatal)", async () => {
    const res = await hybridRagSearch("personal_rag", "q", 5, deps({
      vectorSearch: async () => [hit("A"), hit("B")],
      keywordSearch: async () => {
        throw new Error("ILIKE blew up");
      },
    }));
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.mode).toBe("vector");
    expect(res.hits.map((h) => h.content)).toEqual(["A", "B"]);
  });

  it("falls back to LABELLED keyword-only when the embedder is down (F1)", async () => {
    const res = await hybridRagSearch("turicks_brain", "q", 5, deps({
      vectorSearch: async () => {
        throw new RagStageError("embed", "Ollama unreachable at http://localhost:11434");
      },
      keywordSearch: async () => [hit("K1"), hit("K2")],
    }));
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.mode).toBe("keyword-fallback");
    expect(res.hits.map((h) => h.content)).toEqual(["K1", "K2"]);
    expect(res.degradedReason).toMatch(/ollama|embed/i);
  });

  it("returns a typed error naming the embed stage when BOTH fail", async () => {
    const res = await hybridRagSearch("turicks_brain", "q", 5, deps({
      vectorSearch: async () => {
        throw new RagStageError("embed", "Ollama down");
      },
      keywordSearch: async () => {
        throw new Error("DB down");
      },
    }));
    expect("error" in res).toBe(true);
    if (!("error" in res)) return;
    expect(res.error.stage).toBe("embed");
    expect(res.error.message).toMatch(/ollama|down/i);
  });

  it("names the query stage when the vector store (not the embedder) is the failure", async () => {
    const res = await hybridRagSearch("turicks_brain", "q", 5, deps({
      vectorSearch: async () => {
        throw new RagStageError("query", "pgvector missing");
      },
      keywordSearch: async () => {
        throw new Error("DB down");
      },
    }));
    if (!("error" in res)) throw new Error("expected error");
    expect(res.error.stage).toBe("query");
  });

  it("an empty corpus is not an error — zero hits, mode hybrid", async () => {
    const res = await hybridRagSearch("research_cache", "q", 5, deps({}));
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.hits).toEqual([]);
    expect(res.mode).toBe("hybrid");
  });
});
