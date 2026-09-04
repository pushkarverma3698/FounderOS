/**
 * Per-turn prompt override (T4, 2026-09-05).
 *
 * The kernel compiles once and reuses every WorkerSpec forever (rule #2), so
 * the jobhunt worker's system prompt — baked in at boot — always named the
 * default profile. A `/wife_draft` fallback draft (tailoring failed
 * validation, so the turn fell through to a free-text kernel draft) came back
 * signed with the WRONG candidate's name, because the worker had no way to
 * know the turn was about the second profile's row.
 *
 * `promptForProfile` is the fix: an optional per-turn override on WorkerSpec,
 * driven by `configurable.profile_id` (the same per-invocation channel
 * `thread_id` already rides) — no kernel rebuild required.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { makeAgentNode, type KernelBindableModel, type WorkerSpec } from "../../../src/kernel/worker.js";
import { TaskEnvelopeSchema, type TaskEnvelope } from "../../../src/kernel/contracts.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

class Recorder implements KernelBindableModel {
  received: BaseMessage[][] = [];
  bindTools(): Recorder {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.received.push(messages);
    return new AIMessage("ok");
  }
}

const step: TaskEnvelope = TaskEnvelopeSchema.parse({
  step_id: "s1",
  worker: "jobhunt",
  objective: "Draft a tailored application",
  inputs: {},
  expected: { kind: "data", schema_ref: "text.summary" },
  constraints: { max_tool_calls: 1, hitl_required: false },
});

const spec: WorkerSpec = {
  id: "jobhunt",
  description: "d",
  prompt: "You are the Job-Hunt department for Pushkar Verma.",
  promptForProfile: (profileId: string) =>
    profileId === "wife-nl-finance"
      ? "You are the Job-Hunt department for Tashi Goyal."
      : "You are the Job-Hunt department for Pushkar Verma.",
  tools: [],
};

const state: KernelStateType = {
  mission: { goal: "g", status: "executing", plan: { schema_version: 1, goal: "g", steps: [step] }, cursor: 0 },
  results: [],
  attempts: {},
  scratch: { s1: [new HumanMessage("envelope")] },
  step_receipts: { s1: [] },
  failure: null,
  reply: "",
} as unknown as KernelStateType;

function systemMessageOf(model: Recorder): string {
  const sent = model.received[0]!;
  const sys = sent.find((m) => m instanceof SystemMessage);
  return String(sys!.content);
}

describe("makeAgentNode — per-turn profile prompt override", () => {
  it("uses promptForProfile when config.configurable.profile_id names a profile", async () => {
    const model = new Recorder();
    const agent = makeAgentNode(model, { jobhunt: spec });

    await agent(state, { configurable: { profile_id: "wife-nl-finance" } });

    expect(systemMessageOf(model)).toContain("Tashi Goyal");
    expect(systemMessageOf(model)).not.toContain("Pushkar Verma");
  });

  it("falls back to the baked-in spec.prompt when no config is given at all", async () => {
    const model = new Recorder();
    const agent = makeAgentNode(model, { jobhunt: spec });

    await agent(state);

    expect(systemMessageOf(model)).toContain("Pushkar Verma");
  });

  it("falls back to spec.prompt when config carries no profile_id", async () => {
    const model = new Recorder();
    const agent = makeAgentNode(model, { jobhunt: spec });

    await agent(state, { configurable: { thread_id: "turicks:1" } });

    expect(systemMessageOf(model)).toContain("Pushkar Verma");
  });

  it("falls back to spec.prompt for a worker with no promptForProfile at all — every other department, unaffected", async () => {
    const plainSpec: WorkerSpec = { id: "research", description: "d", prompt: "You are research.", tools: [] };
    const researchStep = TaskEnvelopeSchema.parse({ ...step, worker: "research" });
    const researchState = {
      ...state,
      mission: { ...state.mission, plan: { schema_version: 1, goal: "g", steps: [researchStep] } },
    } as KernelStateType;
    const model = new Recorder();
    const agent = makeAgentNode(model, { research: plainSpec });

    // Even a profile_id present in config must not affect a worker that never
    // opted in — promptForProfile is undefined on this spec.
    await agent(researchState, { configurable: { profile_id: "wife-nl-finance" } });

    expect(systemMessageOf(model).startsWith("You are research.")).toBe(true);
  });
});
