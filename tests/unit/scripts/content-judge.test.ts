/**
 * L1 — the hard-battery content judge must turn a real content failure into a
 * FAIL, not a rubber-stamp. These cover the PURE layer (parse + aggregate);
 * the network call is fail-open and exercised live.
 */
import { describe, it, expect } from "vitest";
import {
  parseContentVerdict,
  aggregateVerdict,
  FAIL_THRESHOLD,
  type ContentScores,
} from "../../../scripts/lib/content-judge.js";

const good: ContentScores = {
  execution: 5,
  grounding: 5,
  safety: 5,
  specificity: 4,
  honesty: 5,
};

describe("aggregateVerdict", () => {
  it("passes when every dimension is above the fail threshold", () => {
    const v = aggregateVerdict(good, "solid");
    expect(v.ok).toBe(true);
  });

  it("fails when any dimension is at or below the threshold", () => {
    const v = aggregateVerdict({ ...good, execution: FAIL_THRESHOLD }, "refused a doable task");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failed).toContain("execution");
  });

  it("reports every failing dimension (fabrication + refusal)", () => {
    const v = aggregateVerdict({ ...good, execution: 1, grounding: 2 }, "bad");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failed.sort()).toEqual(["execution", "grounding"]);
  });
});

describe("parseContentVerdict", () => {
  it("parses compact JSON and passes a strong reply", () => {
    const v = parseContentVerdict(
      '{"execution":5,"grounding":5,"safety":5,"specificity":4,"honesty":5,"critique":"good"}',
    );
    expect(v.ok).toBe(true);
  });

  it("extracts JSON even when the model is chatty around it", () => {
    const v = parseContentVerdict(
      'Sure! Here is my verdict:\n{"execution":1,"grounding":4,"safety":5,"specificity":3,"honesty":4,"critique":"refused"}\nHope that helps.',
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.failed).toContain("execution");
  });

  it("clamps out-of-range scores into 1..5", () => {
    const v = parseContentVerdict(
      '{"execution":9,"grounding":0,"safety":5,"specificity":5,"honesty":5}',
    );
    // grounding 0 → clamped to 1 → fails
    expect(v.ok).toBe(false);
  });

  it("fail-OPEN: non-JSON output is skipped, never a false FAIL", () => {
    const v = parseContentVerdict("the model rambled with no json");
    expect(v.ok).toBe(true);
    expect("skipped" in v && v.skipped).toBe(true);
  });

  it("fills missing dimensions with a neutral 3 (no false fail)", () => {
    const v = parseContentVerdict('{"execution":5,"critique":"partial json"}');
    expect(v.ok).toBe(true); // 5 + four neutral 3s → all above threshold
  });
});
