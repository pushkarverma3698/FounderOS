/**
 * Unit test — the "in flight" block (AG-055).
 * Each line comes from a row and names that row's id; the planner gets the block as one more data section;
 * a slow or broken reader yields `in-flight: unavailable` inside the 300 ms budget, never a stalled turn.
 */
import { describe, it, expect } from "vitest";
import { AIMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { makePlanNode, type WorkerCatalogEntry } from "../../../src/kernel/planner.js";
import type { KernelStateType } from "../../../src/kernel/state.js";
import {
  IN_FLIGHT_BUDGET_MS,
  IN_FLIGHT_MAX_LINES,
  IN_FLIGHT_UNAVAILABLE,
  buildInFlight,
  mentionsFrom,
  renderInFlight,
  type InFlightSource,
  type PendingApprovalRow,
  type ReminderDueRow,
  type RecentTurnRow,
} from "../../../src/kernel/in-flight.js";

const now = new Date("2026-10-08T10:00:00Z");
const approval: PendingApprovalRow = {
  id: "af4ea3f4-56d9-4b2d-869e-de812aefe079",
  action: "dispatch_antigravity_task",
  summary: 'Open agent:spec issue on pushkarverma3698/FounderOS: "docs: add a test comment"',
  createdAt: new Date("2026-10-08T09:40:00Z"),
  expiresAt: new Date("2026-10-09T09:40:00Z"),
};
const reminder: ReminderDueRow = {
  id: "8c45a246-a8f9-497d-8166-1960d8ca4ed4",
  text: "Call the recruiter",
  remindAt: new Date("2026-10-08T13:00:00Z"), // in 3 h
};
const turns: RecentTurnRow[] = [
  { turnId: "t-new", occurredAt: new Date("2026-10-08T09:50:00Z"), userInput: "is PR #1006 superseded?", reply: "Yes, by pushkarverma3698/FounderOS#1038." },
  { turnId: "t-old", occurredAt: new Date("2026-10-08T08:00:00Z"), userInput: "look at https://github.com/OplifyMessage/oplify-messaging-api/pull/79", reply: "Read it." },
];

function source(over: Partial<InFlightSource> = {}): InFlightSource {
  return {
    pendingApprovals: async () => [approval],
    remindersDue: async () => [reminder],
    recentTurns: async () => turns,
    ...over,
  };
}

const IDS = { tenantId: "turicks", threadId: "turicks:111" };

describe("buildInFlight", () => {
  it("shows a pending approval card and a reminder due in 3 h, each with its row id", async () => {
    const block = await buildInFlight(source(), IDS, now);
    expect(block).toContain(`approval card ${approval.id}`);
    expect(block).toContain("dispatch_antigravity_task");
    expect(block).toContain(`reminder ${reminder.id}`);
    expect(block).toContain("Call the recruiter");
    expect(block).toContain("in 3 h");
  });

  it("lists PR and issue numbers from recent turns with their repo and turn id, newest first", async () => {
    const block = await buildInFlight(source(), IDS, now);
    expect(block).toContain("pushkarverma3698/FounderOS#1038 · turn t-new");
    expect(block).toContain("OplifyMessage/oplify-messaging-api#79 (PR) · turn t-old");
    expect(block).toContain("#1006 (PR, repo not named) · turn t-new");
  });

  it("passes the tenant and thread to every reader", async () => {
    const seen: string[] = [];
    const spy = source({
      pendingApprovals: async (q) => (seen.push(`a:${q.tenantId}:${q.threadId}`), []),
      remindersDue: async (q) => (seen.push(`r:${q.tenantId}:${q.threadId}:${q.until.toISOString()}`), []),
      recentTurns: async (q) => (seen.push(`t:${q.threadId}:${q.limit}`), []),
    });
    await buildInFlight(spy, IDS, now);
    expect(seen.sort()).toEqual(["a:turicks:turicks:111", "r:turicks:turicks:111:2026-10-09T10:00:00.000Z", "t:turicks:111:20"]);
  });

  it("a reader that never answers gives `in-flight: unavailable` within the budget", async () => {
    const hung = source({ remindersDue: () => new Promise<never>(() => {}) });
    const started = Date.now();
    const block = await buildInFlight(hung, IDS, now);
    expect(block).toBe(IN_FLIGHT_UNAVAILABLE);
    expect(block).toBe("in-flight: unavailable");
    expect(Date.now() - started).toBeLessThan(IN_FLIGHT_BUDGET_MS + 150);
  });

  it("a reader that throws gives `in-flight: unavailable`", async () => {
    const broken = source({ pendingApprovals: async () => { throw new Error("db down"); } });
    expect(await buildInFlight(broken, IDS, now)).toBe(IN_FLIGHT_UNAVAILABLE);
  });

  // src/index.ts treats an unhandled rejection as fatal: a read that fails after the budget must not kill the bot.
  it("a reader that fails after the budget raises no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = source({ pendingApprovals: () => new Promise((_, reject) => setTimeout(() => reject(new Error("pool timeout")), 40)) });
      expect(await buildInFlight(late, IDS, now, 10)).toBe(IN_FLIGHT_UNAVAILABLE);
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("renderInFlight", () => {
  it("never exceeds 25 lines, header included", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...approval, id: `a${i}` }));
    const rems = Array.from({ length: 40 }, (_, i) => ({ ...reminder, id: `r${i}` }));
    const lines = renderInFlight({ approvals: many, reminders: rems, turns }, now).split("\n");
    expect(IN_FLIGHT_MAX_LINES).toBe(25);
    expect(lines.length).toBeLessThanOrEqual(25);
  });

  it("says plainly when nothing is in flight", () => {
    expect(renderInFlight({ approvals: [], reminders: [], turns: [] }, now)).toMatch(/^in-flight: none/);
  });
});

describe("mentionsFrom", () => {
  it("keeps the last 5 distinct numbers and never adds a repo the turn did not name", () => {
    const t: RecentTurnRow[] = [
      { turnId: "x", occurredAt: now, userInput: "FounderOS#1 FounderOS#2 issue #3 PR 4 pushkarverma3698/FounderOS#5 FounderOS#6", reply: "FounderOS#1 again" },
    ];
    const m = mentionsFrom(t);
    expect(m).toHaveLength(5);
    expect(new Set(m.map((x) => `${x.repo ?? "-"}#${x.number}`)).size).toBe(5);
    expect(m.find((x) => x.number === 3)).toMatchObject({ repo: null, kind: "issue" });
  });
});

describe("makePlanNode — in-flight block", () => {
  const catalog: WorkerCatalogEntry[] = [{ id: "engineering", description: "repos", toolNames: ["repo_status"], gatedToolNames: [] }];
  const state = {
    turn: { id: "t1", chat_id: "111", received_at: "", raw_input: "is anything waiting on me?" },
    last_turn: { id: "", chat_id: "", received_at: "", raw_input: "" },
    reply: "",
    history: [],
  } as unknown as KernelStateType;

  it("puts the block into the planner's system message", async () => {
    const calls: BaseMessage[][] = [];
    const model = { invoke: async (m: BaseMessage[]) => (calls.push(m), new AIMessage('{"type":"reply","text":"ok"}')) };
    const plan = makePlanNode(model, catalog, () => now, [], undefined, undefined, new Set(), undefined, source());
    await plan(state, { configurable: { thread_id: "turicks:111" } });
    const system = calls[0]!.filter((m): m is SystemMessage => m instanceof SystemMessage).map((m) => String(m.content)).join("\n");
    expect(system).toContain(`approval card ${approval.id}`);
    expect(system).toContain(`reminder ${reminder.id}`);
  });
});
