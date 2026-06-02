/**
 * Unit tests for the eval report renderer (pure markdown generation).
 *
 * renderReport turns an EvalReport into the EVAL.md a hiring manager reads in
 * <30 seconds: a metrics summary + an explicit list of failures. Pure → no mocks.
 * RED until src/eval/report.ts exists.
 */

import { describe, it, expect } from "vitest";
import { renderReport } from "../../../src/eval/report.js";
import { scoreTask, aggregate } from "../../../src/eval/scoring.js";
import type { GoldenTask, Observation } from "../../../src/eval/types.js";

const obs = (o: Partial<Observation> = {}): Observation => ({
  route: null,
  tools: [],
  hadInterrupt: false,
  ...o,
});

function sampleReport() {
  const tasks: GoldenTask[] = [
    { id: "emails", input: "check my emails", expectedRoute: "comms" },
    { id: "email-send", input: "email alex", expectedRoute: "comms", expectedTools: ["send_email"], expectsHitl: true },
    { id: "research", input: "research stripe", expectedRoute: "research", expectsHitl: false },
  ];
  return aggregate([
    scoreTask(tasks[0]!, obs({ route: "comms" })), // pass
    scoreTask(tasks[1]!, obs({ route: "comms", tools: ["send_email"], hadInterrupt: true })), // pass
    scoreTask(tasks[2]!, obs({ route: "research", hadInterrupt: true })), // FAIL: over-gated
  ]);
}

describe("renderReport", () => {
  it("renders a titled markdown report", () => {
    const md = renderReport(sampleReport());
    expect(md).toContain("# FounderOS — Agent Eval Report");
    expect(md).toContain(sampleReport().generatedAt.slice(0, 4)); // year present
  });

  it("includes a metrics summary with rounded percentages", () => {
    const md = renderReport(sampleReport());
    expect(md).toContain("Routing");
    expect(md).toContain("100%"); // routing 3/3
    expect(md).toContain("50%"); // hitl coverage 1/2
    expect(md).toContain("67%"); // overall 2/3 rounds to 67%
  });

  it("lists failing tasks by id so regressions are obvious", () => {
    const md = renderReport(sampleReport());
    expect(md).toMatch(/Failures \(1\)/);
    expect(md).toContain("research"); // the failing task id appears
  });

  it("shows a clean all-pass message when nothing failed", () => {
    const tasks: GoldenTask[] = [
      { id: "ok", input: "check my emails", expectedRoute: "comms" },
    ];
    const report = aggregate([scoreTask(tasks[0]!, obs({ route: "comms" }))]);
    const md = renderReport(report);
    expect(md).toMatch(/Failures \(0\)/);
    expect(md).toContain("100%");
  });

  it("never emits NaN for an empty metric", () => {
    const tasks: GoldenTask[] = [{ id: "ok", input: "hi", expectedRoute: "research" }];
    const report = aggregate([scoreTask(tasks[0]!, obs({ route: "research" }))]);
    const md = renderReport(report);
    expect(md).not.toContain("NaN");
  });
});
