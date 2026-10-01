/**
 * Unit tests — what the free lane's ledger row says about dead boards.
 *
 * `job_ingest_runs.error` is the one place the founder (and, from the jobhunt
 * findings work, the analyzer) reads a sweep's board failures. Until dead boards were
 * skipped, every run said "30–33 board(s) failed: greenhouse HTTP 404 ×16–18; …".
 * Now the real failures keep the exact same text, and the skipped boards are one
 * separate clause: "… | skipped 27 dead boards".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const recordQueryCost = vi.fn(async (_input: Record<string, unknown>) => undefined);
vi.mock("../../../src/tools/jobhunt/ingest-ledger.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/tools/jobhunt/ingest-ledger.js")>()),
  recordQueryCost: (input: Record<string, unknown>) => recordQueryCost(input),
}));

import { runFreeIngest } from "../../../src/tools/jobhunt/free-ingest.js";
import { WIFE_FINANCE_PROFILE } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";
import type { BoardSweep } from "../../../src/tools/jobhunt/free-ats-source.js";

const NOW = new Date("2026-09-29T12:00:00.000Z");

/** An empty sweep: nothing to screen, so the ledger row is the only thing under test. */
function sweep(over: Partial<BoardSweep>): BoardSweep {
  return { candidates: [], failures: [], boardsPolled: 1200, skippedDead: [], ...over };
}

async function ledgerError(over: Partial<BoardSweep>): Promise<unknown> {
  recordQueryCost.mockClear();
  await runFreeIngest({ sweep: sweep(over), now: NOW, profile: WIFE_FINANCE_PROFILE });
  expect(recordQueryCost).toHaveBeenCalledTimes(1);
  const row = recordQueryCost.mock.calls[0]?.[0] ?? {};
  return "error" in row ? row["error"] : undefined;
}

const REAL_FAILURES = [
  "greenhouse/a: HTTP 404",
  "greenhouse/b: HTTP 404",
  "ashby/c: HTTP 500",
];

beforeEach(() => recordQueryCost.mockClear());

describe("job_ingest_runs.error for the free lane", () => {
  it("keeps the 'N board(s) failed: …' text exactly as it was when there are only real failures", async () => {
    expect(await ledgerError({ failures: REAL_FAILURES })).toBe(
      "3 board(s) failed: greenhouse HTTP 404 ×2; ashby HTTP 500 ×1",
    );
  });

  it("says 'skipped N dead boards' when the only thing that happened is that dead boards sat out", async () => {
    const skippedDead = Array.from({ length: 27 }, (_, i) => `greenhouse/dead-${i}`);
    expect(await ledgerError({ skippedDead })).toBe("skipped 27 dead boards");
  });

  it("appends the skip count as a separate clause after real failures, without disturbing them", async () => {
    const skippedDead = Array.from({ length: 27 }, (_, i) => `greenhouse/dead-${i}`);
    expect(await ledgerError({ failures: REAL_FAILURES, skippedDead })).toBe(
      "3 board(s) failed: greenhouse HTTP 404 ×2; ashby HTTP 500 ×1 | skipped 27 dead boards",
    );
  });

  it("writes no error at all on a clean sweep — an error column means something happened", async () => {
    expect(await ledgerError({})).toBeUndefined();
  });

  it("tolerates a sweep built by a caller that predates the skip list", async () => {
    const { skippedDead: _omitted, ...legacy } = sweep({ failures: REAL_FAILURES });
    recordQueryCost.mockClear();
    await runFreeIngest({ sweep: legacy, now: NOW, profile: WIFE_FINANCE_PROFILE });
    expect(recordQueryCost.mock.calls[0]?.[0]?.["error"]).toBe(
      "3 board(s) failed: greenhouse HTTP 404 ×2; ashby HTTP 500 ×1",
    );
  });
});
