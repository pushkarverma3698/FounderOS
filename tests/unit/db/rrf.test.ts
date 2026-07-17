/**
 * Reciprocal Rank Fusion — pure, deterministic (spec §1.1 F2).
 * RRF merges independent ranked lists (vector + keyword) into one order without
 * needing comparable scores: each list contributes 1/(k + rank). A document that
 * ranks well in BOTH lists rises above one that ranks well in only one. This is
 * the whole reason hybrid retrieval beats either path alone — and because it is
 * pure arithmetic, it is verifiable here at $0 (no DB, no Ollama).
 *
 * TDD: RED until src/db/rrf.ts exists.
 */
import { describe, it, expect } from "vitest";
import { reciprocalRankFusion, RRF_K } from "../../../src/db/rrf.js";

const id = (s: string) => s;

describe("reciprocalRankFusion", () => {
  it("returns [] for no lists and for all-empty lists", () => {
    expect(reciprocalRankFusion([], id)).toEqual([]);
    expect(reciprocalRankFusion([[], []], id)).toEqual([]);
  });

  it("preserves order and assigns descending scores for a single list", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"]], id);
    expect(fused.map((f) => f.item)).toEqual(["a", "b", "c"]);
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
    expect(fused[1]!.score).toBeGreaterThan(fused[2]!.score);
    expect(fused.every((f) => f.sources === 1)).toBe(true);
  });

  it("ranks a doc appearing in BOTH lists above docs in only one", () => {
    // vector: [A,B,C]  keyword: [B,D,A]  → B and A are in both.
    const fused = reciprocalRankFusion([["A", "B", "C"], ["B", "D", "A"]], id);
    expect(fused.map((f) => f.item)).toEqual(["B", "A", "D", "C"]);
    // B and A drew from two lists; D and C from one.
    expect(fused.find((f) => f.item === "B")!.sources).toBe(2);
    expect(fused.find((f) => f.item === "A")!.sources).toBe(2);
    expect(fused.find((f) => f.item === "D")!.sources).toBe(1);
  });

  it("uses keyOf to merge the same document across lists (dedup)", () => {
    const vec = [{ id: "x", from: "vec" }, { id: "y", from: "vec" }];
    const kw = [{ id: "x", from: "kw" }];
    const fused = reciprocalRankFusion([vec, kw], (r) => r.id);
    expect(fused).toHaveLength(2); // x merged, not duplicated
    expect(fused[0]!.item.id).toBe("x");
    expect(fused[0]!.sources).toBe(2);
    // Representative item is the first-seen one (vector list here).
    expect(fused[0]!.item.from).toBe("vec");
  });

  it("matches the RRF formula for k", () => {
    const [a] = reciprocalRankFusion([["a"]], id, 60);
    expect(a!.score).toBeCloseTo(1 / (60 + 1), 10);
    expect(RRF_K).toBe(60);
  });

  it("is stable on ties (first-seen wins)", () => {
    // Two disjoint singletons at rank 1 → equal score → input order preserved.
    const fused = reciprocalRankFusion([["a"], ["b"]], id);
    expect(fused.map((f) => f.item)).toEqual(["a", "b"]);
  });
});
