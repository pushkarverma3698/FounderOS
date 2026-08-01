/**
 * Unit tests — what the pipeline costs, and the thresholds that must not drift.
 *
 * Asked on 2026-08-01 how many times this runs and what it costs, the only
 * available answer was arithmetic done by hand over the actor pricing pages and
 * a reading of the cron schedule — a question about our own system that our own
 * system could not answer. These tests pin the arithmetic; `job_ingest_runs`
 * records what it actually was.
 */

import { describe, it, expect } from "vitest";
import {
  ATS_PRICING,
  INDEED_PRICING,
  currentPlan,
  estimateQueryCost,
  toLedgerAmount,
} from "../../../src/tools/jobhunt/cost.js";
import { POOL_ORDER } from "../../../src/tools/jobhunt/ats-source.js";
import { TRACK_PRIORITY } from "../../../src/tools/jobhunt/tracks.js";
import { THIN_BODY_CHARS } from "../../../src/tools/jobhunt/screen.js";
import { MIN_DESCRIPTION_CHARS } from "../../../src/tools/jobhunt/indeed-source.js";

describe("estimateQueryCost", () => {
  it("charges a start even when nothing comes back", () => {
    // Not an edge case: the actor start is billed whether or not the run returns
    // anything, so a ledger that only counted successes would under-report
    // precisely on the days something is wrong.
    expect(estimateQueryCost(ATS_PRICING, 0, "free")).toBeCloseTo(0.01, 6);
  });

  it("charges per job on top of the start", () => {
    expect(estimateQueryCost(ATS_PRICING, 10, "free")).toBeCloseTo(0.01 + 0.12, 6);
  });

  it("falls by roughly half on a paid plan", () => {
    const free = estimateQueryCost(ATS_PRICING, 10, "free");
    const silver = estimateQueryCost(ATS_PRICING, 10, "silver");
    expect(silver).toBeLessThan(free / 1.5);
  });

  it("never returns a negative cost for a nonsensical count", () => {
    expect(estimateQueryCost(ATS_PRICING, -5, "free")).toBeCloseTo(0.01, 6);
  });

  it("prices Indeed as noise next to the ATS feed", () => {
    expect(estimateQueryCost(INDEED_PRICING, 10, "free")).toBeLessThan(
      estimateQueryCost(ATS_PRICING, 10, "free") / 100,
    );
  });
});

describe("currentPlan", () => {
  it("assumes the free tier rather than the cheap one", () => {
    // Guessing a paid plan would UNDER-report the bill, which is the direction
    // that gets noticed a month late.
    expect(currentPlan({} as NodeJS.ProcessEnv)).toBe("free");
    expect(currentPlan({ APIFY_PLAN: "nonsense" } as NodeJS.ProcessEnv)).toBe("free");
  });

  it("reads an upgrade from the environment", () => {
    expect(currentPlan({ APIFY_PLAN: "SILVER" } as NodeJS.ProcessEnv)).toBe("silver");
  });
});

describe("toLedgerAmount", () => {
  it("keeps enough precision that summing a day does not round to zero", () => {
    // Indeed's per-job price is $0.00005. Two decimal places would store every
    // Indeed query as $0.00 and the ledger would say the feed is free.
    expect(Number(toLedgerAmount(0.00005))).toBeGreaterThan(0);
  });
});

describe("the sweep's shape", () => {
  it("runs 8 ATS queries, not 12", () => {
    // The two Netherlands pools differed in exactly one field and were billed a
    // separate actor start every day for it. Merging them is worth four starts a
    // day at identical coverage.
    expect(POOL_ORDER.length * TRACK_PRIORITY.length).toBe(8);
  });

  it("keeps the office-less remote pool separate", () => {
    // It cannot merge: it omits `locationSearch` entirely, and a posting with a
    // null derived location is unreachable while any location filter is set.
    expect(POOL_ORDER).toContain("eu-remote-global");
  });
});

describe("the too-thin-to-judge threshold", () => {
  it("is the same number on both paths", () => {
    // Two different thresholds would mean a body Indeed considered unusable
    // arriving from the ATS feed and being screened as if it were complete.
    // Not shared by import — a pure gate must not depend on a network module.
    expect(THIN_BODY_CHARS).toBe(MIN_DESCRIPTION_CHARS);
  });
});
