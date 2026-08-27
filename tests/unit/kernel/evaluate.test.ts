/**
 * The evaluate node — the hook that makes answer scoring happen at all.
 * ======================================================================
 * It is the terminal node after `synthesize`. Two properties must hold or the
 * whole feature is either useless or harmful:
 *
 *  1. It returns an EMPTY update. If it ever wrote a state channel it could alter
 *     the founder's reply, which would make it a guard — the one thing this must
 *     never be. A `revise`-grade verdict is recorded, never enforced.
 *  2. A planned step with no result is carried into the evaluation as an explicit
 *     "no result" marker, not dropped. Dropping it would shrink the plan the judge
 *     sees and make an unaddressed step invisible — the completeness dimension
 *     exists precisely to catch that.
 */

import { describe, it, expect } from "vitest";
import { toCompletedTurn, makeEvaluateNode } from "../../../src/kernel/evaluate.js";
import type { NewAnswerEvaluation } from "../../../src/db/schema.js";
import { TaskEnvelopeSchema, type TaskEnvelope, type StepResult } from "../../../src/kernel/contracts.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const envelope = (over: Partial<TaskEnvelope> = {}): TaskEnvelope =>
  TaskEnvelopeSchema.parse({
    step_id: "s1",
    worker: "research",
    objective: "Research what Linear does and summarize it",
    inputs: {},
    expected: { kind: "data", schema_ref: "text.summary" },
    constraints: { max_tool_calls: 2, hitl_required: false },
    ...over,
  });

const stateWith = (steps: TaskEnvelope[], results: StepResult[], reply: string): KernelStateType =>
  ({
    turn: { id: "turn-7", chat_id: "chat-9", received_at: "2026-08-19T00:00:00.000Z", raw_input: "hi" },
    mission: { goal: "Summarize Linear", status: "done", plan: { schema_version: 1, goal: "Summarize Linear", steps }, cursor: 0 },
    results,
    attempts: {},
    scratch: {},
    step_receipts: {},
    failure: null,
    reply,
  }) as unknown as KernelStateType;

describe("toCompletedTurn", () => {
  it("carries the goal, the reply and one entry per PLANNED step", () => {
    const state = stateWith(
      [envelope()],
      [{ status: "ok", step_id: "s1", output: { text: "Linear tracks issues." }, tool_receipts: [] }],
      "Linear tracks issues.",
    );
    const turn = toCompletedTurn(state);
    expect(turn.turnId).toBe("turn-7");
    expect(turn.threadId).toBe("chat-9");
    expect(turn.goal).toBe("Summarize Linear");
    expect(turn.reply).toBe("Linear tracks issues.");
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0]).toMatchObject({ stepId: "s1", status: "ok" });
    expect(turn.steps[0]!.output).toContain("Linear tracks issues.");
  });

  it("does NOT drop a planned step that produced no result — it marks it", () => {
    const state = stateWith([envelope(), envelope({ step_id: "s2" })], [], "Here you go.");
    const turn = toCompletedTurn(state);
    expect(turn.steps).toHaveLength(2);
    expect(turn.steps[1]).toMatchObject({ stepId: "s2", status: "failed" });
    expect(turn.steps[1]!.output).toMatch(/no result was produced/i);
  });

  it("carries a failed step's real component and message, not just 'failed'", () => {
    const state = stateWith(
      [envelope()],
      [{
        status: "failed",
        step_id: "s1",
        failure: { step_id: "s1", stage: "tool", component: "src/tools/email.ts", message: "SMTP 550", retryable: false },
        tool_receipts: [],
      }],
      "I could not send it.",
    );
    const turn = toCompletedTurn(state);
    expect(turn.steps[0]!.output).toContain("src/tools/email.ts");
    expect(turn.steps[0]!.output).toContain("SMTP 550");
  });
});

describe("makeEvaluateNode", () => {
  /** Fake judge + fake writer: a unit test needs neither a model nor a database. */
  const fakes = (rows: NewAnswerEvaluation[]) => ({
    judge: async () =>
      ({ status: "evaluated", scores: { groundedness: 20, relevance: 90, completeness: 90, critique: "Unbacked claim." } }) as const,
    write: async (row: NewAnswerEvaluation) => { rows.push(row); },
  });

  it("returns an EMPTY update — a low score cannot alter the reply the founder receives", async () => {
    const rows: NewAnswerEvaluation[] = [];
    const state = stateWith(
      [envelope()],
      [{ status: "ok", step_id: "s1", output: { text: "ok" }, tool_receipts: [] }],
      "Linear tracks issues.",
    );

    expect(makeEvaluateNode(fakes(rows))(state)).toEqual({});
    expect(state.reply).toBe("Linear tracks issues.");

    await new Promise((r) => setTimeout(r, 0));
    // The verdict was RECORDED, not enforced: groundedness 20 and the reply unchanged.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.groundedness).toBe(20);
  });

  it("does not evaluate an empty reply — there is no answer to score", async () => {
    const rows: NewAnswerEvaluation[] = [];
    expect(makeEvaluateNode(fakes(rows))(stateWith([envelope()], [], ""))).toEqual({});
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toHaveLength(0);
  });
});
