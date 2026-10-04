/**
 * Repeating scheduled tasks through the agent wrapper: the real wrapper and the real
 * scheduleTaskTool, with only the approval gate and the database stubbed. Proves the
 * founder's card says it repeats, the row carries the spec, and list_scheduled shows
 * which upcoming task repeats and how to stop it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHitlGate = vi.fn();
const mockInsert = vi.fn();
const mockListTasks = vi.fn();

vi.mock("../../../src/agents/agent-tools/hitl.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hitlGate: mockHitlGate };
});

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    insertScheduledTask: mockInsert,
    listUpcomingScheduledTasks: mockListTasks,
    listUpcomingScheduledPosts: vi.fn(async () => []),
  };
});

const { scheduleTask, listScheduled } = await import("../../../src/agents/agent-tools/scheduling.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockHitlGate.mockResolvedValue(null); // approved
  mockInsert.mockImplementation(async (row: Record<string, unknown>) => ({ id: "st9", status: "scheduled", ...row }));
});

describe("schedule_task with recurrence", () => {
  it("asks once with a card that says it repeats, then stores the spec", async () => {
    const out = await scheduleTask.invoke({ prompt: "Summarise yesterday's merged PRs", recurrence: "weekdays@08:30" });

    const card = mockHitlGate.mock.calls[0]![0] as { title: string; summary: string };
    expect(card.title).toMatch(/repeating/i);
    expect(card.summary).toBe("Runs every weekday at 08:30, until you cancel it");
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ recurrence: "weekdays@08:30" }));
    expect(out).toMatch(/Repeating task set: every weekday at 08:30/);
  });

  it("a rejected card stores nothing", async () => {
    mockHitlGate.mockResolvedValue("Founder rejected.");
    const out = await scheduleTask.invoke({ prompt: "x", recurrence: "daily@08:00" });
    expect(out).toBe("Founder rejected.");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("a one-shot task keeps its old card and reply", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const out = await scheduleTask.invoke({ prompt: "x", scheduled_at: at });
    expect((mockHitlGate.mock.calls[0]![0] as { summary: string }).summary).toBe(`Runs at ${at}`);
    expect(out).toMatch(/^✅ Task scheduled for/);
  });
});

describe("list_scheduled", () => {
  it("marks the repeating task and says how to stop it", async () => {
    mockListTasks.mockResolvedValue([
      { id: "a", prompt: "daily digest", scheduled_at: new Date("2026-10-05T06:00:00Z"), recurrence: "daily@08:00" },
      { id: "b", prompt: "one off", scheduled_at: new Date("2026-10-06T06:00:00Z"), recurrence: null },
    ]);
    const out = (await listScheduled.invoke({})) as string;
    expect(out).toContain("(repeats every day at 08:00; cancel this run to stop it)");
    expect(out.split("\n").find((l) => l.includes("one off"))).not.toMatch(/repeats/);
  });
});
