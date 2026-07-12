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
});
