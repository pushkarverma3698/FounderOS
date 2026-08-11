/**
 * Ironclad — agent node forces a finalize when the tool budget is spent.
 * LIVE 2026-07-13: the admin worker exhausted its tool calls then returned an
 * EMPTY terminal message → collect() could only report "Worker did not
 * finalize with JSON for text.summary". The budget-exhausted turn now carries
 * an explicit, transient finalize nudge (never stored to scratch).
 */

import { describe, it, expect } from "vitest";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
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
    return new AIMessage(JSON.stringify({ text: "finalized from tool results" }));
  }
}

const step: TaskEnvelope = TaskEnvelopeSchema.parse({
  step_id: "s1",
  worker: "research",
  objective: "Research what Linear does and summarize it",
  inputs: {},
  expected: { kind: "data", schema_ref: "text.summary" },
  constraints: { max_tool_calls: 1, hitl_required: false },
});

const spec: WorkerSpec = { id: "research", description: "d", prompt: "You are research.", tools: [] };

const stateWith = (scratch: BaseMessage[]): KernelStateType =>
  ({
    mission: { goal: "g", status: "executing", plan: { schema_version: 1, goal: "g", steps: [step] }, cursor: 0 },
    results: [],
    attempts: {},
    scratch: { s1: scratch },
    step_receipts: { s1: [] },
    failure: null,
    reply: "",
  }) as unknown as KernelStateType;

const toolMsg = (content: string): BaseMessage =>
  new ToolMessage({ content, tool_call_id: "c1", name: "search_web" });

describe("makeAgentNode — budget-exhausted finalize nudge", () => {
  it("appends an explicit finalize nudge once the tool budget is spent", async () => {
    const model = new Recorder();
    const agent = makeAgentNode(model, { research: spec });
    // One executed tool call already recorded (cap = 1) → remaining 0.
    const scratch = [new HumanMessage("envelope"), toolMsg("some tool output")];

    await agent(stateWith(scratch));

    const sent = model.received[0]!;
    const nudge = sent.find(
      (m) => m instanceof HumanMessage && String(m.content).includes("no tool calls left"),
    );
    expect(nudge).toBeDefined();
    expect(String(nudge!.content)).toContain("never return an empty message");
    expect(String(nudge!.content)).toContain("text.summary");
  });

  it("does NOT nudge before any tool has run (fresh step, budget intact)", async () => {
    const model = new Recorder();
    const agent = makeAgentNode(model, { research: spec });
    await agent(stateWith([new HumanMessage("envelope")]));

    const sent = model.received[0]!;
    expect(sent.some((m) => String(m.content).includes("no tool calls left"))).toBe(false);
  });

  it("the nudge is transient — it is never written back into scratch", async () => {
    const model = new Recorder();
    const agent = makeAgentNode(model, { research: spec });
    const update = await agent(stateWith([new HumanMessage("envelope"), toolMsg("out")]));

    const scratch = update.scratch as Record<string, unknown> | undefined;
    const appended = scratch?.["s1"] as { set?: BaseMessage[] } | BaseMessage[] | undefined;
    const written = Array.isArray(appended) ? appended : (appended?.set ?? []);
    // Only the model's response is appended — no nudge leaks into checkpointed state.
    expect(written).toHaveLength(1);
    expect(written[0]).toBeInstanceOf(AIMessage);
  });
});
