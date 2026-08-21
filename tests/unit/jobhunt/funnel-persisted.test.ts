/**
 * The funnel reaches the database, not just journalctl
 * =====================================================
 * `runFreeIngest` built the six-stage funnel from the first day and dropped it
 * at the ledger boundary. The counts existed, on every sweep, in memory, and
 * were written only to a log line.
 *
 * That is how the largest defect in this lane stayed invisible for three weeks:
 * on 2026-08-21 answering "are we dropping roles?" needed `journalctl` on the
 * production box and a regex over 36 hours of output, and the answer was that
 * `stale` had been discarding 24,446 postings a sweep against 554 rows held
 * lifetime — so ≥23,892 open roles had never been screened once.
 *
 * These tests pin the seam, not the numbers: a funnel handed to
 * `recordQueryCost` must arrive at the row, and a lane that computes no funnel
 * must leave the columns NULL rather than zero.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const recordIngestRun = vi.fn(async (_row: Record<string, unknown>) => undefined);

vi.mock("../../../src/db/job-run-queries.js", () => ({
  recordIngestRun: (row: Record<string, unknown>) => recordIngestRun(row),
}));

beforeEach(() => {
  recordIngestRun.mockClear();
});

const PRICING = {
  free: { perJobUsd: 0, perStartUsd: 0 },
  paid: { perJobUsd: 0, perStartUsd: 0 },
} as never;

async function record(entry: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { recordQueryCost } = await import("../../../src/tools/jobhunt/ingest-ledger.js");
  await recordQueryCost({
    sweepId: "00000000-0000-0000-0000-000000000001",
    feed: "free-ats",
    pool: "free-boards",
    track: "all",
    requested: 38056,
    returned: 6,
    pricing: PRICING,
    lines: [],
    ...entry,
  } as never);
  return (recordIngestRun.mock.calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

describe("job_ingest_runs funnel columns", () => {
  it("writes every stage the free lane measured", async () => {
    // The real numbers from the 2026-08-21 sweep that produced this change.
    const row = await record({
      funnel: {
        seen: 38056,
        undated: 23,
        stale: 24446,
        offTrack: 11880,
        offMarket: 1338,
        known: 352,
        bodyless: 11,
      },
    });

    expect(row["seen"]).toBe(38056);
    expect(row["undated"]).toBe(23);
    expect(row["stale"]).toBe(24446);
    expect(row["off_track"]).toBe(11880);
    expect(row["off_market"]).toBe(1338);
    expect(row["known"]).toBe(352);
    expect(row["bodyless"]).toBe(11);
  });

  // NULL and 0 mean opposite things here. The metered ATS/Indeed lane computes
  // no funnel; writing zeros for it would say "measured, and nothing was
  // dropped" — the same conflation that let four days of total screening
  // failure read as a quiet market in 2026-08.
  it("leaves the columns absent when the lane measured no funnel", async () => {
    const row = await record({ feed: "ats" });
    for (const col of ["seen", "undated", "stale", "off_track", "off_market", "known", "bodyless"]) {
      expect(row).not.toHaveProperty(col);
    }
  });

  it("still records the cost columns alongside the funnel", async () => {
    const row = await record({
      funnel: { seen: 10, undated: 0, stale: 4, offTrack: 3, offMarket: 1, known: 1, bodyless: 0 },
    });
    expect(row["requested"]).toBe(38056);
    expect(row["returned"]).toBe(6);
    expect(row["feed"]).toBe("free-ats");
  });

  // The stages must account for every posting the sweep saw. A funnel whose
  // parts do not reach the whole is a funnel with a silent seventh drop in it.
  it("the recorded stages plus what was screened account for everything seen", async () => {
    const funnel = {
      seen: 38056,
      undated: 23,
      stale: 24446,
      offTrack: 11880,
      offMarket: 1338,
      known: 352,
      bodyless: 11,
    };
    const row = await record({ funnel, returned: 6 });
    const dropped =
      Number(row["undated"]) +
      Number(row["stale"]) +
      Number(row["off_track"]) +
      Number(row["off_market"]) +
      Number(row["known"]) +
      Number(row["bodyless"]);
    expect(dropped + Number(row["returned"])).toBe(Number(row["seen"]));
  });
});
