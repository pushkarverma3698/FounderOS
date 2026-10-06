/**
 * A reminder or scheduled task created in the family group must be stored with the GROUP's chat id, so the
 * fire path (which reads the row's chat_id) answers there. Until 2026-10-06 both tools wrote
 * env.TELEGRAM_CHAT_ID, so a group reminder arrived in the founder's DM.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHitlGate = vi.fn();
const mockInsertTask = vi.fn();
const mockInsertReminder = vi.fn();

vi.mock("../../../src/agents/agent-tools/hitl.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hitlGate: mockHitlGate };
});

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, insertScheduledTask: mockInsertTask, insertReminder: mockInsertReminder };
});

const { scheduleTask } = await import("../../../src/agents/agent-tools/scheduling.js");
const { setReminder } = await import("../../../src/agents/agent-tools/reminders.js");
const { env, TENANT } = await import("../../../src/core/config.js");

const GROUP = "-5319642142";
const inFuture = () => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mockHitlGate.mockResolvedValue(null);
  mockInsertTask.mockImplementation(async (row: Record<string, unknown>) => ({ id: "st1", status: "scheduled", ...row }));
  mockInsertReminder.mockImplementation(async (row: Record<string, unknown>) => ({ id: "r1", ...row }));
});

describe("chat the row is stored for", () => {
  it("schedule_task from the group stores the group chat id", async () => {
    await scheduleTask.invoke(
      { prompt: "x", scheduled_at: inFuture() },
      { configurable: { thread_id: `${TENANT}:${GROUP}` } },
    );
    expect(mockInsertTask).toHaveBeenCalledWith(expect.objectContaining({ chat_id: GROUP }));
  });

  it("set_reminder from the group stores the group chat id", async () => {
    await setReminder.invoke(
      { text: "milk", remind_at: inFuture() },
      { configurable: { thread_id: `${TENANT}:${GROUP}` } },
    );
    expect(mockInsertReminder).toHaveBeenCalledWith(expect.objectContaining({ chat_id: GROUP }));
  });

  it("without a Telegram thread id both fall back to the founder's chat", async () => {
    await scheduleTask.invoke({ prompt: "x", scheduled_at: inFuture() }, { configurable: { thread_id: "default" } });
    await setReminder.invoke({ text: "milk", remind_at: inFuture() });
    expect(mockInsertTask).toHaveBeenCalledWith(expect.objectContaining({ chat_id: env.TELEGRAM_CHAT_ID }));
    expect(mockInsertReminder).toHaveBeenCalledWith(expect.objectContaining({ chat_id: env.TELEGRAM_CHAT_ID }));
  });
});
