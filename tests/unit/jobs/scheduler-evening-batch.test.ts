import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/tools/jobhunt/sweep-runner.js", () => ({ FREE_SWEEP_CRON: "*/30 * * * *", runFreeSweep: vi.fn() }));

const { JOBS_CRONS, startJobsScheduler } = await import("../../../src/jobs/scheduler.js");

describe("apply-evening-batch cron", () => {
  it("is registered once at 19:00 with an explicit Amsterdam timezone", () => {
    const calls: { expr: string; opts?: { timezone?: string } }[] = [];
    startJobsScheduler((expr, _fn, opts) => void calls.push({ expr, ...(opts ? { opts } : {}) }));
    expect(JOBS_CRONS.filter((c) => c.name === "apply-evening-batch")).toHaveLength(1);
    const evening = calls.filter((c) => c.expr === "0 19 * * *");
    expect(evening).toEqual([{ expr: "0 19 * * *", opts: { timezone: "Europe/Amsterdam" } }]);
  });
  it("leaves entries without a zone on the server clock", () => {
    const calls: { expr: string; opts?: unknown }[] = [];
    startJobsScheduler((expr, _fn, opts) => void calls.push({ expr, opts }));
    expect(calls.find((c) => c.expr === "0 2 * * *")?.opts).toBeUndefined();
  });
});
