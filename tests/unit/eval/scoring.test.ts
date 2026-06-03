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
