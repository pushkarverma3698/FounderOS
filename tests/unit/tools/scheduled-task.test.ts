/**
 * Unit tests for scheduleTaskTool — validation + persistence (DB mocked).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn();

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, insertScheduledTask: mockInsert };
});

const { scheduleTaskTool } = await import("../../../src/tools/scheduled-task.js");

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

describe("scheduleTaskTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue({ id: "st1", status: "scheduled" });
  });

  it("persists a future task with its chat and idempotency key", async () => {
    const res = await scheduleTaskTool.execute({
      prompt: "  Summarise my LinkedIn analytics  ",
      scheduled_at: FUTURE,
      chat_id: "6775330211",
      idempotency_key: "k1",
      tenant_id: "turicks",
    });

    expect(res.success).toBe(true);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "turicks",
        prompt: "Summarise my LinkedIn analytics", // trimmed
        chat_id: "6775330211",
        idempotency_key: "k1",
      }),
    );
    expect((res.data as { scheduled_task_id: string }).scheduled_task_id).toBe("st1");
  });

  it("rejects a scheduled_at in the past and does not persist", async () => {
    const res = await scheduleTaskTool.execute({
      prompt: "do the thing",
      scheduled_at: "2020-01-01T00:00:00Z",
      chat_id: "1",
      idempotency_key: "k2",
      tenant_id: "turicks",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/future/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an unparseable datetime", async () => {
    const res = await scheduleTaskTool.execute({
      prompt: "do the thing",
      scheduled_at: "next tuesday-ish",
      chat_id: "1",
      idempotency_key: "k3",
      tenant_id: "turicks",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ISO/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an empty prompt", async () => {
    const res = await scheduleTaskTool.execute({
      prompt: "   ",
      scheduled_at: FUTURE,
      chat_id: "1",
      idempotency_key: "k4",
      tenant_id: "turicks",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/prompt/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("persists a recurring task with its spec and the first occurrence as scheduled_at", async () => {
    const before = Date.now();
    const res = await scheduleTaskTool.execute({
      prompt: "Summarise yesterday's PRs",
      recurrence: "daily@08:00",
      chat_id: "1",
      idempotency_key: "k5",
      tenant_id: "turicks",
    });
    expect(res.success).toBe(true);
    const row = mockInsert.mock.calls[0]![0] as { scheduled_at: Date; recurrence: string };
    expect(row.recurrence).toBe("daily@08:00");
    expect(row.scheduled_at.getTime()).toBeGreaterThan(before);
    expect(row.scheduled_at.getTime()).toBeLessThanOrEqual(before + 24 * 3_600_000 + 60_000);
    expect((res.data as { recurrence: string }).recurrence).toBe("every day at 08:00");
  });

  it("stores no recurrence for a one-shot task", async () => {
    await scheduleTaskTool.execute({ prompt: "x", scheduled_at: FUTURE, chat_id: "1", idempotency_key: "k6", tenant_id: "turicks" });
    expect((mockInsert.mock.calls[0]![0] as { recurrence?: unknown }).recurrence ?? null).toBeNull();
  });

  it("rejects a repeat rule it cannot parse, naming the accepted forms", async () => {
    const res = await scheduleTaskTool.execute({ prompt: "x", recurrence: "every morning", chat_id: "1", idempotency_key: "k7", tenant_id: "turicks" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/daily@08:00/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects both a time and a repeat rule, and neither", async () => {
    const both = await scheduleTaskTool.execute({ prompt: "x", scheduled_at: FUTURE, recurrence: "daily@08:00", chat_id: "1", idempotency_key: "k8", tenant_id: "turicks" });
    const neither = await scheduleTaskTool.execute({ prompt: "x", chat_id: "1", idempotency_key: "k9", tenant_id: "turicks" });
    expect(both.success).toBe(false);
    expect(neither.success).toBe(false);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
