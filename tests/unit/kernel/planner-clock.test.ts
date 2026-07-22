/**
 * Unit test — the planner is told the founder's current time.
 * This is the keystone: without an injected clock the planner guesses the date
 * AND the zone when resolving "tomorrow 9am", so reminders/tasks fire wrong.
 * The clock is injected (frozen here) so plans stay deterministic in CI.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { makePlanNode, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const catalog: WorkerCatalogEntry[] = [
  { id: "admin", description: "reminders + scheduling", toolNames: ["set_reminder", "schedule_task"], gatedToolNames: [] },
];

const frozen = new Date("2026-07-22T13:00:00Z"); // 18:30 IST

function freshState(input: string): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "c1", received_at: "", raw_input: input },
    last_turn: { id: "", chat_id: "", received_at: "", raw_input: "" },
    reply: "",
    history: [],
  } as unknown as KernelStateType;
}

describe("makePlanNode — current-time injection", () => {
  it("puts the founder's IST now into the planner's system messages", async () => {
    let captured: BaseMessage[] = [];
    const model = {
      invoke: async (msgs: BaseMessage[]) => {
        captured = msgs;
        return new AIMessage('{"type":"reply","text":"noted"}');
      },
    };

    const plan = makePlanNode(model, catalog, () => frozen);
    await plan(freshState("remind me to call the accountant tomorrow at 9"));

    const systemTexts = captured
      .filter((m): m is SystemMessage => m instanceof SystemMessage)
      .map((m) => String(m.content));

    expect(systemTexts.some((t) => t.includes("Current time:") && t.includes("UTC+05:30"))).toBe(true);
  });
});
