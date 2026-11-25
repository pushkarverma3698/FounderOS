/**
 * A rejected Apify token starts no run and bills nothing, so the ledger must
 * record $0 and the founder must get one line instead of N raw JSON bodies.
 * A normal run (and a failure after a run started) is charged as before.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const recordIngestRun = vi.fn();
vi.mock("../../../src/db/job-run-queries.js", () => ({ recordIngestRun: (...a: unknown[]) => recordIngestRun(...a) }));

import { recordQueryCost } from "../../../src/tools/jobhunt/ingest-ledger.js";
import { ATS_PRICING, isApifyAuthRefusal, summariseSweepFailures } from "../../../src/tools/jobhunt/cost.js";

const body = '{"error":{"type":"user-or-token-not-found","message":"User was not found or authentication token is not valid"}}';
const entry = { sweepId: "s", feed: "ats" as const, pool: "p", track: "t", requested: 10, returned: 0, pricing: ATS_PRICING };

beforeEach(() => recordIngestRun.mockReset());

describe("ledger cost for auth refusals", () => {
  it.each([401, 403])("records $0 for HTTP %i", async (code) => {
    await recordQueryCost({ ...entry, error: `Apify actor a returned HTTP ${code}: ${body}` });
    expect(Number(recordIngestRun.mock.calls[0]![0].estimated_cost_usd)).toBe(0);
  });

  it("still charges the start for a failure after a run started (500)", async () => {
    await recordQueryCost({ ...entry, error: "Apify actor a returned HTTP 500: boom" });
    expect(Number(recordIngestRun.mock.calls[0]![0].estimated_cost_usd)).toBeGreaterThan(0);
  });

  it("still charges a normal run", async () => {
    await recordQueryCost({ ...entry, returned: 10 });
    expect(Number(recordIngestRun.mock.calls[0]![0].estimated_cost_usd)).toBeGreaterThan(0.1);
  });
});

describe("summariseSweepFailures", () => {
  it("collapses 14 identical 401s to one plain line", () => {
    const f = Array.from({ length: 14 }, (_, i) => `ATS pool "p${i}" / t: Apify actor a returned HTTP 401: ${body}`);
    const out = summariseSweepFailures(f);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Apify token rejected (401) on 14 call(s)");
    expect(out[0]).not.toContain("user-or-token-not-found");
  });

  it("keeps non-auth failures as they were", () => {
    const out = summariseSweepFailures(["x: returned HTTP 401: a", "y: timeout"]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("y: timeout");
  });

  it("matches only auth statuses", () => {
    expect(isApifyAuthRefusal("returned HTTP 4010")).toBe(false);
    expect(isApifyAuthRefusal("returned HTTP 429: x")).toBe(false);
    expect(isApifyAuthRefusal(undefined)).toBe(false);
  });
});
