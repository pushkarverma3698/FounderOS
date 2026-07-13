import { describe, it, expect } from "vitest";
import { dispatch } from "../../../src/kernel/supervisor.js";
import { TaskEnvelopeSchema, type TaskEnvelope } from "../../../src/kernel/contracts.js";
import type { KernelStateType, StepResult } from "../../../src/kernel/index.js";

const makeEnvelope = (id: string, deps: string[] = []): TaskEnvelope =>
  TaskEnvelopeSchema.parse({
    step_id: id,
    worker: "research",
    objective: `Run task ${id}`,
    inputs: {},
    dependencies: deps,
    expected: { kind: "data", schema_ref: "text.summary" },
    constraints: { max_tool_calls: 1, hitl_required: false },
  });

const makeOkResult = (id: string): StepResult => ({
  status: "ok",
  step_id: id,
  output: { text: `done ${id}` },
  tool_receipts: [],
});

const stateWith = (steps: TaskEnvelope[], results: StepResult[]): KernelStateType =>
  ({
    turn: { id: "t1", chat_id: "1", received_at: "", raw_input: "x" },
    mission: {
      goal: "g",
      status: "planning",
      plan: { schema_version: 1, goal: "g", steps },
      cursor: 0,
    },
    results,
    attempts: {},
    failure: null,
    scratch: {},
    step_receipts: {},
    reply: "",
  }) as unknown as KernelStateType;

describe("supervisor dispatch dependencies", () => {
  it("executes the first step when there are no dependencies", () => {
    const s1 = makeEnvelope("s1");
    const s2 = makeEnvelope("s2", ["s1"]);
    const state = stateWith([s1, s2], []);

    const update = dispatch(state);
    expect(update.mission?.cursor).toBe(0);
    expect(update.mission?.status).toBe("executing");
    // Seeds s1 scratchpad
    expect((update.scratch as Record<string, any>)["s1"]).toBeDefined();
  });

  it("skips s2 and executes s1 if s1 is not done yet", () => {
    const s1 = makeEnvelope("s1");
    const s2 = makeEnvelope("s2", ["s1"]);
    const state = stateWith([s1, s2], []);
    
    const update = dispatch(state);
    expect(update.mission?.cursor).toBe(0);
  });

  it("executes s2 when s1 is completed successfully", () => {
    const s1 = makeEnvelope("s1");
    const s2 = makeEnvelope("s2", ["s1"]);
    const state = stateWith([s1, s2], [makeOkResult("s1")]);

    const update = dispatch(state);
    expect(update.mission?.cursor).toBe(1);
    expect(update.mission?.status).toBe("executing");
    expect((update.scratch as Record<string, any>)["s2"]).toBeDefined();
  });

  it("advances to synthesize when all steps are completed successfully", () => {
    const s1 = makeEnvelope("s1");
    const s2 = makeEnvelope("s2", ["s1"]);
    const state = stateWith([s1, s2], [makeOkResult("s1"), makeOkResult("s2")]);

    const update = dispatch(state);
    expect(update.mission?.status).toBe("synthesizing");
  });
});
