/**
 * Unit test — the planner sees the founder's screen.
 * 2026-10-04 13:45 agent-dispatch alerted "#76/PR #79 … blocked"; at 13:46 the founder asked which
 * repository "these" PRs were on and got "All on FounderOS", a guess. The fix: the plan node reads the
 * thread's recent screen entries and puts them in its system message, after the clock line.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { makePlanNode, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";
import type { ScreenSource } from "../../../src/kernel/screen.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const catalog: WorkerCatalogEntry[] = [
  { id: "engineering", description: "repos and PRs", toolNames: ["repo_status"], gatedToolNames: [] },
];
const frozen = new Date("2026-10-04T13:46:06Z");

function freshState(input: string): KernelStateType {
  return {
    turn: { id: "t1", chat_id: "111", received_at: "", raw_input: input },
    last_turn: { id: "", chat_id: "", received_at: "", raw_input: "" },
    reply: "",
    history: [],
  } as unknown as KernelStateType;
}

function capturingModel() {
  const calls: BaseMessage[][] = [];
  return {
    calls,
    model: {
      invoke: async (msgs: BaseMessage[]) => {
        calls.push(msgs);
        return new AIMessage('{"type":"reply","text":"ok"}');
      },
    },
  };
}

const systemText = (msgs: BaseMessage[]) =>
  msgs.filter((m): m is SystemMessage => m instanceof SystemMessage).map((m) => String(m.content)).join("\n");

describe("makePlanNode — founder screen", () => {
  it("puts this thread's recent alerts into the planner's system message, after the clock line", async () => {
    const asked: string[] = [];
    const screen: ScreenSource = {
      recent: async (threadId) => {
        asked.push(threadId);
        return [{ ts: "2026-10-04T13:45:15Z", chat: "111", src: "agent-dispatch", text: "🛑 pushkarverma3698/oplify-api #76/PR #79 blocked" }];
      },
    };
    const { model, calls } = capturingModel();
    const plan = makePlanNode(model, catalog, () => frozen, [], undefined, screen);
    await plan(freshState("What repository are these PRs on?"), { configurable: { thread_id: "turicks:111" } });

    const text = systemText(calls[0]!);
    expect(asked).toEqual(["turicks:111"]);
    expect(text).toContain("pushkarverma3698/oplify-api #76/PR #79");
    expect(text.indexOf("Current time:")).toBeLessThan(text.indexOf("<founder-screen>"));
  });

  it("sends the unchanged prompt when there is no screen source or nothing on screen", async () => {
    const a = capturingModel();
    await makePlanNode(a.model, catalog, () => frozen)(freshState("hi"), { configurable: { thread_id: "turicks:111" } });
    const b = capturingModel();
    const empty: ScreenSource = { recent: async () => [] };
    await makePlanNode(b.model, catalog, () => frozen, [], undefined, empty)(freshState("hi"), {
      configurable: { thread_id: "turicks:111" },
    });
    expect(systemText(b.calls[0]!)).toBe(systemText(a.calls[0]!));
    expect(systemText(a.calls[0]!)).not.toContain("founder-screen");
  });

  it("still plans when reading the screen fails", async () => {
    const broken: ScreenSource = {
      recent: async () => {
        throw new Error("disk gone");
      },
    };
    const { model, calls } = capturingModel();
    const out = await makePlanNode(model, catalog, () => frozen, [], undefined, broken)(freshState("hi"), {
      configurable: { thread_id: "turicks:111" },
    });
    expect(calls).toHaveLength(1);
    expect(out.reply).toBe("ok");
  });
});
