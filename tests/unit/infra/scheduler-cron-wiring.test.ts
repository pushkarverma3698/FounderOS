/**
 * Unit tests — every scheduled job is actually registered on a cron.
 * ========================================================================
 * `startScheduler` had no test at all, so a job could be written, imported and
 * never scheduled with nothing failing. These assertions pin the schedule the
 * founder was told about in the startup log line.
 *
 * The self-audit sweep, self-improvement dispatch, weekly RAG optimization,
 * and the metered job-ingest sweep are DELIBERATELY absent from
 * EXPECTED_CRONS (disabled 2026-08-21, see scheduler.ts's file header) — this
 * test would otherwise silently re-permit any of them coming back without a
 * conscious edit here too.
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
  "free board sweep": "*/30 * * * *",
} as const;

/** Disabled 2026-08-21 — must NOT be registered. */
const DISABLED_CRONS = {
  "metered job ingest": "30 1 */3 * *",
  "3-day self-audit sweep": "0 8 */3 * *",
  "3-day self-improvement dispatch": "0 9 */3 * *",
  "weekly RAG optimization": "0 3 * * 0",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startScheduler — jobs are wired, not merely written", () => {
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

  it("does not register the disabled paid/self-improvement crons", () => {
    startScheduler();
    const registered = mockSchedule.mock.calls.map((call) => call[0] as string);

    for (const [name, expression] of Object.entries(DISABLED_CRONS)) {
      expect(registered, `${name} (${expression}) must NOT be scheduled`).not.toContain(expression);
    }
  });
});
