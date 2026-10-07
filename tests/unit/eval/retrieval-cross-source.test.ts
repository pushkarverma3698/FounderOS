/**
 * Unit test — cross-source and no-answer scoring (AG-029). Hits are literals; no database, no embedder.
 */
import { describe, it, expect } from "vitest";
import {
  CROSS_SOURCE_CASES,
  countExtraFailures,
  renderExtraReport,
  scoreCrossSourceCase,
  scoreNoAnswerCase,
  type CrossSourceCase,
} from "../../../src/eval/retrieval-cross-source.js";
import { RETRIEVAL_NO_ANSWER_CASES } from "../../../src/eval/retrieval-no-answer.js";
import { BRAIN_ABSTAIN_SIMILARITY } from "../../../src/db/brain-hit-view.js";
import type { RagHit } from "../../../src/db/rag-search.js";

const live: CrossSourceCase = {
  id: "c1",
  origin: "mac-claude",
  query: "q",
  expectContains: "recall block",
  rationale: "r",
};

function hit(over: Partial<RagHit> & { origin?: string }): RagHit {
  const { origin, ...rest } = over;
  return { content: "x", metadata: origin ? { origin } : {}, score: 0.5, memory_type: "note", cosine: 0.8, ...rest };
}

describe("CROSS_SOURCE_CASES", () => {
  it("covers telegram, mac-claude, mac-agy and vps-daemon with unique ids", () => {
    expect(new Set(CROSS_SOURCE_CASES.map((c) => c.origin))).toEqual(new Set(["telegram", "mac-claude", "mac-agy", "vps-daemon"]));
    expect(new Set(CROSS_SOURCE_CASES.map((c) => c.id)).size).toBe(CROSS_SOURCE_CASES.length);
  });
  it("is honest about pending data: a case with no expected phrase never scores as a pass", () => {
    for (const c of CROSS_SOURCE_CASES) {
      const none = scoreCrossSourceCase(c, [], 0, 5);
      const some = scoreCrossSourceCase(c, [hit({ origin: c.origin })], 9, 5);
      expect(c.expectContains === null ? [none.verdict, some.verdict] : []).toEqual(c.expectContains === null ? ["pending", "pending"] : []);
    }
  });
});

describe("scoreCrossSourceCase", () => {
  it("pending says whether rows exist yet", () => {
    const p: CrossSourceCase = { ...live, expectContains: null };
    expect(scoreCrossSourceCase(p, [], 0, 5).detail).toMatch(/0 rows with origin "mac-claude"/);
    expect(scoreCrossSourceCase(p, [], 12, 5).detail).toMatch(/12 rows.*Copy a phrase/);
  });
  it("passes when a top-k hit of the right origin contains the phrase (case-insensitive)", () => {
    const r = scoreCrossSourceCase(live, [hit({ origin: "docs" }), hit({ origin: "mac-claude", content: "Built the Recall Block today" })], 3, 5);
    expect(r.verdict).toBe("pass");
    expect(r.detail).toMatch(/rank 2 of 5/);
  });
  it("fails when the phrase is present but from another origin (the negative that catches over-matching)", () => {
    const r = scoreCrossSourceCase(live, [hit({ origin: "docs", content: "recall block" })], 3, 5);
    expect(r.verdict).toBe("fail");
  });
  it("fails when the phrase ranks below k", () => {
    const hits = [...Array.from({ length: 5 }, () => hit({ origin: "mac-claude" })), hit({ origin: "mac-claude", content: "recall block" })];
    expect(scoreCrossSourceCase(live, hits, 3, 5).verdict).toBe("fail");
  });
  it("fails loudly when an active case finds the origin has zero rows (capture is dead)", () => {
    const r = scoreCrossSourceCase(live, [], 0, 5);
    expect(r.verdict).toBe("fail");
    expect(r.detail).toMatch(/Capture is dead/);
  });
});

describe("scoreNoAnswerCase", () => {
  const c = RETRIEVAL_NO_ANSWER_CASES[0]!;
  it("passes when the best cosine is under the abstain threshold", () => {
    expect(scoreNoAnswerCase(c, [hit({ cosine: BRAIN_ABSTAIN_SIMILARITY - 0.1 })]).abstained).toBe(true);
  });
  it("passes when retrieval returned nothing", () => {
    expect(scoreNoAnswerCase(c, []).abstained).toBe(true);
  });
  it("misses when the best cosine clears the threshold, and tells the founder what to calibrate", () => {
    const r = scoreNoAnswerCase(c, [hit({ cosine: BRAIN_ABSTAIN_SIMILARITY + 0.2 })]);
    expect(r.abstained).toBe(false);
    expect(r.detail).toMatch(/Calibrate BRAIN_ABSTAIN_SIMILARITY/);
  });
  it("misses when no hit carries a cosine, since the abstain cannot decide", () => {
    const { cosine: _drop, ...noCosine } = hit({});
    expect(scoreNoAnswerCase(c, [noCosine]).abstained).toBe(false);
  });
});

describe("countExtraFailures / renderExtraReport", () => {
  it("counts live cross-source fails and no-answer misses, not pending", () => {
    const cross = [scoreCrossSourceCase(live, [], 0, 5), scoreCrossSourceCase({ ...live, expectContains: null }, [], 0, 5)];
    const none = [scoreNoAnswerCase(RETRIEVAL_NO_ANSWER_CASES[0]!, [hit({ cosine: 0.99 })])];
    expect(countExtraFailures(cross, none)).toBe(2);
    expect(countExtraFailures([cross[1]!], [])).toBe(0);
  });
  it("lists failures before pending and states how many cases are pending", () => {
    const cross = [scoreCrossSourceCase({ ...live, id: "p", expectContains: null }, [], 0, 5), scoreCrossSourceCase(live, [], 0, 5)];
    const out = renderExtraReport(cross, []);
    expect(out.indexOf("FAIL c1")).toBeLessThan(out.indexOf("PENDING p"));
    expect(out).toMatch(/1 of 2 cases are pending data/);
  });
});
