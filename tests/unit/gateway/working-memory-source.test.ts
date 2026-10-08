/**
 * Unit test — the reader behind the working-memory block (AG-032).
 * Every dependency is injected: no database, no GitHub, no model.
 */
import { describe, it, expect, vi } from "vitest";
import { buildWorkingMemorySource, IN_FLIGHT_TTL_MS, type WorkingMemoryDeps } from "../../../src/gateway/working-memory-source.js";
import type { GoalRow } from "../../../src/goals/types.js";
import type { RepoStatusView } from "../../../src/tools/repo-status.js";

const now = new Date("2026-10-08T10:00:00Z");
const SLASH = String.fromCharCode(47);
const FOS = ["pushkarverma3698", "FounderOS"].join(SLASH);
const OPL = ["OplifyMessage", "oplify-messaging-api"].join(SLASH);

const view = (over: Partial<RepoStatusView> = {}): RepoStatusView => ({
  summaries: [
    {
      slug: FOS,
      done: { count: 0, top: [] },
      inFlight: {
        openPrs: [
          { number: 1004, title: "Working memory", url: "u", draft: true },
          { number: 1005, title: "Other", url: "u", draft: false },
        ],
        agentIssues: [{ number: 994, title: "Pin the repo list", url: "u" }],
      },
      left: { total: 0, byPriority: {} },
      blocked: { issues: [], failingPrs: [{ number: 1005, title: "Other", url: "u" }] },
    },
  ],
  unreachable: [],
  ...over,
});

const goal = (title: string, due: string | null): GoalRow => ({
  id: title, tenant_id: "turicks", title, metric_key: "manual", metric_arg: null, target: 3, baseline: 0, due_on: due,
  status: "active", blocked_until: null, blocker: null, priority: 1, manual_value: null, manual_value_at: null,
  created_at: now, updated_at: now,
});

function deps(over: Partial<WorkingMemoryDeps> = {}): WorkingMemoryDeps {
  return {
    founderChatId: "111",
    familyChatIds: new Set(["-5319642142"]),
    tenant: "turicks",
    profiles: () => [{ id: "pushkar", candidateName: "Pushkar Verma" }, { id: "tashi", candidateName: "Tashi" }],
    founderProfileId: "pushkar",
    openGoals: async () => [goal("Land 3 NL interviews", "2026-11-01")],
    repos: [FOS, OPL],
    repoStatus: async () => view(),
    turns: async () => [],
    context: async () => ({}),
    ...over,
  };
}

describe("buildWorkingMemorySource", () => {
  it("applies to the founder DM and the family group, nothing else", () => {
    const s = buildWorkingMemorySource(deps());
    expect(s.appliesTo("turicks:111")).toBe(true);
    expect(s.appliesTo("turicks:-5319642142")).toBe(true);
    expect(s.appliesTo("turicks:-100200")).toBe(false);
    expect(s.appliesTo("turicks:222")).toBe(false);
    expect(s.appliesTo("not-a-thread")).toBe(false);
  });

  it("people carry only the profile id and the founder flag, no guessed relation", async () => {
    const people = await buildWorkingMemorySource(deps()).people("turicks:111", now);
    expect(people).toEqual([
      { name: "Pushkar Verma", profile: "pushkar", founder: true },
      { name: "Tashi", profile: "tashi", founder: false },
    ]);
  });

  it("goals are numbered the way the goal command numbers them", async () => {
    const s = buildWorkingMemorySource(deps({ openGoals: async () => [goal("A", null), goal("B", "2026-12-01")] }));
    expect(await s.goals("turicks:111", now)).toEqual([
      { n: 1, title: "A", dueOn: null, target: 3 },
      { n: 2, title: "B", dueOn: "2026-12-01", target: 3 },
    ]);
  });

  it("in flight lists open PRs with their notes, then agent tasks", async () => {
    const snap = await buildWorkingMemorySource(deps()).inFlight("turicks:111", now);
    expect(snap?.asOf).toEqual(now);
    expect(snap?.items).toEqual([
      { repo: FOS, kind: "PR", number: 1004, title: "Working memory", note: "draft" },
      { repo: FOS, kind: "PR", number: 1005, title: "Other", note: "checks failing" },
      { repo: FOS, kind: "task", number: 994, title: "Pin the repo list" },
    ]);
  });

  it("serves GitHub from cache inside the TTL and refreshes after it", async () => {
    const repoStatus = vi.fn(async () => view());
    const s = buildWorkingMemorySource(deps({ repoStatus }));
    await s.inFlight("turicks:111", now);
    await s.inFlight("turicks:111", new Date(now.getTime() + IN_FLIGHT_TTL_MS - 1));
    expect(repoStatus).toHaveBeenCalledTimes(1);
    await s.inFlight("turicks:111", new Date(now.getTime() + IN_FLIGHT_TTL_MS + 1));
    expect(repoStatus).toHaveBeenCalledTimes(2);
  });

  it("past the TTL it answers at once from the old snapshot, stamped with its own time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const repoStatus = async (): Promise<RepoStatusView> => {
      calls += 1;
      if (calls > 1) await gate;
      return view();
    };
    const s = buildWorkingMemorySource(deps({ repoStatus }));
    await s.inFlight("turicks:111", now);
    const stale = await s.inFlight("turicks:111", new Date(now.getTime() + IN_FLIGHT_TTL_MS + 1));
    expect(stale?.asOf).toEqual(now);
    release();
  });

  it("every repo unreachable throws on the first read and is not cached as an empty board", async () => {
    let calls = 0;
    const repoStatus = async (): Promise<RepoStatusView> => {
      calls += 1;
      return calls === 1 ? { summaries: [], unreachable: [{ repo: FOS, error: "401" }] } : view();
    };
    const s = buildWorkingMemorySource(deps({ repoStatus }));
    await expect(s.inFlight("turicks:111", now)).rejects.toThrow("401");
    const second = await s.inFlight("turicks:111", now);
    expect(second?.items.length).toBe(3);
  });

  it("a failed refresh keeps serving the old snapshot", async () => {
    let calls = 0;
    const repoStatus = async (): Promise<RepoStatusView> => {
      calls += 1;
      if (calls > 1) throw new Error("rate limited");
      return view();
    };
    const s = buildWorkingMemorySource(deps({ repoStatus }));
    await s.inFlight("turicks:111", now);
    const later = await s.inFlight("turicks:111", new Date(now.getTime() + IN_FLIGHT_TTL_MS + 1));
    expect(later?.items.length).toBe(3);
    await new Promise((r) => setTimeout(r, 0));
  });

  it("turns are read by the asking thread id, so the group never reads the private chat", async () => {
    const turns = vi.fn(async () => [
      { turn_id: "t1", occurred_at: new Date("2026-10-07T04:00:00Z"), user_input: "hello", goal: "g", outcome: "done" as const, reply: "r" },
    ]);
    const s = buildWorkingMemorySource(deps({ turns }));
    const out = await s.recentTurns("turicks:-5319642142", now);
    expect(turns).toHaveBeenCalledWith("turicks:-5319642142", expect.any(Date));
    expect(out).toEqual([{ at: new Date("2026-10-07T04:00:00Z"), asked: "hello", outcome: "done" }]);
  });

  it("standing preferences are only the keys the founder saved himself, each dated", async () => {
    const ctx = {
      notes: "send CVs as PDF",
      pipeline_stage: "seed",
      context_meta: {
        notes: { at: "2026-10-07T04:00:00Z", source: "founder" },
        pipeline_stage: { at: "2026-10-01T04:00:00Z", source: "inferred" },
      },
    };
    const lines = await buildWorkingMemorySource(deps({ context: async () => ctx })).standing("turicks:111", now);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("notes");
    expect(lines[0]).toContain("send CVs as PDF");
    expect(lines.join("\n")).not.toContain("seed");
  });
});
