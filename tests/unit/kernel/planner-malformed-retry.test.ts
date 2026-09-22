/**
 * A malformed planner response is transient — retry it instead of charging the
 * founder for it.
 *
 * THE INCIDENT (2026-09-16 19:42–19:51, production). Three times in nine minutes
 * the planner returned something that was not JSON, and each time the founder got:
 *
 *   "⚠️ Task stopped at step 'plan' — planning failure in kernel/planner.
 *    Planner did not return JSON."
 *
 * Each time he typed "Try again" and the identical request succeeded immediately:
 * 19:42 → 19:42, 19:45 → 19:46, 19:51 → 19:51. Three founder-visible failures, a
 * 100% manual-retry success rate, and the failure was reported `retryable: false`.
 *
 * The model is called at temperature 0, so the retry is not a dice roll on the
 * same input — the corrective instruction changes the input, which is why the
 * founder's own "Try again" worked. Doing that in-band costs one extra planner
 * call on a path that currently costs a whole turn plus a human round trip.
 *
 * Bounded at ONE retry: a second identical failure is a real defect (a model that
 * cannot emit the schema, a broken prompt) and must stay loud, not spin.
 */

import { describe, expect, it } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { makePlanNode, type KernelChatModel, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";
import type { KernelStateType, KernelUpdate } from "../../../src/kernel/state.js";
import type { FailureReport, Mission } from "../../../src/kernel/contracts.js";

/**
 * KernelUpdate channels are declared as `Value | OverwriteValue<Value>` so a node
 * can replace a channel instead of reducing into it. The plan node always writes
 * plain values; narrowing here keeps the assertions readable.
 * Same approach as recovery-in-band.test.ts:82.
 */
const missionOf = (u: KernelUpdate) => u.mission as Mission | undefined;
const failureOf = (u: KernelUpdate) => u.failure as FailureReport | null | undefined;

const catalog: WorkerCatalogEntry[] = [
  { id: "engineering", description: "code and repo work", toolNames: ["github_read"], gatedToolNames: [] },
];

const VALID_PLAN = JSON.stringify({
  type: "plan",
  plan: {
    schema_version: 1,
    goal: "check issue 694",
    steps: [
      {
        step_id: "s1",
        worker: "engineering",
        objective: "Read issue 694",
        inputs: {},
        expected: { kind: "data", schema_ref: "text.summary" },
        constraints: { max_tool_calls: 3, hitl_required: false },
      },
    ],
  },
});

function stateFor(input: string): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "c1", received_at: new Date().toISOString(), raw_input: input },
    mission: { goal: "", status: "idle", plan: null, cursor: 0 },
    results: [],
    attempts: {},
    scratch: {},
    step_receipts: {},
    failure: null,
    reply: "",
    history: [],
    last_turn: null,
    lesson_candidate: null,
  } as unknown as KernelStateType;
}

/** Model that returns each scripted response in turn, recording what it was sent. */
function scriptedModel(responses: string[]): KernelChatModel & { calls: BaseMessage[][] } {
  const calls: BaseMessage[][] = [];
  return {
    calls,
    async invoke(messages: BaseMessage[]) {
      calls.push(messages);
      return new AIMessage(responses[calls.length - 1] ?? responses[responses.length - 1]!);
    },
  };
}

describe("plan node — malformed planner response is retried once", () => {
  // Verbatim shape from the 2026-09-16 failures: prose where JSON was required.
  it("recovers from non-JSON prose without the founder seeing a failure", async () => {
    const model = scriptedModel(["Status of Issue #694 (pushkarverma3698/FounderOS): Closed.", VALID_PLAN]);
    const update = await makePlanNode(model, catalog)(stateFor("Where are we on the work on #694 ?"));

    expect(model.calls).toHaveLength(2);
    expect(failureOf(update)).toBeNull();
    expect(missionOf(update)?.status).toBe("executing");
    expect(missionOf(update)?.plan?.steps[0]?.worker).toBe("engineering");
  });

  it("retries a response that parses as JSON but violates the decision schema", async () => {
    const model = scriptedModel([JSON.stringify({ type: "plan", plan: { steps: [] } }), VALID_PLAN]);
    const update = await makePlanNode(model, catalog)(stateFor("Check issue 694"));

    expect(model.calls).toHaveLength(2);
    expect(failureOf(update)).toBeNull();
    expect(missionOf(update)?.status).toBe("executing");
  });

  it("sends a corrective instruction on the retry — not a bare repeat of the same call", async () => {
    const model = scriptedModel(["not json at all", VALID_PLAN]);
    await makePlanNode(model, catalog)(stateFor("Check issue 694"));

    const retry = model.calls[1]!;
    expect(retry.length).toBeGreaterThan(model.calls[0]!.length);
    const last = String(retry[retry.length - 1]!.content);
    expect(last).toMatch(/JSON/i);
  });

  it("reports a typed planning failure when BOTH attempts are malformed — never a third try", async () => {
    const model = scriptedModel(["nope", "still nope"]);
    const update = await makePlanNode(model, catalog)(stateFor("Check issue 694"));

    expect(model.calls).toHaveLength(2);
    expect(failureOf(update)?.stage).toBe("planning");
    expect(failureOf(update)?.component).toBe("kernel/planner");
    expect(missionOf(update)?.status).toBe("failed");
  });

  it("does not call the model twice when the first response is already valid", async () => {
    const model = scriptedModel([VALID_PLAN]);
    const update = await makePlanNode(model, catalog)(stateFor("Check issue 694"));

    expect(model.calls).toHaveLength(1);
    expect(failureOf(update)).toBeNull();
  });

  it("does not retry a direct reply — a valid {type:'reply'} is not a malformed plan", async () => {
    const model = scriptedModel([JSON.stringify({ type: "reply", text: "Hello!" })]);
    const update = await makePlanNode(model, catalog)(stateFor("Hi"));

    expect(model.calls).toHaveLength(1);
    expect(update.reply).toBe("Hello!");
  });
});
