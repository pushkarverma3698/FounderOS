/**
 * Unit tests for the scheduler's scheduled-task sweep — executor + DB mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClaimDue = vi.fn();
const mockMarkFailed = vi.fn(async () => {});

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    claimDueScheduledTasks: mockClaimDue,
    markScheduledTaskFailed: mockMarkFailed,
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
});
