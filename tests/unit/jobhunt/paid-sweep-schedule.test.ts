/**
 * The paid sweep's schedule, and the wall between it and the free lane (#1341).
 *
 * Pinned because the cron was silently lost once: the paid sweep stopped on
 * 2026-08-12 when the kernel was retired and nothing noticed for 3 months.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { JOB_SWEEP_CRON, JOB_SWEEP_TIME_ZONE, FREE_SWEEP_CRON } = await import("../../../src/tools/jobhunt/sweep-runner.js");
const { JOBS_CRONS, startJobsScheduler } = await import("../../../src/jobs/scheduler.js");
const { EVENING_CRON, EVENING_TIME_ZONE } = await import("../../../src/jobs/apply-evening-batch.js");

describe("paid sweep schedule", () => {
  it("is daily at 18:30 Europe/Amsterdam, registered once with that zone", () => {
    expect(JOB_SWEEP_CRON).toBe("30 18 * * *");
    expect(JOB_SWEEP_TIME_ZONE).toBe("Europe/Amsterdam");
    const calls: { expr: string; tz?: string }[] = [];
    startJobsScheduler((expr, _fn, opts) => void calls.push({ expr, ...(opts?.timezone ? { tz: opts.timezone } : {}) }));
    expect(JOBS_CRONS.filter((c) => c.name === "paid-sweep")).toHaveLength(1);
    expect(calls.filter((c) => c.expr === JOB_SWEEP_CRON)).toEqual([{ expr: "30 18 * * *", tz: "Europe/Amsterdam" }]);
  });

  it("finishes before the evening batch: same zone, earlier clock time", () => {
    expect(EVENING_TIME_ZONE).toBe(JOB_SWEEP_TIME_ZONE);
    const mins = (expr: string): number => {
      const [m, h] = expr.split(" ");
      return Number(h) * 60 + Number(m);
    };
    expect(mins(JOB_SWEEP_CRON)).toBeLessThan(mins(EVENING_CRON));
  });
});

describe("free sweep never buys a paid feed", () => {
  it("is every 30 minutes and is a different job from the paid one", () => {
    expect(FREE_SWEEP_CRON).toBe("*/30 * * * *");
    const free = JOBS_CRONS.find((c) => c.name === "free-sweep")!;
    const paid = JOBS_CRONS.find((c) => c.name === "paid-sweep")!;
    expect(free.run).not.toBe(paid.run);
  });

  it("runFreeSweep's modules do not import the paid feeds or the Apify client", () => {
    const root = "src/tools/jobhunt/";
    const forbidden = /from\s+["'](?:\.\.\/apify|\.\/(?:ats-source|indeed-source|ingest|ingest-pools|spend-gate))(?:\.js)?["']|import\(["']\.\/(?:ats-source|indeed-source|ingest|ingest-pools)\.js["']\)/;
    for (const f of ["free-ats-source", "aggregator-source", "free-ingest", "free-sweep-profile", "free-ats-transport", "free-ats-hydrate"]) {
      const src = readFileSync(`${root}${f}.ts`, "utf8").replace(/import type [^;]*;/g, "");
      expect(forbidden.test(src), `${f}.ts must not reach a paid feed`).toBe(false);
    }
    // runFreeSweep itself imports only free modules.
    const runner = readFileSync(`${root}sweep-runner.ts`, "utf8");
    const freeFn = runner.slice(runner.indexOf("export async function runFreeSweep("));
    expect(freeFn).not.toMatch(/import\(["']\.\/(?:ingest|ats-source|indeed-source|ingest-pools)\.js["']\)|apify/i);
  });
});
