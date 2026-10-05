/**
 * P2-7 wiring: the guard runs on BOTH paths that write the founder's reply as model
 * prose — the planner's direct reply and the synthesizer. (The pure function is
 * pinned in promise-guard.test.ts.)
 */

import { describe, it, expect } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { makePlanNode, type KernelChatModel } from "../../../src/kernel/planner.js";
import { makeSynthesizeNode } from "../../../src/kernel/synthesizer.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

function scripted(content: string): KernelChatModel {
  return { invoke: async (_messages: BaseMessage[]) => new AIMessage({ content }) };
}

const CATALOG = [{ id: "research" as const, description: "research", toolNames: ["search_web"], gatedToolNames: [] }];

function planState(input: string): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "1", received_at: new Date().toISOString(), raw_input: input },
    mission: { goal: "", status: "planning", plan: null, cursor: 0 },
    results: [],
    attempts: {},
    scratch: {},
    step_receipts: {},
    failure: null,
    reply: "",
    last_turn: null,
    history: [],
  } as unknown as KernelStateType;
}

describe("false-promise guard is wired into the reply paths", () => {
  it("synthesizer: a model-written promise with no watcher receipt does not reach the founder", async () => {
    const synthesize = makeSynthesizeNode(scripted("Issue #762 is dispatched as task 76. I'll monitor it and keep you posted."));
    const state = {
      mission: { goal: "dispatch #762", status: "synthesizing", plan: null, cursor: 1 },
      results: [],
    } as unknown as KernelStateType;
    const update = await synthesize(state);
    expect(update.reply).toBe("Issue #762 is dispatched as task 76.");
  });

  it("planner: a direct reply promising to monitor is stripped (no tool ran, so no watcher)", async () => {
    const plan = makePlanNode(
      scripted(JSON.stringify({ type: "reply", text: "Got it! I'll monitor Issue #762 and keep you posted." })),
      CATALOG,
    );
    const update = await plan(planState("watch issue 762"));
    expect(update.reply).toBe("Got it!");
  });
});
