/**
 * Typed retrieval results + citations (spec §1.1 F4). Every other v3 boundary is
 * Zod-validated; RAG returned free strings. RetrievalResultSchema makes a
 * retrieved passage a typed record (source, doc_type, score, chunk, citation) so
 * citations render mechanically and a malformed/sourceless "result" is a typed
 * failure rather than something the synthesizer might dress up as a real source.
 *
 * TDD: RED until src/db/retrieval-result.ts exists.
 */
import { describe, it, expect } from "vitest";
import {
  RetrievalResultSchema,
  toRetrievalResult,
  renderRetrieval,
} from "../../../src/db/retrieval-result.js";
import type { RagHit } from "../../../src/db/rag-search.js";

const hit = (content: string, meta: Record<string, unknown>, score = 0.5): RagHit => ({
  content,
  metadata: meta,
  score,
});

describe("toRetrievalResult", () => {
  it("maps a hit into a validated result with a citation from the source field", () => {
    const r = toRetrievalResult(hit("We chose LangGraph.", { source_path: "ADR-001.md", doc_type: "decision" }, 0.88), "source_path");
    expect(RetrievalResultSchema.safeParse(r).success).toBe(true);
    expect(r.source).toBe("ADR-001.md");
    expect(r.doc_type).toBe("decision");
    expect(r.score).toBe(0.88);
    expect(r.chunk).toBe("We chose LangGraph.");
    expect(r.citation).toBe("[ADR-001.md]");
  });

  it("falls back through source field → generic source → 'unknown'", () => {
    expect(toRetrievalResult(hit("x", { source: "u.com" }), "source_path").source).toBe("u.com");
    expect(toRetrievalResult(hit("x", {}), "source_path").source).toBe("unknown");
    expect(toRetrievalResult(hit("x", {}), "source_path").citation).toBe("[unknown]");
  });

  it("omits doc_type when absent (optional field)", () => {
    const r = toRetrievalResult(hit("x", { source_path: "a.md" }), "source_path");
    expect(r.doc_type).toBeUndefined();
    expect(RetrievalResultSchema.safeParse(r).success).toBe(true);
  });
});

describe("RetrievalResultSchema", () => {
  it("rejects a result with an empty chunk or missing source (no hallucinated sources)", () => {
    expect(RetrievalResultSchema.safeParse({ source: "a", score: 0.5, chunk: "", citation: "[a]" }).success).toBe(false);
    expect(RetrievalResultSchema.safeParse({ score: 0.5, chunk: "hi", citation: "[a]" }).success).toBe(false);
  });
});

describe("renderRetrieval", () => {
  it("renders a no-results message for an empty list", () => {
    expect(renderRetrieval([], "acme pricing")).toMatch(/no results/i);
  });

  it("renders each result with its citation, score, and chunk", () => {
    const results = [
      toRetrievalResult(hit("LangGraph for HITL.", { source_path: "ADR-001.md" }, 0.9), "source_path"),
      toRetrievalResult(hit("temp 0 determinism.", { source_path: "ADR-002.md" }, 0.7), "source_path"),
    ];
    const out = renderRetrieval(results, "why langgraph");
    expect(out).toContain("[ADR-001.md]");
    expect(out).toContain("0.90");
    expect(out).toContain("LangGraph for HITL.");
    expect(out).toContain("[ADR-002.md]");
    // numbered, most-relevant first
    expect(out.indexOf("[ADR-001.md]")).toBeLessThan(out.indexOf("[ADR-002.md]"));
  });
});
