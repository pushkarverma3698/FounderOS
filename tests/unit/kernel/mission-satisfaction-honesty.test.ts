/**
 * Mission-satisfaction honesty checks.
 *
 * Two defects the 2026-08-14 Reality Benchmark caught, both silent:
 *   D4 — "give me 500 jobs" against a 297-row pipeline returned 297 and said
 *        nothing, which is indistinguishable from a complete answer.
 *   D3 — "give me a pdf" produced a .md and offered to send it without naming
 *        the substitution.
 *
 * Both must surface as `unmet`, which the synthesizer is required to state.
 */

import { describe, it, expect } from "vitest";
import { missionSatisfied } from "../../../src/kernel/mission-satisfaction.js";
import type { StepResult } from "../../../src/kernel/contracts.js";

function recordStep(count: number, total: number): StepResult {
  return {
    step_id: "s1",
    status: "ok",
    output: { rows: [] },
    tool_receipts: [],
    observed: { kind: "record", evidence: `count:${count},total:${total}` },
  } as StepResult;
}

function fileStep(path: string, bytes = 2048): StepResult {
  return {
    step_id: "s1",
    status: "ok",
    output: { path },
    tool_receipts: [],
    observed: { kind: "file", evidence: `${path}:${bytes}` },
  } as StepResult;
}

describe("quantity reconciliation (D4)", () => {
  it("flags a request for more rows than exist", () => {
    const v = missionSatisfied("give me 500 jobs from the pipeline as a csv", [], [recordStep(297, 297)]);

    expect(v.ok).toBe(false);
    expect(v.unmet?.join(" ")).toContain("Asked for 500 jobs, but only 297 exist");
  });

  it("stays silent when the pipeline can satisfy the number", () => {
    const v = missionSatisfied("give me 50 jobs from the pipeline", [], [recordStep(50, 297)]);
    expect(v.ok).toBe(true);
  });

  it("stays silent when no quantity was named", () => {
    const v = missionSatisfied("give me the jobs from the pipeline", [], [recordStep(297, 297)]);
    expect(v.ok).toBe(true);
  });

  it("does not read a bare year as a quantity", () => {
    const v = missionSatisfied("show me what happened in 2026", [], [recordStep(12, 12)]);
    expect(v.ok).toBe(true);
  });
});

describe("format substitution (D3)", () => {
  it("flags a markdown file produced for a PDF request", () => {
    const v = missionSatisfied(
      "give me a pdf of every email i sent last month",
      [],
      [fileStep("/opt/founderos/artifacts/emails.md")],
    );

    expect(v.ok).toBe(false);
    expect(v.unmet?.join(" ")).toContain("Asked for a PDF but a MD was produced");
  });

  it("stays silent when the produced format matches the request", () => {
    const v = missionSatisfied("give me a csv of the pipeline", [], [fileStep("/opt/founderos/artifacts/jobs.csv")]);
    expect(v.ok).toBe(true);
  });

  it("treats 'the pdf' as a reference to an existing file, not a request to make one", () => {
    const v = missionSatisfied("summarize the pdf i sent you", [], [fileStep("/opt/founderos/artifacts/summary.md")]);
    expect(v.ok).toBe(true);
  });

  it("resolves format aliases before comparing", () => {
    const v = missionSatisfied("export it as an excel", [], [fileStep("/opt/founderos/artifacts/report.xlsx")]);
    expect(v.ok).toBe(true);
  });
});
