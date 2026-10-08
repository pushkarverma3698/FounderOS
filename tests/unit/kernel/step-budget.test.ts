/**
 * Per-step tool budget (AG-035, reworked): code sets it by step class, the planner's number is ignored.
 * Read-only steps get 20 calls; anything that can write or needs approval gets 10.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { TaskEnvelopeSchema, MAX_TOOL_CALLS_PER_STEP, type TaskEnvelope, type StepResult } from "../../../src/kernel/contracts.js";
import {
  clampStep,
  clampStepCalls,
  capReachedNote,
  MAX_READ_TOOL_CALLS_PER_STEP,
} from "../../../src/kernel/step-budget.js";
import { MAX_ATTEMPTS_PER_STEP, dispatch } from "../../../src/kernel/supervisor.js";
import { OFFICE_RECURSION_LIMIT_DEFAULT } from "../../../src/core/config.js";
import { collect } from "../../../src/kernel/worker.js";
import { budgetNotesBlock } from "../../../src/kernel/synthesizer.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const envelope = (max: number, over: Record<string, unknown> = {}, constraints: Record<string, unknown> = {}): TaskEnvelope =>
  TaskEnvelopeSchema.parse({
    step_id: "s1",
    worker: "engineering",
    objective: "Why does the retry loop stop early",
    inputs: {},
    expected: { kind: "data", schema_ref: "text.summary" },
    constraints: { max_tool_calls: max, hitl_required: false, ...constraints },
    ...over,
  });

const action = { expected: { kind: "action_receipt", schema_ref: "action.summary" } };

describe("envelope contract", () => {
  it("fixes the caps at 10 for write steps and 20 for read steps", () => {
    expect(MAX_TOOL_CALLS_PER_STEP).toBe(10);
    expect(MAX_READ_TOOL_CALLS_PER_STEP).toBe(20);
  });

  it("still parses whatever number the planner wrote, because code overrides it", () => {
    expect(() => envelope(1)).not.toThrow();
    expect(() => envelope(99)).not.toThrow();
  });

  it("parses a step whose planner left max_tool_calls out", () => {
    const step = TaskEnvelopeSchema.parse({
      step_id: "s1",
      worker: "engineering",
      objective: "Close the stale issues",
      expected: { kind: "data", schema_ref: "text.summary" },
      constraints: { hitl_required: false },
    });
    expect(clampStep(step).constraints.max_tool_calls).toBe(MAX_READ_TOOL_CALLS_PER_STEP);
  });
});

describe("recursion limit covers the caps", () => {
  it("fits MAX_ATTEMPTS_PER_STEP attempts of the largest step (dispatch + agent/tools hops + final turn + collect)", () => {
    const worst = Math.max(MAX_READ_TOOL_CALLS_PER_STEP, MAX_TOOL_CALLS_PER_STEP);
    const perAttempt = 1 + 2 * worst + 2;
    expect(OFFICE_RECURSION_LIMIT_DEFAULT).toBeGreaterThanOrEqual(MAX_ATTEMPTS_PER_STEP * perAttempt + 4);
  });
});

describe("clampStep: the budget comes from the step class, not from the planner", () => {
  it("gives a read-only step the read cap when the planner asked for 3", () => {
    expect(clampStepCalls(envelope(3))).toBe(MAX_READ_TOOL_CALLS_PER_STEP);
    expect(clampStep(envelope(3)).constraints.max_tool_calls).toBe(20);
  });

  it("gives a HITL-required step the write cap when the planner asked for 3", () => {
    expect(clampStep(envelope(3, {}, { hitl_required: true })).constraints.max_tool_calls).toBe(10);
  });

  it("gives an action_receipt step the write cap when the planner asked for 3", () => {
    expect(clampStep(envelope(3, action)).constraints.max_tool_calls).toBe(10);
  });

  it("never lets a write step exceed the write cap, whatever the planner asked", () => {
    for (const asked of [1, 10, 20, 99]) {
      expect(clampStepCalls(envelope(asked, {}, { hitl_required: true }))).toBe(10);
      expect(clampStepCalls(envelope(asked, action))).toBe(10);
    }
  });

  it("never lets a read step exceed the read cap", () => {
    expect(clampStepCalls(envelope(99))).toBe(20);
  });

  it("returns the same object when the cap already matches", () => {
    const step = envelope(20);
    expect(clampStep(step)).toBe(step);
  });
});

const stateFor = (step: TaskEnvelope, scratch: Array<AIMessage | ToolMessage> = []): KernelStateType =>
  ({
    mission: { goal: "g", status: "executing", plan: { schema_version: 1, goal: "g", steps: [step] }, cursor: 0 },
    results: [],
    attempts: {},
    scratch: { s1: scratch },
    step_receipts: { s1: [] },
    failure: null,
    reply: "",
  }) as unknown as KernelStateType;

const budgetOf = (u: ReturnType<typeof dispatch>): number | undefined => {
  const mission = u.mission as unknown as { plan?: { steps: TaskEnvelope[] } } | undefined;
  return mission?.plan?.steps[0]?.constraints.max_tool_calls;
};

describe("dispatch", () => {
  it("sets the budget by class whatever the planner asked", () => {
    expect(budgetOf(dispatch(stateFor(envelope(3, {}, { hitl_required: true }))))).toBe(10);
    expect(budgetOf(dispatch(stateFor(envelope(15, {}, { hitl_required: true }))))).toBe(10);
    expect(budgetOf(dispatch(stateFor(envelope(3))))).toBe(20);
  });
});

describe("cap reached note", () => {
  it("names the unanswered objective and reaches the reply", async () => {
    const step = envelope(1);
    const call = new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "github_read", args: {} }] });
    const state = stateFor(step, [call, new ToolMessage({ content: "ok", tool_call_id: "c1" }), new AIMessage("{\"text\":\"partial\"}")]);
    (state as unknown as { step_receipts: Record<string, unknown[]> }).step_receipts["s1"] = [];
    const update = await collect(state);
    const result = (update.results as StepResult[])[0];
    expect(result?.status).toBe("ok");
    if (result?.status === "ok") {
      expect(result.note).toBe(capReachedNote(step));
      expect(result.note).toContain("Why does the retry loop stop early");
      expect(budgetNotesBlock([result])).toContain("Note: Tool budget reached");
    }
  });

  it("adds nothing when no step hit its cap", () => {
    expect(budgetNotesBlock([])).toBe("");
  });
});
