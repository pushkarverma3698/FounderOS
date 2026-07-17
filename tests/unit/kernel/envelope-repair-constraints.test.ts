/**
 * REGRESSION — planner constraints dropped by a live model must be repaired,
 * not rejected as a terminal planning failure.
 *
 * Live trace (prod, 2026-07-17 13:09 UTC, AGENT_MODEL=gemini-3-flash-preview,
 * H01 hard-battery task): the planner emitted a valid 3-step plan but omitted
 * `constraints.hitl_required` on steps 0–1 and the whole `constraints` object
 * on step 2. main's TaskEnvelopeSchema (plain z.object) rejected it —
 * "Invalid planner decision — plan.steps.0.constraints.hitl_required:
 * Required; …" — and the founder's turn died at stage "plan".
 *
 * The fix (beta): TaskEnvelopeSchema wraps repairEnvelopeConstraints in a
 * z.preprocess so the deterministic repair runs BEFORE field validation.
 * These tests pin that wiring: they fail on any schema that validates
 * constraints without repairing first.
 */

import { describe, it, expect } from "vitest";
import { validatePlannerDecision, MAX_TOOL_CALLS_PER_STEP } from "../../../src/kernel/contracts.js";
import { DEFAULT_STEP_MAX_TOOL_CALLS } from "../../../src/kernel/envelope-repair.js";

const KERNEL_SCHEMA_VERSION = 1;

function step(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    step_id: id,
    worker: "research",
    objective: "Compare LangGraph and the OpenAI Agents SDK for Turicks.",
    inputs: {},
    expected: { kind: "data", schema_ref: "research.findings" },
    ...overrides,
  };
}

function decisionWith(steps: Record<string, unknown>[]): unknown {
  return {
    type: "plan",
    plan: { schema_version: KERNEL_SCHEMA_VERSION, goal: "compare frameworks", steps },
  };
}

describe("planner constraints repair wiring (live 2026-07-17 regression)", () => {
  it("accepts a step whose constraints omit hitl_required (repaired to false for data steps)", () => {
    const res = validatePlannerDecision(
      decisionWith([step("s1", { constraints: { max_tool_calls: 2 } })]),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.value.type === "plan") {
      expect(res.value.plan.steps[0]?.constraints).toEqual({
        max_tool_calls: 2,
        hitl_required: false,
      });
    }
  });

  it("accepts a step with no constraints object at all (both fields defaulted)", () => {
    const res = validatePlannerDecision(decisionWith([step("s1", {})]));
    expect(res.ok).toBe(true);
    if (res.ok && res.value.type === "plan") {
      expect(res.value.plan.steps[0]?.constraints).toEqual({
        max_tool_calls: DEFAULT_STEP_MAX_TOOL_CALLS,
        hitl_required: false,
      });
    }
  });

  it("repairs a dropped hitl_required to TRUE on action_receipt steps (fail safe, never auto-approve)", () => {
    const res = validatePlannerDecision(
      decisionWith([
        step("s1", {
          worker: "comms",
          expected: { kind: "action_receipt", schema_ref: "action.summary" },
          constraints: { max_tool_calls: 1 },
        }),
      ]),
    );
    expect(res.ok).toBe(true);
    if (res.ok && res.value.type === "plan") {
      expect(res.value.plan.steps[0]?.constraints.hitl_required).toBe(true);
    }
  });

  it("leaves a fully-formed constraints object byte-identical (determinism)", () => {
    const constraints = { max_tool_calls: MAX_TOOL_CALLS_PER_STEP, hitl_required: true };
    const res = validatePlannerDecision(decisionWith([step("s1", { constraints })]));
    expect(res.ok).toBe(true);
    if (res.ok && res.value.type === "plan") {
      expect(res.value.plan.steps[0]?.constraints).toEqual(constraints);
    }
  });
});
