/**
 * Unit tests for the eval runner.
 *
 * runEval drives a list of golden tasks through an INJECTED invoker and returns
 * a scored report. The injected invoker is the whole point: unit tests pass a
 * deterministic stub (zero LLM cost, fully reproducible), while `pnpm eval`
 * passes a real invoker that runs the office graph. RED until runner.ts exists.
 */

import { describe, it, expect } from "vitest";
import { runEval } from "../../../src/eval/runner.js";
import type { GoldenTask, Observation, Invoker } from "../../../src/eval/runner.js";

const tasks: GoldenTask[] = [
  { id: "emails", input: "check my emails", expectedRoute: "comms" },
  { id: "email-send", input: "email alex", expectedRoute: "comms", expectedTools: ["send_email"], expectsHitl: true },
  { id: "research", input: "research stripe", expectedRoute: "research", expectsHitl: false },
];

/** A stub invoker that returns canned observations by task id. */
function stubInvoker(map: Record<string, Observation>): Invoker {
  return async (task: GoldenTask) => map[task.id]!;
}

describe("runEval", () => {
  it("scores every task and aggregates a report", async () => {
    const invoke = stubInvoker({
      emails: { route: "comms", tools: [], hadInterrupt: false },
      "email-send": { route: "comms", tools: ["send_email"], hadInterrupt: true },
      research: { route: "research", tools: ["search_web"], hadInterrupt: false },
    });

    const report = await runEval(tasks, invoke);

    expect(report.results).toHaveLength(3);
    expect(report.overall.passed).toBe(3); // all three behave correctly
    expect(report.routing.accuracy).toBe(1);
    expect(report.hitlCoverage).toEqual({ total: 2, passed: 2, accuracy: 1 });
  });

  it("catches a routing regression", async () => {
    const invoke = stubInvoker({
      emails: { route: "research", tools: [], hadInterrupt: false }, // WRONG route
      "email-send": { route: "comms", tools: ["send_email"], hadInterrupt: true },
      research: { route: "research", tools: [], hadInterrupt: false },
    });

    const report = await runEval(tasks, invoke);
    expect(report.routing.passed).toBe(2);
    expect(report.overall.passed).toBe(2);
    const failed = report.results.find((r) => r.task.id === "emails");
    expect(failed?.passed).toBe(false);
  });

  it("records an invoker error as a failed task instead of throwing", async () => {
    const invoke: Invoker = async (task) => {
      if (task.id === "email-send") throw new Error("Gemini 503");
      return { route: task.expectedRoute, tools: task.expectedTools ?? [], hadInterrupt: task.expectsHitl ?? false };
    };

    const report = await runEval(tasks, invoke);
    const errored = report.results.find((r) => r.task.id === "email-send");
    expect(errored?.passed).toBe(false);
    expect(errored?.observation.error).toContain("Gemini 503");
    expect(errored?.observation.route).toBeNull();
    // the other two still scored
    expect(report.results).toHaveLength(3);
  });

  it("runs tasks and preserves their order in results", async () => {
    const invoke = stubInvoker({
      emails: { route: "comms", tools: [], hadInterrupt: false },
      "email-send": { route: "comms", tools: ["send_email"], hadInterrupt: true },
      research: { route: "research", tools: [], hadInterrupt: false },
    });
    const report = await runEval(tasks, invoke);
    expect(report.results.map((r) => r.task.id)).toEqual(["emails", "email-send", "research"]);
  });
});
