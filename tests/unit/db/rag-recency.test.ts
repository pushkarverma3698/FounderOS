/**
 * Recent knowledge outranks old knowledge of the same strength (src/db/rag-recency.ts).
 * ====================================================================================
 * 2026-10-04 audit: 310 of the 763 plan chunks in brain_memories were over 30 days old and ranked exactly like last
 * week's, so a question about "the plan for X" could be answered from a plan that had since been replaced.
 *
 * The rule is a tie-breaker, not an override: a dated document loses at most 30% of its fused score over 90 days, and a
 * document with no date in its name (an ADR, CLAUDE.md, a rule) is never aged. A strong old match still beats a weak new one.
 */

import { describe, expect, it } from "vitest";
import {
  RECENCY_FLOOR,
  RECENCY_FULL_DECAY_DAYS,
  docDateMs,
  orderWithRecency,
  recencyWeight,
} from "../../../src/db/rag-recency.js";
import { hybridRagSearch, type HybridDeps } from "../../../src/db/rag-hybrid.js";
import type { RagHit } from "../../../src/db/rag-search.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString().slice(0, 10);

const plan = (content: string, ageDays: number): RagHit => ({
  content,
  metadata: { source_path: `docs/plans/${daysAgo(ageDays)}-${content}.md` },
  score: 0.5,
});
const evergreen = (content: string): RagHit => ({ content, metadata: { source_path: "docs/adr/ADR-038-brain.md" }, score: 0.5 });

describe("docDateMs — the date a document carries in its own file name", () => {
  it.each([
    ["docs/plans/2026-10-03-switchable-coding-cli.md", Date.UTC(2026, 9, 3)],
    ["docs/sessions/2026-08-25-foo.md", Date.UTC(2026, 7, 25)],
    ["2026-09-01-bare-name.md", Date.UTC(2026, 8, 1)],
  ])("%s", (path, ms) => {
    expect(docDateMs({ source_path: path })).toBe(ms);
  });

  it("reads source_file too (the personal_rag field name)", () => {
    expect(docDateMs({ source_file: "docs/plans/2026-10-03-x.md" })).toBe(Date.UTC(2026, 9, 3));
  });

  it.each([
    ["an ADR has no date", { source_path: "docs/adr/ADR-038-brain.md" }],
    ["a date in the middle of the name is not the document's date", { source_path: "docs/plans/audit-2026-10-03.md" }],
    ["an impossible date", { source_path: "docs/plans/2026-13-45-x.md" }],
    ["a date directory is not a file name", { source_path: "2026-10-03/readme.md" }],
    ["no path at all", {}],
    ["a path that is not a string", { source_path: 42 }],
  ])("%s → no date", (_name, metadata) => {
    expect(docDateMs(metadata as Record<string, unknown>)).toBeNull();
  });
});

describe("recencyWeight", () => {
  it("is 1 for today and falls in a straight line to the floor", () => {
    expect(recencyWeight(0)).toBe(1);
    expect(recencyWeight(RECENCY_FULL_DECAY_DAYS / 2)).toBeCloseTo((1 + RECENCY_FLOOR) / 2, 10);
    expect(recencyWeight(RECENCY_FULL_DECAY_DAYS)).toBeCloseTo(RECENCY_FLOOR, 10);
  });

  it("never goes below the floor, however old", () => {
    expect(recencyWeight(5_000)).toBe(RECENCY_FLOOR);
  });

  it("treats a date in the future (a plan dated tomorrow, timezone skew) as today", () => {
    expect(recencyWeight(-3)).toBe(1);
  });

  it("the floor is the documented 30% maximum loss", () => {
    expect(RECENCY_FLOOR).toBe(0.7);
    expect(RECENCY_FULL_DECAY_DAYS).toBe(90);
  });
});

describe("orderWithRecency", () => {
  it("puts a new plan above an old plan that fused to the same score", () => {
    const old = plan("old", 120);
    const fresh = plan("fresh", 2);
    const ordered = orderWithRecency([{ item: old, score: 0.03 }, { item: fresh, score: 0.03 }], NOW);
    expect(ordered.map((h) => h.content)).toEqual(["fresh", "old"]);
  });

  it("a clearly stronger old match still wins: this is a tie-breaker, not an override", () => {
    const old = plan("old", 400);
    const fresh = plan("fresh", 1);
    // 0.0328 (rank 1 in both lists) * 0.7 = 0.0230, against 0.0164 (rank 1 in one list) * ~1
    const ordered = orderWithRecency([{ item: fresh, score: 0.0164 }, { item: old, score: 0.0328 }], NOW);
    expect(ordered.map((h) => h.content)).toEqual(["old", "fresh"]);
  });

  it("never ages a document that carries no date", () => {
    const ordered = orderWithRecency(
      [{ item: evergreen("adr"), score: 0.03 }, { item: plan("yesterday", 1), score: 0.03 }],
      NOW,
    );
    // The ADR keeps weight 1, the one-day-old plan is a hair under 1: the ADR is first, and not demoted below old plans.
    expect(ordered.map((h) => h.content)).toEqual(["adr", "yesterday"]);
    const vsOld = orderWithRecency([{ item: plan("old", 400), score: 0.03 }, { item: evergreen("adr"), score: 0.03 }], NOW);
    expect(vsOld.map((h) => h.content)).toEqual(["adr", "old"]);
  });

  it("keeps the incoming order for equal adjusted scores (deterministic)", () => {
    const a = evergreen("a");
    const b = { ...evergreen("b"), metadata: { source_path: "docs/adr/other.md" } };
    expect(orderWithRecency([{ item: a, score: 0.02 }, { item: b, score: 0.02 }], NOW).map((h) => h.content)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const input = [{ item: plan("old", 200), score: 0.03 }, { item: plan("fresh", 1), score: 0.03 }] as const;
    orderWithRecency(input, NOW);
    expect(input.map((s) => s.item.content)).toEqual(["old", "fresh"]);
  });
});

describe("hybridRagSearch with recency", () => {
  const deps = (vec: RagHit[], kw: RagHit[]): HybridDeps => ({
    vectorSearch: async () => vec,
    keywordSearch: async () => kw,
    now: () => NOW,
  });

  it("hybrid: of two equally ranked plans the newer one leads", async () => {
    const old = plan("old", 200);
    const fresh = plan("fresh", 3);
    // Same ranks in the two lists, mirrored: both fuse to the same score.
    const res = await hybridRagSearch("brain_memories", "q", 5, deps([old, fresh], [fresh, old]));
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.hits.map((h) => h.content)).toEqual(["fresh", "old"]);
  });

  it("vector only (keyword down): a near-tie is broken toward the newer plan", async () => {
    const old = plan("old", 200);
    const fresh = plan("fresh", 3);
    const res = await hybridRagSearch("brain_memories", "q", 5, {
      vectorSearch: async () => [old, fresh],
      keywordSearch: async () => {
        throw new Error("down");
      },
      now: () => NOW,
    });
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.mode).toBe("vector");
    expect(res.hits.map((h) => h.content)).toEqual(["fresh", "old"]);
  });

  it("keyword fallback (embedder down) is reordered the same way, and still labelled degraded", async () => {
    const old = plan("old", 200);
    const fresh = plan("fresh", 3);
    const res = await hybridRagSearch("brain_memories", "q", 5, {
      vectorSearch: async () => {
        throw new Error("ollama down");
      },
      keywordSearch: async () => [old, fresh],
      now: () => NOW,
    });
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.mode).toBe("keyword-fallback");
    expect(res.degradedReason).toContain("ollama down");
    expect(res.hits.map((h) => h.content)).toEqual(["fresh", "old"]);
  });

  it("leaves personal_rag alone: a career fact does not get older", async () => {
    const old = plan("old", 400);
    const fresh = plan("fresh", 1);
    const res = await hybridRagSearch("personal_rag", "q", 5, deps([old, fresh], [old, fresh]));
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.hits.map((h) => h.content)).toEqual(["old", "fresh"]);
  });

  it("recency can pull a near-tied recent plan into the top k, not just reorder a fixed set", async () => {
    // topK 1: ranks tie, the old plan came first. The recent one must be the single hit returned.
    const old = plan("old", 300);
    const fresh = plan("fresh", 1);
    const res = await hybridRagSearch("brain_memories", "q", 1, deps([old, fresh], [fresh, old]));
    if (!("hits" in res)) throw new Error("expected hits");
    expect(res.hits.map((h) => h.content)).toEqual(["fresh"]);
  });
});
