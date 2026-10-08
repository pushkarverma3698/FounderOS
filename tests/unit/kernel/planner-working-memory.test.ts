/**
 * Unit test — the planner sees the founder working memory (AG-032), offline with a scripted model ($0).
 * Covers the thread rules and the three AG-030 understanding cases the block is meant to fix:
 * the planner prompt must carry the fact that case needs (the profile, the open PR, the earlier review).
 */
import { describe, it, expect } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { makePlanNode, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";
import { WORKING_MEMORY_HEADER, type WorkingMemorySource } from "../../../src/kernel/working-memory.js";
import { RECENT_ACTIVITY_HEADER, type RecentActivitySource } from "../../../src/kernel/recent-activity.js";
import { UNDERSTANDING_GOLDEN_TASKS } from "../../../src/eval/understanding-golden.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const catalog: WorkerCatalogEntry[] = [
  { id: "engineering", description: "repos and PRs", toolNames: ["repo_status"], gatedToolNames: [] },
];
const frozen = new Date("2026-10-08T10:00:00Z");
const SLASH = String.fromCharCode(47);
const FOS = ["pushkarverma3698", "FounderOS"].join(SLASH);

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
        return new AIMessage("{\"type\":\"reply\",\"text\":\"ok\"}");
      },
    },
  };
}

const systemText = (msgs: BaseMessage[]) =>
  msgs.filter((m): m is SystemMessage => m instanceof SystemMessage).map((m) => String(m.content)).join("\n");

const day = (hoursAgo: number) => new Date(frozen.getTime() - hoursAgo * 3_600_000);

const memory: WorkingMemorySource = {
  appliesTo: (t) => t === "turicks:111" || t === "turicks:-5319642142",
  people: async () => [
    { name: "Pushkar Verma", profile: "pushkar-nl-tech", founder: true },
    { name: "Tashi", profile: "tashi-finance-nl", founder: false },
  ],
  goals: async () => [{ n: 1, title: "Land 3 NL interviews", dueOn: "2026-11-01", target: 3 }],
  inFlight: async () => ({ items: [{ repo: FOS, kind: "PR", number: 676, title: "render-and-verify gate" }], asOf: day(0.1) }),
  recentTurns: async () => [
    { at: day(30), asked: "Review PR 676", outcome: "done" },
    { at: day(31), asked: "Give me wife fresh jobs", outcome: "done" },
    { at: day(32), asked: "hi", outcome: "replied" },
    { at: day(1), asked: "today ask", outcome: "replied" },
  ],
  standing: async () => [],
};

async function planOn(thread: string, input: string, ctx: Parameters<typeof makePlanNode>[7]) {
  const { model, calls } = capturingModel();
  const plan = makePlanNode(model, catalog, () => frozen, [], undefined, undefined, new Set(), ctx);
  await plan(freshState(input), { configurable: { thread_id: thread } });
  return systemText(calls[0]!);
}

describe("makePlanNode, working memory block", () => {
  it("the founder DM and the family group get it; any other chat does not", async () => {
    expect(await planOn("turicks:111", "hi", { workingMemory: memory })).toContain(WORKING_MEMORY_HEADER);
    expect(await planOn("turicks:-5319642142", "hi", { workingMemory: memory })).toContain(WORKING_MEMORY_HEADER);
    expect(await planOn("turicks:-100200", "hi", { workingMemory: memory })).not.toContain(WORKING_MEMORY_HEADER);
  });

  it("sits before the recent-work block, and both can be present", async () => {
    const recent: RecentActivitySource = {
      appliesTo: () => true,
      recent: async () => [{ at: day(3), origin: "mac-claude", project: "founderos", title: "Wired it", content: "x" }],
    };
    const text = await planOn("turicks:111", "hi", { workingMemory: memory, recentActivity: recent });
    expect(text.indexOf(WORKING_MEMORY_HEADER)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(RECENT_ACTIVITY_HEADER)).toBeGreaterThan(text.indexOf(WORKING_MEMORY_HEADER));
  });

  it("the switch off leaves the prompt exactly as it was without a source", async () => {
    const off = await planOn("turicks:111", "hi", { workingMemory: memory, workingMemoryEnabled: false });
    const none = await planOn("turicks:111", "hi", undefined);
    expect(off).toBe(none);
  });

  it("a source that throws everywhere leaves the prompt exactly as it was without a source", async () => {
    const boom = async (): Promise<never> => { throw new Error("down"); };
    const broken: WorkingMemorySource = { ...memory, people: boom, goals: boom, inFlight: boom, recentTurns: boom, standing: boom };
    expect(await planOn("turicks:111", "hi", { workingMemory: broken })).toBe(await planOn("turicks:111", "hi", undefined));
  });
});

describe("AG-030 understanding cases, planner prompt carries what each one needs", () => {
  const golden = (id: string) => {
    const task = UNDERSTANDING_GOLDEN_TASKS.find((t) => t.id === id);
    if (!task) throw new Error("golden case missing: " + id);
    return task;
  };

  it("und-304 (wife fresh jobs): the second person and her job profile are in the prompt", async () => {
    const text = await planOn("turicks:111", golden("und-304-wife-profile").input, { workingMemory: memory });
    expect(text).toContain("- Tashi — job profile tashi-finance-nl");
  });

  it("und-312 (wife CV and target roles): same profile line is there", async () => {
    const text = await planOn("turicks:111", golden("und-312-wife-cv").input, { workingMemory: memory });
    expect(text).toContain("job profile tashi-finance-nl");
  });

  it("und-363 (own earlier review): the open PR and the dated earlier review ask are in the prompt", async () => {
    const text = await planOn("turicks:111", golden("und-363-own-review").input, { workingMemory: memory });
    expect(text).toContain("PR #676: render-and-verify gate");
    expect(text).toContain("asked: \"Review PR 676\"");
  });
});
