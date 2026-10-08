/**
 * Unit test — the planner sees other agents' recent work (AG-029).
 * The block follows the screen block in the planner's system message, only for the thread the source applies to,
 * and a failing reader leaves the prompt exactly as it was.
 */
import { describe, it, expect } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { makePlanNode, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";
import { RECENT_ACTIVITY_HEADER, type RecentActivitySource } from "../../../src/kernel/recent-activity.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const catalog: WorkerCatalogEntry[] = [
  { id: "engineering", description: "repos and PRs", toolNames: ["repo_status"], gatedToolNames: [] },
];
const frozen = new Date("2026-10-06T10:00:00Z");

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

const rows = [{ at: new Date("2026-10-05T16:00:00Z"), origin: "mac-claude", project: "founderos", title: "Wired the recall block", content: "x" }];
const founderOnly: RecentActivitySource = { appliesTo: (t) => t === "turicks:111", recent: async () => rows };

async function planOn(thread: string, source: RecentActivitySource) {
  const { model, calls } = capturingModel();
  const plan = makePlanNode(model, catalog, () => frozen, [], undefined, undefined, new Set(), { recentActivity: source });
  await plan(freshState("continue where we left off"), { configurable: { thread_id: thread } });
  return systemText(calls[0]!);
}

describe("makePlanNode — recent activity block", () => {
  it("puts the dated lines into the founder DM's system message", async () => {
    const text = await planOn("turicks:111", founderOnly);
    expect(text).toContain(RECENT_ACTIVITY_HEADER);
    expect(text).toContain("05 Oct 21:30 IST · mac-claude · founderos · Wired the recall block");
  });
  it("a group thread gets no block", async () => {
    expect(await planOn("turicks:-5319642142", founderOnly)).not.toContain(RECENT_ACTIVITY_HEADER);
  });
  it("a reader that throws leaves the prompt identical to having no source", async () => {
    const broken: RecentActivitySource = { appliesTo: () => true, recent: async () => { throw new Error("db down"); } };
    const none = capturingModel();
    await makePlanNode(none.model, catalog, () => frozen)(freshState("hi"), { configurable: { thread_id: "turicks:111" } });
    const failed = await planOn("turicks:111", broken);
    expect(systemText(none.calls[0]!)).toBe(failed);
  });
});
