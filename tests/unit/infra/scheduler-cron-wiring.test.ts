/**
 * Unit tests — every self-improvement job is actually registered on a cron.
 * ========================================================================
 * `startScheduler` had no test at all, so a job could be written, imported and
 * never scheduled with nothing failing. These assertions pin the schedule the
 * founder was told about in the startup log line.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSchedule = vi.fn();
vi.mock("node-cron", () => ({ default: { schedule: mockSchedule }, schedule: mockSchedule }));

const { startScheduler } = await import("../../../src/infra/scheduler.js");

/** Cron expressions the scheduler promises in its own startup log. */
const EXPECTED_CRONS = {
  "stale-approval reminder": "0 9 * * *",
  "hourly budget alert": "0 * * * *",
  "checkpoint TTL sweep": "30 3 * * *",
  "nightly brain sync": "0 2 * * *",
  "3-day self-audit sweep": "0 8 */3 * *",
  "weekly RAG optimization": "0 3 * * 0",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startScheduler — self-improvement jobs are wired, not merely written", () => {
  it("registers every promised cron expression", () => {
    startScheduler();

    const registered = mockSchedule.mock.calls.map((call) => call[0] as string);

    for (const [name, expression] of Object.entries(EXPECTED_CRONS)) {
      expect(registered, `${name} (${expression}) must be scheduled`).toContain(expression);
    }
  });

  it("does not register the scheduled-task sweep without an executor", () => {
    startScheduler();
    const withoutExecutor = mockSchedule.mock.calls.filter((c) => c[0] === "* * * * *").length;

    mockSchedule.mockClear();
    startScheduler({ taskExecutor: vi.fn() as never });
    const withExecutor = mockSchedule.mock.calls.filter((c) => c[0] === "* * * * *").length;

    expect(withExecutor).toBe(withoutExecutor + 1);
  });

  it("schedules the self-audit every 3 days and the RAG sweep weekly on Sunday", () => {
    startScheduler();
    const registered = mockSchedule.mock.calls.map((call) => call[0] as string);

    expect(registered).toContain("0 8 */3 * *");
    expect(registered).toContain("0 3 * * 0");
  });
});
