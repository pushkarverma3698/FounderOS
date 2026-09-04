/**
 * Unit tests for the eval harness scoring (pure functions).
 *
 * The eval harness measures the multi-agent system against a fixed golden-task
 * set: did the supervisor route to the right department, did the department use
 * the expected tools, and was the HITL gate triggered when it should be?
 *
 * Scoring is pure — no LLM, no mocks. RED until src/eval/scoring.ts exists.
 */

import { describe, it, expect } from "vitest";
import {
  scoreRouting,
  scoreToolSelection,
  scoreHitl,
  scoreTask,
  aggregate,
  isInfraError,
} from "../../../src/eval/scoring.js";
import type { GoldenTask, Observation, TaskResult } from "../../../src/eval/types.js";

const obs = (o: Partial<Observation> = {}): Observation => ({
  route: null,
  tools: [],
  hadInterrupt: false,
  ...o,
});

// ── scoreRouting ────────────────────────────────────────────────────────────────

describe("scoreRouting", () => {
  const task: GoldenTask = { id: "t1", input: "check my emails", expectedRoute: "comms" };

  it("is true when observed route matches the expected route", () => {
    expect(scoreRouting(task, obs({ route: "comms" }))).toBe(true);
  });

  it("is false when observed route differs", () => {
    expect(scoreRouting(task, obs({ route: "research" }))).toBe(false);
  });

  it("is false when nothing was routed (null)", () => {
    expect(scoreRouting(task, obs({ route: null }))).toBe(false);
  });
});

// ── scoreRouting: whole-plan match (docs/EVAL-AUDIT-2026-08-28.md D2) ────────────
// A correct multi-step plan like [research, comms] was scored wrong whenever the
// expectation named the SECOND worker, because only steps[0] was checked.

describe("scoreRouting — whole plan, not just steps[0]", () => {
  it("passes when the expected worker is a LATER step of a correct plan", () => {
    const task: GoldenTask = { id: "chain", input: "research then email", expectedRoute: "comms" };
    const observation = obs({
      route: "research",
      steps: [
        { worker: "research", objective: "look up the company" },
        { worker: "comms", objective: "send the summary" },
      ],
    });
    expect(scoreRouting(task, observation)).toBe(true);
  });

  it("still fails when the expected worker never appears anywhere in the plan", () => {
    const task: GoldenTask = { id: "chain2", input: "research then email", expectedRoute: "sales" };
    const observation = obs({
      route: "research",
      steps: [
        { worker: "research", objective: "look up the company" },
        { worker: "comms", objective: "send the summary" },
      ],
    });
    expect(scoreRouting(task, observation)).toBe(false);
  });

  it("falls back to the single `route` field when the observation never set `steps` (older/stubbed observations)", () => {
    const task: GoldenTask = { id: "no-steps", input: "check emails", expectedRoute: "comms" };
    expect(scoreRouting(task, obs({ route: "comms" }))).toBe(true);
    expect(scoreRouting(task, obs({ route: "research" }))).toBe(false);
  });

  it("treats an empty steps array the same as no plan — falls back to route", () => {
    const task: GoldenTask = { id: "empty-steps", input: "check emails", expectedRoute: "comms" };
    expect(scoreRouting(task, obs({ route: "comms", steps: [] }))).toBe(true);
  });
});

// ── scoreRouting: expectedRoute:null means "a direct reply is correct" (D4) ─────

describe("scoreRouting — direct-reply expectation (expectedRoute: null)", () => {
  const task: GoldenTask = { id: "direct", input: "write me a function", expectedRoute: null };

  it("passes when the planner replied directly (no route, no plan)", () => {
    expect(scoreRouting(task, obs({ route: null }))).toBe(true);
  });

  it("fails when a plan was produced instead of a direct reply", () => {
    const observation = obs({
      route: "engineering",
      steps: [{ worker: "engineering", objective: "write the function" }],
    });
    expect(scoreRouting(task, observation)).toBe(false);
  });

  it("fails when route is non-null even without a steps array", () => {
    expect(scoreRouting(task, obs({ route: "engineering" }))).toBe(false);
  });
});

// ── scoreToolSelection ──────────────────────────────────────────────────────────

describe("scoreToolSelection", () => {
  it("passes when every expected tool was used (subset match)", () => {
    const task: GoldenTask = {
      id: "t2",
      input: "email alex",
      expectedRoute: "comms",
      expectedTools: ["send_email"],
    };
    expect(scoreToolSelection(task, obs({ tools: ["send_email"] }))).toBe(true);
  });

  it("passes when expected tools are a subset of observed tools", () => {
    const task: GoldenTask = {
      id: "t3",
      input: "research and email",
      expectedRoute: "comms",
      expectedTools: ["send_email"],
    };
    expect(scoreToolSelection(task, obs({ tools: ["search_web", "send_email"] }))).toBe(true);
  });

  it("fails when an expected tool is missing", () => {
    const task: GoldenTask = {
      id: "t4",
      input: "email alex",
      expectedRoute: "comms",
      expectedTools: ["send_email"],
    };
    expect(scoreToolSelection(task, obs({ tools: ["read_emails"] }))).toBe(false);
  });

  it("is vacuously true when the task declares no expected tools", () => {
    const task: GoldenTask = { id: "t5", input: "hi", expectedRoute: "research" };
    expect(scoreToolSelection(task, obs({ tools: [] }))).toBe(true);
  });
});

// ── scoreHitl ────────────────────────────────────────────────────────────────────

describe("scoreHitl", () => {
  it("passes when an interrupt was expected and happened", () => {
    const task: GoldenTask = { id: "t6", input: "email alex", expectedRoute: "comms", expectsHitl: true };
    expect(scoreHitl(task, obs({ hadInterrupt: true }))).toBe(true);
  });

  it("fails when an interrupt was expected but did not happen (silent send risk)", () => {
    const task: GoldenTask = { id: "t7", input: "email alex", expectedRoute: "comms", expectsHitl: true };
    expect(scoreHitl(task, obs({ hadInterrupt: false }))).toBe(false);
  });

  it("fails when an interrupt happened but none was expected (over-gating)", () => {
    const task: GoldenTask = { id: "t8", input: "research stripe", expectedRoute: "research", expectsHitl: false };
    expect(scoreHitl(task, obs({ hadInterrupt: true }))).toBe(false);
  });

  it("is vacuously true when the task does not declare a HITL expectation", () => {
    const task: GoldenTask = { id: "t9", input: "hi", expectedRoute: "research" };
    expect(scoreHitl(task, obs({ hadInterrupt: true }))).toBe(true);
  });
});

// ── scoreTask ────────────────────────────────────────────────────────────────────

describe("scoreTask", () => {
  it("passes only when all applicable checks pass", () => {
    const task: GoldenTask = {
      id: "t10",
      input: "email alex",
      expectedRoute: "comms",
      expectedTools: ["send_email"],
      expectsHitl: true,
    };
    const r = scoreTask(task, obs({ route: "comms", tools: ["send_email"], hadInterrupt: true }));
    expect(r.routeCorrect).toBe(true);
    expect(r.toolsCorrect).toBe(true);
    expect(r.hitlCorrect).toBe(true);
    expect(r.passed).toBe(true);
  });

  it("fails the task if any single check fails", () => {
    const task: GoldenTask = {
      id: "t11",
      input: "email alex",
      expectedRoute: "comms",
      expectedTools: ["send_email"],
      expectsHitl: true,
    };
    // routed wrong → whole task fails even though tools/hitl would pass
    const r = scoreTask(task, obs({ route: "research", tools: ["send_email"], hadInterrupt: true }));
    expect(r.routeCorrect).toBe(false);
    expect(r.passed).toBe(false);
  });
});

// ── aggregate ────────────────────────────────────────────────────────────────────

describe("aggregate", () => {
  it("computes each metric only over applicable tasks and an honest overall", () => {
    const tasks: GoldenTask[] = [
      { id: "a", input: "check emails", expectedRoute: "comms" }, // routing only
      { id: "b", input: "email alex", expectedRoute: "comms", expectedTools: ["send_email"], expectsHitl: true },
      { id: "c", input: "research stripe", expectedRoute: "research", expectsHitl: false },
    ];
    const results: TaskResult[] = [
      scoreTask(tasks[0]!, obs({ route: "comms" })), // pass
      scoreTask(tasks[1]!, obs({ route: "comms", tools: ["send_email"], hadInterrupt: true })), // pass
      scoreTask(tasks[2]!, obs({ route: "research", hadInterrupt: true })), // hitl fail (over-gated)
    ];
    const report = aggregate(results);

    // routing: all 3 routed correctly
    expect(report.routing).toEqual({ total: 3, passed: 3, accuracy: 1 });
    // tool selection: only task b declares tools → 1/1
    expect(report.toolSelection).toEqual({ total: 1, passed: 1, accuracy: 1 });
    // hitl coverage: tasks b + c declare expectsHitl → 2 total, c failed → 1/2
    expect(report.hitlCoverage).toEqual({ total: 2, passed: 1, accuracy: 0.5 });
    // overall: 2 of 3 tasks fully passed
    expect(report.overall.total).toBe(3);
    expect(report.overall.passed).toBe(2);
    expect(report.results).toHaveLength(3);
    expect(typeof report.generatedAt).toBe("string");
  });

  it("reports zero accuracy without dividing by zero on an empty metric", () => {
    const results: TaskResult[] = [scoreTask({ id: "x", input: "hi", expectedRoute: "research" }, obs({ route: "research" }))];
    const report = aggregate(results);
    // no task declared tools → toolSelection total 0, accuracy 0 (not NaN)
    expect(report.toolSelection.total).toBe(0);
    expect(report.toolSelection.accuracy).toBe(0);
  });
});

// ── INFRA_ERROR vs WRONG_ROUTE distinction ───────────────────────────────────────
// A transient infrastructure error (e.g. a 503 that escapes the model layer and is
// caught by the runner as `route: null` + `error`) must NOT be scored the same as a
// genuine routing miss. Otherwise flaky infra silently deflates the capability score
// and hides the real signal. Infra-errored tasks are set aside, not counted as fails.

describe("INFRA_ERROR handling", () => {
  const task: GoldenTask = { id: "infra", input: "check my emails", expectedRoute: "comms" };

  it("scoreTask marks a task with an error as infraError (not a routing failure)", () => {
    const r = scoreTask(task, obs({ route: null, error: "503 Service Unavailable" }));
    expect(r.infraError).toBe(true);
    expect(r.passed).toBe(false);
  });

  it("scoreTask leaves infraError false on a clean observation (even a real misroute)", () => {
    const r = scoreTask(task, obs({ route: "research" })); // wrong route, but NOT infra
    expect(r.infraError).toBe(false);
  });

  it("aggregate excludes infra-errored tasks from every capability denominator", () => {
    const tasks: GoldenTask[] = [
      { id: "ok", input: "check emails", expectedRoute: "comms" },
      { id: "miss", input: "research stripe", expectedRoute: "research" },
      { id: "boom", input: "email alex", expectedRoute: "comms" },
    ];
    const results: TaskResult[] = [
      scoreTask(tasks[0]!, obs({ route: "comms" })), // pass
      scoreTask(tasks[1]!, obs({ route: "comms" })), // genuine misroute → counts as fail
      scoreTask(tasks[2]!, obs({ route: null, error: "GoogleGenerativeAI 503" })), // infra → excluded
    ];
    const report = aggregate(results);

    // routing denominator excludes the infra task: 1 pass / 2 scorable
    expect(report.routing).toEqual({ total: 2, passed: 1, accuracy: 0.5 });
    // overall likewise excludes infra
    expect(report.overall.total).toBe(2);
    expect(report.overall.passed).toBe(1);
    // infra errors reported as their own count
    expect(report.infraErrors).toBe(1);
    // every result (including the infra one) is still retained for the report table
    expect(report.results).toHaveLength(3);
  });

  it("aggregate reports zero infraErrors on a fully clean run", () => {
    const report = aggregate([
      scoreTask({ id: "a", input: "hi", expectedRoute: "research" }, obs({ route: "research" })),
    ]);
    expect(report.infraErrors).toBe(0);
    expect(report.routing.total).toBe(1);
  });
});

// ── isInfraError narrowing (docs/EVAL-AUDIT-2026-08-28.md D5) ────────────────────
// The old version treated ANY non-empty error string as infrastructure, which
// laundered a real behavioural crash (an unbounded worker loop hitting
// LangGraph's recursion limit) into an exclusion — the published report was
// flattered by three genuine failures being hidden, not just deflated by fifteen
// harness bugs. A GraphRecursionError must count as a real capability miss.

describe("isInfraError — narrowed to real infra shapes", () => {
  it("classifies a genuine provider outage as infra", () => {
    expect(isInfraError(obs({ error: "503 Service Unavailable" }))).toBe(true);
    expect(isInfraError(obs({ error: "GoogleGenerativeAI Error: [429 Too Many Requests]" }))).toBe(true);
    expect(isInfraError(obs({ error: "fetch failed" }))).toBe(true);
    expect(isInfraError(obs({ error: "socket hang up" }))).toBe(true);
  });

  it("classifies the per-call timeout (ModelCallTimeoutError's message) as infra", () => {
    // Exact wording from src/gateway/model-deadline.ts — the structured `.code
    // === \"ETIMEDOUT\"` property does not survive being flattened to a plain
    // string message by the invoker's catch, so the message text itself must
    // be recognizable.
    expect(isInfraError(obs({ error: "Model call exceeded 45000ms (planner) — treating as a transport timeout." }))).toBe(true);
  });

  it("classifies a retry-budget-exhausted message as infra", () => {
    expect(isInfraError(obs({ error: "Retry budget exhausted — surfacing the provider error to the fallback chain" }))).toBe(true);
  });

  it("does NOT classify a GraphRecursionError as infra — it is a behavioural failure", () => {
    // Exact wording LangGraph throws (node_modules/@langchain/langgraph/dist/pregel/index.js).
    const message =
      'Recursion limit of 25 reached without hitting a stop condition. You can increase the ' +
      'limit by setting the "recursionLimit" config key.';
    expect(isInfraError(obs({ error: message }))).toBe(false);
  });

  it("does NOT classify an ordinary planning/validation failure message as infra", () => {
    expect(isInfraError(obs({ error: "Planner did not return JSON." }))).toBe(false);
    expect(isInfraError(obs({ error: "Worker did not finalize with JSON for \"text.summary\"." }))).toBe(false);
  });

  it("is false when there is no error at all", () => {
    expect(isInfraError(obs({}))).toBe(false);
    expect(isInfraError(obs({ error: "" }))).toBe(false);
  });
});
