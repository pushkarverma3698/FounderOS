/**
 * Unit tests for the scheduler's scheduled-task sweep — executor + DB mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClaimDue = vi.fn();
const mockMarkFailed = vi.fn(async () => {});
const mockInsert = vi.fn(async (row: Record<string, unknown>) => ({ id: "next1", status: "scheduled", ...row }));

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    claimDueScheduledTasks: mockClaimDue,
    markScheduledTaskFailed: mockMarkFailed,
    insertScheduledTask: mockInsert,
  };
});

const mockSendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat: mockSendToChat }));

const { runScheduledTaskSweep } = await import("../../../src/infra/scheduler.js");

function dueTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "st1",
    tenant_id: "turicks",
    prompt: "Summarise my LinkedIn analytics",
    chat_id: "6775330211",
    scheduled_at: new Date(),
    status: "running",
    attempts: 1,
    idempotency_key: "schedtask:abc",
    error: null,
    created_at: new Date(),
    completed_at: null,
    ...overrides,
  };
}

describe("runScheduledTaskSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires each claimed task through the injected executor", async () => {
    const executor = vi.fn(async () => {});
    mockClaimDue.mockResolvedValue([dueTask(), dueTask({ id: "st2" })]);

    await runScheduledTaskSweep(executor);

    expect(executor).toHaveBeenCalledTimes(2);
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ id: "st1" }));
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ id: "st2" }));
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("marks a task failed when the executor throws, and continues the sweep", async () => {
    const executor = vi
      .fn()
      .mockRejectedValueOnce(new Error("kernel exploded"))
      .mockResolvedValueOnce(undefined);
    mockClaimDue.mockResolvedValue([dueTask(), dueTask({ id: "st2" })]);

    await runScheduledTaskSweep(executor);

    expect(mockMarkFailed).toHaveBeenCalledWith("st1", "kernel exploded");
    expect(executor).toHaveBeenCalledTimes(2); // st2 still ran
  });

  it("does nothing when no tasks are due", async () => {
    const executor = vi.fn(async () => {});
    mockClaimDue.mockResolvedValue([]);

    await runScheduledTaskSweep(executor);

    expect(executor).not.toHaveBeenCalled();
  });

  it("books the next occurrence of a recurring task before firing it, keyed to this row", async () => {
    const order: string[] = [];
    mockInsert.mockImplementationOnce(async (row: Record<string, unknown>) => {
      order.push("insert");
      return { id: "next1", status: "scheduled", ...row };
    });
    const executor = vi.fn(async () => {
      order.push("fire");
    });
    const before = Date.now();
    mockClaimDue.mockResolvedValue([dueTask({ recurrence: "daily@08:00" })]);

    await runScheduledTaskSweep(executor);

    expect(order).toEqual(["insert", "fire"]);
    const row = mockInsert.mock.calls[0]![0] as { scheduled_at: Date; idempotency_key: string; recurrence: string; prompt: string; chat_id: string };
    expect(row.idempotency_key).toBe("recur:st1");
    expect(row.recurrence).toBe("daily@08:00");
    expect(row.prompt).toBe("Summarise my LinkedIn analytics");
    expect(row.chat_id).toBe("6775330211");
    expect(row.scheduled_at.getTime()).toBeGreaterThan(before);
    expect(row.scheduled_at.getTime()).toBeLessThanOrEqual(before + 24 * 3_600_000 + 60_000);
  });

  it("books nothing for a one-shot task", async () => {
    mockClaimDue.mockResolvedValue([dueTask({ recurrence: null })]);
    await runScheduledTaskSweep(vi.fn(async () => {}));
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("still fires today's run and tells the founder when the next one cannot be booked", async () => {
    mockInsert.mockRejectedValueOnce(new Error("db down"));
    const executor = vi.fn(async () => {});
    mockClaimDue.mockResolvedValue([dueTask({ recurrence: "weekdays@09:00" })]);

    await runScheduledTaskSweep(executor);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(mockSendToChat).toHaveBeenCalledWith(expect.stringMatching(/next run.*not booked[\s\S]*db down/i), "HTML");
  });

  it("tells the founder when a stored repeat rule is unreadable, and still fires the task", async () => {
    const executor = vi.fn(async () => {});
    mockClaimDue.mockResolvedValue([dueTask({ recurrence: "hourly" })]);

    await runScheduledTaskSweep(executor);

    expect(mockInsert).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(mockSendToChat).toHaveBeenCalledWith(expect.stringMatching(/hourly/), "HTML");
  });
});
