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
import { tally } from "../../../src/tools/jobhunt/ingest-ledger.js";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest.js";
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
  it("runs 12 ATS queries — three pools, four tracks", () => {
    // Was 8. The two Netherlands pools differed in exactly one field and were
    // billed a separate actor start every day for it; merging them saved four
    // starts a day at identical coverage, and that saving is what pays for the
    // `india` pool added on 2026-08-01. The founder chose that trade knowing the
    // price (~+$0.45/sweep): the alternative was a second market whose entire
    // on-site supply — most of Indian hiring — stayed unreachable.
    expect(POOL_ORDER.length * TRACK_PRIORITY.length).toBe(12);
  });

  it("bills one actor start per market, not one per city", () => {
    // The India pool asks for the bare country rather than six hub cities. Same
    // coverage, one start instead of six per track.
    expect(POOL_ORDER).toContain("india");
    expect(POOL_ORDER).toHaveLength(3);
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

/**
 * The ledger must account for every screened posting.
 *
 * `IngestLine.outcome` has five values; the tally counted three. `duplicate`
 * and `error` lines landed in `screened` and appeared in no other column, so a
 * sweep in which EVERY posting failed was recorded as "27 screened, 0 passed,
 * 0 flagged, 0 rejected" — arithmetically identical to a market that simply had
 * nothing to offer. That ambiguity is what hid the 2026-08-02 sponsor-register
 * outage for four days and ~$0.77 of Apify spend.
 */
describe("tally", () => {
  const line = (outcome: IngestLine["outcome"], detail = ""): IngestLine => ({
    company: "Acme",
    title: "Engineer",
    outcome,
    detail,
    isNew: false,
  });

  it("accounts for every line it was given", () => {
    // Arrange — one of each outcome the pipeline can produce.
    const lines = [
      line("pass"),
      line("flag"),
      line("reject"),
      line("duplicate"),
      line("error"),
    ];

    // Act
    const counts = tally(lines);

    // Assert — the columns must sum to the total, or the ledger is lying.
    expect(counts.screened).toBe(5);
    expect(
      counts.passed + counts.flagged + counts.rejected + counts.duplicates + counts.errored,
    ).toBe(counts.screened);
  });

  it("records a sweep where everything errored as errored, not as an empty market", () => {
    // The exact shape of 2026-08-02: 27 postings, every one throwing ENOENT on
    // the sponsor register.
    const lines = Array.from({ length: 27 }, () =>
      line("error", "IND sponsor register unreadable at /opt/founderos/dist/docs/…: ENOENT"),
    );

    const counts = tally(lines);

    expect(counts.screened).toBe(27);
    expect(counts.errored).toBe(27);
    expect(counts.passed).toBe(0);
  });

  it("keeps the error text, so the cause survives the sweep", () => {
    // The message existed on IngestLine.detail all along and was never logged
    // and never persisted, which is why the root cause took a code audit to
    // find rather than a database query.
    const counts = tally([line("error", "sponsor register unreadable: ENOENT")]);
    expect(counts.screenError).toContain("ENOENT");
  });

  it("reports the commonest error when a query fails several ways", () => {
    const counts = tally([
      line("error", "tracker unreachable"),
      line("error", "sponsor register unreadable"),
      line("error", "sponsor register unreadable"),
    ]);
    expect(counts.screenError).toContain("sponsor register unreadable");
  });

  it("leaves the error text null when nothing errored", () => {
    expect(tally([line("pass"), line("reject")]).screenError).toBeNull();
  });
});
