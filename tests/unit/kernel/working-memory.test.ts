/**
 * Unit test — the founder working-memory block (AG-032).
 * Pure renderer, the contained reader call, and the session-gap selection. No database, no model.
 */
import { describe, it, expect, vi } from "vitest";
import {
  WORKING_MEMORY_HEADER,
  WORKING_MEMORY_MAX_CHARS,
  WORKING_MEMORY_SECTION_TIMEOUT_MS,
  founderContextBlockFor,
  renderWorkingMemory,
  selectLastSession,
  workingMemoryBlockFor,
  type InFlightEntry,
  type SessionTurn,
  type WorkingMemorySource,
} from "../../../src/kernel/working-memory.js";
import { RECENT_ACTIVITY_HEADER, type RecentActivitySource } from "../../../src/kernel/recent-activity.js";

const now = new Date("2026-10-08T10:00:00Z");
const HOUR = 3_600_000;

const turn = (hoursAgo: number, asked: string = "ask " + hoursAgo, outcome: SessionTurn["outcome"] = "done"): SessionTurn => ({
  at: new Date(now.getTime() - hoursAgo * HOUR),
  asked,
  outcome,
});

const SLASH = String.fromCharCode(47);
const FOS = ["pushkarverma3698", "FounderOS"].join(SLASH);
const OPL = ["OplifyMessage", "oplify-messaging-api"].join(SLASH);
function mkEntry(n: number, over: object = {}): InFlightEntry {
  const base = { repo: FOS, kind: "PR" as const, number: n, title: "Title " + n };
  return Object.assign(base, over);
}

function source(over: Partial<WorkingMemorySource> = {}): WorkingMemorySource {
  return {
    appliesTo: () => true,
    people: async () => [{ name: "Pushkar Verma", profile: "pushkar-nl-tech", founder: true }],
    goals: async () => [{ n: 1, title: "Land 3 NL interviews", dueOn: "2026-11-01", target: 3 }],
    inFlight: async () => ({ items: [mkEntry(1004, { note: "draft" })], asOf: new Date("2026-10-08T09:55:00Z") }),
    recentTurns: async () => [turn(30, "Give me wife's fresh jobs", "done"), turn(31)],
    standing: async () => ["• notes: send CVs as PDF (confirmed 2026-10-07)"],
    ...over,
  };
}

describe("renderWorkingMemory", () => {
  it("renders every section under the fixed header, one line per fact", async () => {
    const block = await workingMemoryBlockFor(source(), "turicks:111", now);
    expect(block.startsWith(WORKING_MEMORY_HEADER)).toBe(true);
    expect(block).toContain("People:");
    expect(block).toContain("- Pushkar Verma (founder) — job profile pushkar-nl-tech");
    expect(block).toContain("Goals:");
    expect(block).toContain("- 1. Land 3 NL interviews — target 3, due 2026-11-01");
    expect(block).toContain("In flight");
    expect(block).toContain("- FounderOS PR #1004: Title 1004 (draft)");
    expect(block).toContain("Last session");
    expect(block).toContain("- 07 Oct 09:30 IST · asked: \"Give me wife's fresh jobs\" · done");
    expect(block).toContain("Saved context");
    expect(block).toContain("• notes: send CVs as PDF (confirmed 2026-10-07)");
    expect(block.length).toBeLessThanOrEqual(WORKING_MEMORY_MAX_CHARS);
  });

  it("is empty when no section has data", async () => {
    const empty = source({ people: async () => [], goals: async () => [], inFlight: async () => null, recentTurns: async () => [], standing: async () => [] });
    expect(await workingMemoryBlockFor(empty, "turicks:111", now)).toBe("");
  });

  it("shows at most 5 goals and says how many it cut", async () => {
    const goals = Array.from({ length: 8 }, (_, i) => ({ n: i + 1, title: "Goal " + (i + 1), dueOn: null }));
    const block = await workingMemoryBlockFor(source({ goals: async () => goals }), "turicks:111", now);
    expect(block).toContain("5. Goal 5");
    expect(block).not.toContain("6. Goal 6");
    expect(block).toContain("… 3 more goals");
  });

  it("shows at most 8 in-flight lines and counts what it cut", async () => {
    const items = Array.from({ length: 9 }, (_, i) => mkEntry(i + 1));
    items.push(mkEntry(7, { repo: OPL, kind: "task", title: "Fix it" }));
    const block = await workingMemoryBlockFor(source({ inFlight: async () => ({ items, asOf: now }) }), "turicks:111", now);
    expect(block).toContain("PR #8:");
    expect(block).not.toContain("PR #9:");
    expect(block).toContain("… 1 more PR, 1 more task");
  });

  it("states how old the in-flight snapshot is", async () => {
    const block = await workingMemoryBlockFor(source(), "turicks:111", now);
    expect(block).toContain("In flight (GitHub, as of 08 Oct 15:25 IST):");
  });

  it("keeps the whole block under the cap and names the sections it had to drop", async () => {
    const long = "y".repeat(400);
    const block = await workingMemoryBlockFor(
      source({
        people: async () => Array.from({ length: 6 }, (_, i) => ({ name: "Person " + i + " " + long, profile: "p", founder: false })),
        goals: async () => Array.from({ length: 5 }, (_, i) => ({ n: i + 1, title: long, dueOn: null })),
        inFlight: async () => ({ items: Array.from({ length: 8 }, (_, i) => mkEntry(i, { title: long })), asOf: now }),
        recentTurns: async () => [turn(30, long), turn(31, long), turn(32, long)],
        standing: async () => Array.from({ length: 6 }, () => long),
      }),
      "turicks:111",
      now,
    );
    expect(block.length).toBeLessThanOrEqual(WORKING_MEMORY_MAX_CHARS);
    expect(block).toMatch(/… not shown \(size cap\): .*Saved context/);
  });

  it("puts one fact on one line", () => {
    const text = renderWorkingMemory({ goals: [{ n: 1, title: "a\n\nb", dueOn: null }] }, now);
    expect(text.split("\n").filter((l) => l.startsWith("- 1."))).toEqual(["- 1. a b"]);
  });
});

describe("selectLastSession", () => {
  it("takes the 3 newest turns before the latest 6 h silence", () => {
    // current session: 1 h and 2 h ago; silence of 10 h; the session before: 12, 13, 14, 15 h ago.
    const turns = [turn(1), turn(2), turn(12), turn(13), turn(14), turn(15)];
    expect(selectLastSession(turns, now).map((t) => t.asked)).toEqual(["ask 12", "ask 13", "ask 14"]);
  });
  it("when the founder has been silent for 6 h or more, the newest turns are the last session", () => {
    const turns = [turn(8), turn(9), turn(10), turn(11)];
    expect(selectLastSession(turns, now).map((t) => t.asked)).toEqual(["ask 8", "ask 9", "ask 10"]);
  });
  it("is empty while the log shows only the current session (no gap found)", () => {
    expect(selectLastSession([turn(1), turn(2), turn(3)], now)).toEqual([]);
  });
  it("is empty for an empty log", () => {
    expect(selectLastSession([], now)).toEqual([]);
  });
  it("does not depend on input order", () => {
    const turns = [turn(14), turn(2), turn(12), turn(1), turn(13)];
    expect(selectLastSession(turns, now).map((t) => t.asked)).toEqual(["ask 12", "ask 13", "ask 14"]);
  });
});

describe("workingMemoryBlockFor", () => {
  it("never in other chats: a source that does not apply is never read", async () => {
    const people = vi.fn(async () => []);
    const src = source({ appliesTo: () => false, people });
    expect(await workingMemoryBlockFor(src, "turicks:-100200", now)).toBe("");
    expect(people).not.toHaveBeenCalled();
  });

  it("is empty without a source, a thread id, or when disabled", async () => {
    expect(await workingMemoryBlockFor(undefined, "turicks:111", now)).toBe("");
    expect(await workingMemoryBlockFor(source(), undefined, now)).toBe("");
    expect(await workingMemoryBlockFor(source(), "", now)).toBe("");
    expect(await workingMemoryBlockFor(source(), "turicks:111", now, false)).toBe("");
  });

  it("a reader that throws omits only its own section", async () => {
    const block = await workingMemoryBlockFor(source({ goals: async () => { throw new Error("db down"); } }), "turicks:111", now);
    expect(block).not.toContain("Goals:");
    expect(block).toContain("People:");
    expect(block).toContain("In flight");
    expect(block).not.toContain("db down");
  });

  it("every reader throwing leaves no block at all", async () => {
    const boom = async (): Promise<never> => { throw new Error("down"); };
    const block = await workingMemoryBlockFor(source({ people: boom, goals: boom, inFlight: boom, recentTurns: boom, standing: boom }), "turicks:111", now);
    expect(block).toBe("");
  });

  it("a reader that hangs is cut off at the section timeout instead of stalling the planner", async () => {
    vi.useFakeTimers();
    try {
      const hang = (): Promise<never> => new Promise<never>(() => undefined);
      const pending = workingMemoryBlockFor(source({ standing: hang }), "turicks:111", now);
      await vi.advanceTimersByTimeAsync(WORKING_MEMORY_SECTION_TIMEOUT_MS + 1);
      const block = await pending;
      expect(block).toContain("People:");
      expect(block).not.toContain("Saved context");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("founderContextBlockFor, one call for the planner", () => {
  const recent: RecentActivitySource = {
    appliesTo: () => true,
    recent: async () => [{ at: new Date("2026-10-08T08:00:00Z"), origin: "mac-claude", project: "founderos", title: "Wired it", content: "x" }],
  };

  it("puts working memory first and recent work second, each under its own header", async () => {
    const text = await founderContextBlockFor({ workingMemory: source(), recentActivity: recent }, "turicks:111", now);
    const wm = text.indexOf(WORKING_MEMORY_HEADER);
    const ra = text.indexOf(RECENT_ACTIVITY_HEADER);
    expect(wm).toBeGreaterThanOrEqual(0);
    expect(ra).toBeGreaterThan(wm);
  });

  it("either half works alone", async () => {
    expect(await founderContextBlockFor({ recentActivity: recent }, "turicks:111", now)).toContain(RECENT_ACTIVITY_HEADER);
    expect(await founderContextBlockFor({ workingMemory: source() }, "turicks:111", now)).not.toContain(RECENT_ACTIVITY_HEADER);
    expect(await founderContextBlockFor(undefined, "turicks:111", now)).toBe("");
  });

  it("the switch drops working memory only", async () => {
    const text = await founderContextBlockFor({ workingMemory: source(), recentActivity: recent, workingMemoryEnabled: false }, "turicks:111", now);
    expect(text).not.toContain(WORKING_MEMORY_HEADER);
    expect(text).toContain(RECENT_ACTIVITY_HEADER);
  });
});
