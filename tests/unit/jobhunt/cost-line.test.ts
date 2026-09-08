/**
 * Unit tests — A4: the cost line says which window, which failure, whose lane.
 *
 * FOUR MISLABELS IN FIVE LINES, all verified against the ledger on 2026-09-08:
 *
 *   1. The heading read `💰 WHAT TODAY COST` over a THREE-DAY window.
 *      `todaysSpend` has taken `now − 3 × 86_400_000` since it was written —
 *      deliberately, to match a sweep cadence that was every third day at the
 *      time — and the heading was never changed with it. Prod's 280 runs / 459
 *      postings match a 3-day SQL window exactly and a 1-day window not at all.
 *   2. `failed` counts LEDGER ROWS WHOSE `error` COLUMN IS NON-NULL, and the
 *      free lane writes one row per sweep with `error` set to
 *      `summariseFailures(sweep.failures)` — a summary of which BOARDS inside
 *      that sweep errored. So "280 of them failed" described 280 sweeps that
 *      ran, returned postings, and had a 404 or a 429 somewhere among 3,223
 *      boards. Every one of them worked.
 *   3. "…and were still billed for starting" is false on the free lane, which
 *      is the only lane running: `FREE_PRICING` is $0 and the cost column reads
 *      0.00 on every one of those rows.
 *   4. "the rest already in your list" is printed when `fresh === returned`,
 *      where "the rest" is the empty set.
 *
 * And the whole block is TENANT-WIDE — `job_ingest_runs` carries no profile
 * column — so Tashi's brief prints Pushkar's lane under a heading that reads as
 * hers. That one is not fixable here (it is carried defect Q-3); it is labelled
 * instead, because an unlabelled wrong number is the failure mode this whole
 * audit is about.
 */

import { describe, it, expect } from "vitest";
import { renderSpend, SPEND_WINDOW_DAYS } from "../../../src/tools/jobhunt/brief-sections.js";

/** The shape prod actually produced over the measured 3-day window. */
const PROD = { runs: 280, returned: 459, costUsd: 0, runsWithErrors: 280, fresh: 459 };

describe("A4 — the heading names the window it reports", () => {
  it("says three days, because three days is what it sums", () => {
    const out = renderSpend(PROD);
    expect(out).toContain("LAST 3 DAYS");
    expect(out).not.toContain("WHAT TODAY COST");
  });

  it("takes the number from the same constant the query does", () => {
    // Not two independent 3s. The heading and `todaysSpend`'s cutoff drifted
    // apart once already and nothing noticed for weeks.
    expect(SPEND_WINDOW_DAYS).toBe(3);
    expect(renderSpend(PROD)).toContain(`LAST ${SPEND_WINDOW_DAYS} DAYS`);
  });
});

describe("A4 — a board error is reported as a board error", () => {
  it("describes partial results, not a failed run", () => {
    const out = renderSpend(PROD);
    expect(out).toContain("280");
    expect(out.toLowerCase()).toContain("board");
    expect(out.toLowerCase()).toContain("partial");
  });

  it("stops claiming those runs were billed — the free lane costs nothing", () => {
    const out = renderSpend(PROD);
    expect(out).not.toContain("billed for starting");
    expect(out.toLowerCase()).not.toContain("of them failed");
  });

  it("says nothing at all when no run hit a board error", () => {
    const out = renderSpend({ ...PROD, runsWithErrors: 0 });
    expect(out.toLowerCase()).not.toContain("board");
  });
});

describe("A4 — the yield clause only claims a remainder that exists", () => {
  it("drops 'the rest already in your list' when there is no rest", () => {
    const out = renderSpend({ ...PROD, returned: 459, fresh: 459 });
    expect(out).not.toContain("already in your list");
    expect(out).toContain("459 new");
  });

  it("keeps it when some postings genuinely were already stored", () => {
    const out = renderSpend({ ...PROD, returned: 459, fresh: 12 });
    expect(out).toContain("12 new");
    expect(out).toContain("already in your list");
  });

  it("still shouts when a run bought nothing new — that line is load-bearing", () => {
    // 2026-08-02: 32 postings, $0.4682, every one already stored, and the brief
    // read like any other morning.
    const out = renderSpend({ runs: 14, returned: 32, costUsd: 0.4682, runsWithErrors: 0, fresh: 0 });
    expect(out.toLowerCase()).toContain("none of them new");
  });
});

describe("A4 — the block admits it is not about this candidate alone", () => {
  it("labels the figure tenant-wide", () => {
    const out = renderSpend(PROD).toLowerCase();
    expect(out).toContain("every candidate");
  });
});
