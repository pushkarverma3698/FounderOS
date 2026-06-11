/**
 * Unit tests — keyword-search.ts (deterministic term-overlap retrieval).
 * These pin the fix for the "single-substring ILIKE misses natural queries" bug:
 * a query like "engine swap to Claude Code" must match a doc titled
 * "019 engine swap claude code executor".
 */

import { describe, it, expect } from "vitest";
import { tokenizeQuery, scoreByTerms, rankByTerms } from "../../../src/db/keyword-search.js";

describe("tokenizeQuery", () => {
  it("splits into significant lowercase terms, dropping stop words and short tokens", () => {
    expect(tokenizeQuery("What did we decide about the engine swap to Claude Code?")).toEqual([
      "engine",
      "swap",
      "claude",
      "code",
    ]);
  });

  it("de-duplicates repeated terms, preserving first-seen order", () => {
    expect(tokenizeQuery("Claude code claude CODE engine")).toEqual(["claude", "code", "engine"]);
  });

  it("strips punctuation and numbers stay as terms when >= 3 chars", () => {
    expect(tokenizeQuery("ADR-019 pricing, naggar!")).toEqual(["adr", "019", "pricing", "naggar"]);
  });

  it("returns [] for an empty or all-stopword query", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("what did we decide about the")).toEqual([]);
  });
});

describe("scoreByTerms", () => {
  it("counts distinct terms present in the haystack", () => {
    expect(scoreByTerms("019 engine swap claude code executor", ["engine", "swap", "claude", "code"])).toBe(4);
  });

  it("matches case-insensitively and ignores absent terms", () => {
    expect(scoreByTerms("Engine Swap Decision", ["engine", "stripe", "swap"])).toBe(2);
  });

  it("returns 0 when no terms or no overlap", () => {
    expect(scoreByTerms("anything", [])).toBe(0);
    expect(scoreByTerms("unrelated text", ["stripe", "acme"])).toBe(0);
  });
});

describe("rankByTerms", () => {
  const rows = [
    { title: "Naggar pricing notes", body: "retreat pricing" },
    { title: "019 engine swap claude code executor", body: "we swapped engine to claude code" },
    { title: "Unrelated", body: "nothing here" },
  ];
  const toText = (r: { title: string; body: string }) => `${r.title} ${r.body}`;

  it("ranks the most term-overlapping row first and drops zero-score rows", () => {
    const out = rankByTerms(rows, ["engine", "swap", "claude", "code"], toText, 5);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain("engine swap claude code");
  });

  it("keeps multiple matches ordered by score desc", () => {
    const out = rankByTerms(rows, ["pricing", "engine", "claude"], toText, 5);
    expect(out[0]!.title).toContain("engine swap"); // 2 terms (engine, claude)
    expect(out[1]!.title).toBe("Naggar pricing notes"); // 1 term (pricing)
    expect(out).toHaveLength(2);
  });

  it("respects the limit", () => {
    const out = rankByTerms(rows, ["pricing", "engine", "claude", "nothing"], toText, 1);
    expect(out).toHaveLength(1);
  });

  it("returns the first N rows untouched when there are no terms (recency fallback)", () => {
    const out = rankByTerms(rows, [], toText, 2);
    expect(out).toEqual(rows.slice(0, 2));
  });
});
