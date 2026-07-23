/**
 * Unit tests — the reminder sweep pings and re-arms (DB + telegram mocked).
 * The reliability promise: a due reminder is sent; one-shot rows are marked
 * fired, recurring rows advance, and one row's failure never stops the rest.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClaimDue = vi.fn();
const mockMarkFired = vi.fn(async () => {});
const mockAdvance = vi.fn(async () => {});

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    claimDueReminders: mockClaimDue,
    markReminderFired: mockMarkFired,
    advanceReminder: mockAdvance,
  };
});

const mockSendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat: mockSendToChat }));

const { runReminderSweep } = await import("../../../src/infra/scheduler.js");

function dueReminder(overrides: Record<string, unknown> = {}) {
  return {
    id: "rem1",
    tenant_id: "turicks",
    chat_id: "6775330211",
    text: "call the accountant",
    remind_at: new Date(),
    recurrence: null,
    timezone: "Asia/Kolkata",
    status: "firing",
    idempotency_key: "reminder:abc",
    error: null,
    created_at: new Date(),
    fired_at: null,
    ...overrides,
  };
}

describe("runReminderSweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pings a one-shot reminder and marks it fired", async () => {
    mockClaimDue.mockResolvedValue([dueReminder()]);
    await runReminderSweep();
    expect(mockSendToChat).toHaveBeenCalledOnce();
    expect(mockSendToChat.mock.calls[0]![0]).toContain("call the accountant");
    expect(mockMarkFired).toHaveBeenCalledWith("rem1", expect.any(Date));
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("pings a recurring reminder and advances it instead of firing-done", async () => {
    mockClaimDue.mockResolvedValue([
      dueReminder({ id: "rem2", recurrence: { kind: "daily", time: "09:00" } }),
    ]);
    await runReminderSweep(new Date("2026-07-22T13:00:00Z"));
    expect(mockSendToChat).toHaveBeenCalledOnce();
    expect(mockAdvance).toHaveBeenCalledWith("rem2", expect.any(Date), expect.any(Date));
    expect(mockMarkFired).not.toHaveBeenCalled();
  });

  it("escapes HTML in the reminder text", async () => {
    mockClaimDue.mockResolvedValue([dueReminder({ text: "ping <b>me</b> & co" })]);
    await runReminderSweep();
    expect(mockSendToChat.mock.calls[0]![0]).toContain("ping &lt;b&gt;me&lt;/b&gt; &amp; co");
  });

  it("continues the sweep when one reminder's send throws", async () => {
    mockSendToChat.mockRejectedValueOnce(new Error("telegram down"));
    mockClaimDue.mockResolvedValue([dueReminder(), dueReminder({ id: "rem3" })]);
    await runReminderSweep();
    expect(mockSendToChat).toHaveBeenCalledTimes(2); // rem3 still attempted
    expect(mockMarkFired).toHaveBeenCalledTimes(1); // only rem3 completed
  });

  it("does nothing when no reminders are due", async () => {
    mockClaimDue.mockResolvedValue([]);
    await runReminderSweep();
    expect(mockSendToChat).not.toHaveBeenCalled();
  });
});
