/**
 * Local rerank stage (spec §1.1 F5) — fail-open, verified at $0 with a fake model.
 * After hybrid fusion, an optional local LLM (qwen2.5:7b via Ollama) reorders the
 * top passages by relevance. It is an ACCELERANT: if the model is down or returns
 * garbage, retrieval must degrade to the fused order — never to worse recall or an
 * error. These tests pin that fail-open contract and the pure index parsing.
 *
 * TDD: RED until src/db/rag-rerank.ts exists.
 */
import { describe, it, expect, vi } from "vitest";
import { rerankHits, parseRerankOrder, buildRerankPrompt } from "../../../src/db/rag-rerank.js";
import type { RagHit } from "../../../src/db/rag-search.js";

const h = (c: string): RagHit => ({ content: c, metadata: {}, score: 0.5 });
const hits = [h("A"), h("B"), h("C"), h("D")];

describe("parseRerankOrder", () => {
  it("parses a 1-based ranking into 0-based indices", () => {
    expect(parseRerankOrder("3, 1, 2, 4", 4)).toEqual([2, 0, 1, 3]);
  });
  it("tolerates prose and brackets around the numbers", () => {
    expect(parseRerankOrder("Most relevant: [2, 1]. The rest follow.", 4)).toEqual([1, 0, 2, 3]);
  });
  it("appends unmentioned indices so nothing is dropped", () => {
    expect(parseRerankOrder("2", 3)).toEqual([1, 0, 2]);
  });
  it("drops out-of-range and duplicate indices", () => {
    expect(parseRerankOrder("9, 2, 2, 0, 1", 3)).toEqual([1, 0, 2]);
  });
  it("returns null when there is no usable ordering (→ fail-open upstream)", () => {
    expect(parseRerankOrder("no idea", 3)).toBeNull();
    expect(parseRerankOrder("", 3)).toBeNull();
  });
});

describe("buildRerankPrompt", () => {
  it("numbers passages 1-based and includes the query", () => {
    const p = buildRerankPrompt("why langgraph", [h("alpha"), h("beta")]);
    expect(p).toContain("why langgraph");
    expect(p).toContain("1.");
    expect(p).toContain("2.");
    expect(p).toContain("alpha");
  });
});

describe("rerankHits (fail-open orchestration)", () => {
  it("reorders by the model's ranking on success", async () => {
    const generate = vi.fn(async () => "3, 1, 2, 4");
    const out = await rerankHits("q", hits, 2, generate);
    expect(out.map((x) => x.content)).toEqual(["C", "A"]); // top-2 of reordered
  });

  it("keeps the fused order when the model is unavailable (null)", async () => {
    const generate = vi.fn(async () => null);
    const out = await rerankHits("q", hits, 3, generate);
    expect(out.map((x) => x.content)).toEqual(["A", "B", "C"]);
  });

  it("keeps the fused order when the model returns garbage", async () => {
    const generate = vi.fn(async () => "the passages are all great");
    const out = await rerankHits("q", hits, 4, generate);
    expect(out.map((x) => x.content)).toEqual(["A", "B", "C", "D"]);
  });

  it("is a no-op for 0 or 1 hits (never calls the model)", async () => {
    const generate = vi.fn(async () => "1");
    expect(await rerankHits("q", [], 5, generate)).toEqual([]);
    await rerankHits("q", [h("only")], 5, generate);
    expect(generate).not.toHaveBeenCalled();
  });
});
