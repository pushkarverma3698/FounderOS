/**
 * Unit tests — reminder tool validation (DB mocked).
 * A reminder must reject bad input LOUDLY (past time, both/neither of
 * remind_at|recurrence, bad recurrence) rather than persisting a dud.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn(async (data: Record<string, unknown>) => ({
  id: "rem1",
  status: "scheduled",
  ...data,
}));

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, insertReminder: mockInsert };
});

const { setReminderTool, validateRecurrence } = await import("../../../src/tools/reminder.js");

const base = { text: "call the accountant", chat_id: "c1", idempotency_key: "k1", tenant_id: "turicks" };

describe("validateRecurrence", () => {
  it("accepts daily/weekdays with a valid time", () => {
    expect(validateRecurrence({ kind: "daily", time: "09:00" })).toBeNull();
    expect(validateRecurrence({ kind: "weekdays", time: "18:30" })).toBeNull();
  });
  it("accepts weekly with a weekday", () => {
    expect(validateRecurrence({ kind: "weekly", time: "09:00", weekday: 1 })).toBeNull();
  });
  it("rejects a bad time, kind, or missing weekday", () => {
    expect(validateRecurrence({ kind: "daily", time: "9am" })).toMatch(/HH:MM/);
    expect(validateRecurrence({ kind: "monthly", time: "09:00" })).toMatch(/kind/);
    expect(validateRecurrence({ kind: "weekly", time: "09:00" })).toMatch(/weekday/);
  });
});

describe("setReminderTool.execute", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists a valid future one-shot", async () => {
    const remind_at = new Date(Date.now() + 3_600_000).toISOString();
    const res = await setReminderTool.execute({ ...base, remind_at });
    expect(res.success).toBe(true);
    expect(mockInsert).toHaveBeenCalledOnce();
  });

  it("rejects a past one-shot", async () => {
    const remind_at = new Date(Date.now() - 3_600_000).toISOString();
    const res = await setReminderTool.execute({ ...base, remind_at });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/future/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects when both remind_at and recurrence are given", async () => {
    const res = await setReminderTool.execute({
      ...base,
      remind_at: new Date(Date.now() + 3_600_000).toISOString(),
      recurrence: { kind: "daily", time: "09:00" },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exactly one/);
  });

  it("rejects when neither remind_at nor recurrence is given", async () => {
    const res = await setReminderTool.execute({ ...base });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exactly one/);
  });

  it("computes the first fire for a recurrence and persists it in the future", async () => {
    const res = await setReminderTool.execute({ ...base, recurrence: { kind: "daily", time: "09:00" } });
    expect(res.success).toBe(true);
    const data = res.data as { remind_at: string; recurring: boolean };
    expect(data.recurring).toBe(true);
    expect(new Date(data.remind_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects empty text", async () => {
    const res = await setReminderTool.execute({ ...base, text: "  ", remind_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/text/);
  });
});
