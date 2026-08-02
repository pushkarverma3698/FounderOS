/**
 * Unit tests — telling a NEW posting from one the sweep has already paid for.
 *
 * THE DEFECT THIS CLOSES (live prod, 2026-08-02 01:30 UTC). The sweep returned
 * 32 postings, screened 27, cost $0.4682 — and added ZERO rows to
 * `job_applications`. Every posting it bought was already there. The brief
 * reported "27 screened" and read exactly like a productive morning.
 *
 * The feed bills per job RETURNED, not per job that turns out to be useful, so a
 * sweep that re-buys yesterday's inventory costs full price for nothing. Nothing
 * anywhere counted new-versus-already-seen, which means a sweep that surfaces 27
 * fresh roles and a sweep that surfaces none render identically — the failing
 * direction is the silent one, again.
 *
 * `screenPosting` already loads the existing row to check for engagement, so
 * "have we seen this before" costs no extra query. It just had to be reported.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFind = vi.fn(async (_key: string) => null as Record<string, unknown> | null);
const mockSoft = vi.fn(async (_soft: string, _exclude: string) => [] as Record<string, unknown>[]);
const mockRecord = vi.fn(async (row: Record<string, unknown>) => ({ id: "ja1", ...row }));

vi.mock("../../../src/db/cv-signal-queries.js", () => ({
  recordSignals: vi.fn(async () => 0),
  listSignals: vi.fn(async () => []),
}));

vi.mock("../../../src/db/job-queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    findApplicationByDedupeKey: mockFind,
    findApplicationsBySoftKey: mockSoft,
    recordScreenedApplication: mockRecord,
  };
});

const mockRecordIngestRun = vi.fn(async (row: Record<string, unknown>) => ({ id: "r1", ...row }));
vi.mock("../../../src/db/job-run-queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, recordIngestRun: mockRecordIngestRun };
});

const { screenPosting } = await import("../../../src/tools/jobhunt/screen.js");
const { screenBatch } = await import("../../../src/tools/jobhunt/ingest-batch.js");
const { renderSpend } = await import("../../../src/tools/jobhunt/brief-sections.js");
const { recordQueryCost } = await import("../../../src/tools/jobhunt/ingest-ledger.js");
const { ATS_PRICING } = await import("../../../src/tools/jobhunt/cost.js");
const { JOB_SWEEP_CRON } = await import("../../../src/infra/scheduler.js");

/** A body long enough to clear the thin-posting gate. */
const BODY =
  "We are hiring a backend engineer to work on our payments platform in Amsterdam. " +
  "You will build services in TypeScript and Go, own them in production, and work " +
  "with Kubernetes and Postgres. We ask for 2 to 4 years of experience. Our team " +
  "speaks English. Salary 65.000 - 80.000 EUR per year depending on experience. " +
  "We are an IND recognised sponsor and support relocation to the Netherlands.";

function posting(overrides: Record<string, unknown> = {}) {
  return {
    company: "Adyen",
    title: "Backend Engineer",
    description: BODY,
    location: "Amsterdam, Netherlands",
    country: "NL" as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue(null);
  mockSoft.mockResolvedValue([]);
});

describe("screenPosting — is this posting new?", () => {
  it("reports a posting the tracker has never seen as NEW", async () => {
    mockFind.mockResolvedValue(null);

    const outcome = await screenPosting(posting());

    expect(outcome.kind).toBe("screened");
    if (outcome.kind !== "screened") return;
    expect(outcome.isNew).toBe(true);
  });

  it("reports a RE-SIGHTED posting as not new, even though it still screens", async () => {
    // The row exists but the founder has not engaged with it, so it is still
    // re-screened and still upserted — it is simply not a new find, and the
    // difference is the entire point of the count.
    mockFind.mockResolvedValue({ id: "ja1", stage: "screened", applied_at: null });

    const outcome = await screenPosting(posting());

    expect(outcome.kind).toBe("screened");
    if (outcome.kind !== "screened") return;
    expect(outcome.isNew).toBe(false);
  });
});

describe("screenBatch — carrying the count to the ledger", () => {
  it("marks each line with whether its posting was new", async () => {
    mockFind.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "ja1",
      stage: "screened",
      applied_at: null,
    });

    const lines = await screenBatch([
      { ...posting(), url: "https://x/1", postedAt: null },
      { ...posting({ title: "Platform Engineer" }), url: "https://x/2", postedAt: null },
    ] as never);

    expect(lines).toHaveLength(2);
    expect(lines[0]!.isNew).toBe(true);
    expect(lines[1]!.isNew).toBe(false);
  });

  it("never counts an errored posting as a new find", async () => {
    mockFind.mockRejectedValue(new Error("tracker down"));

    const lines = await screenBatch([
      { ...posting(), url: "https://x/1", postedAt: null },
    ] as never);

    expect(lines[0]!.outcome).toBe("error");
    expect(lines[0]!.isNew).toBe(false);
  });
});

describe("renderSpend — a sweep that bought nothing new must say so", () => {
  it("names the zero in words rather than printing a bare 0", async () => {
    const out = renderSpend({ runs: 14, returned: 32, costUsd: 0.4682, failed: 0, fresh: 0 });

    expect(out).toContain("$0.47");
    expect(out).toContain("32 postings");
    // The whole reason this line exists: "0 new" set in the same grey as every
    // other number is exactly how the 2026-08-02 sweep read as a normal morning.
    expect(out.toLowerCase()).toContain("none of them new");
    expect(out).toContain("already");
  });

  it("reports a productive sweep as a plain count", async () => {
    const out = renderSpend({ runs: 14, returned: 32, costUsd: 0.4682, failed: 0, fresh: 9 });

    expect(out).toContain("9 new");
    expect(out.toLowerCase()).not.toContain("none of them new");
  });

  it("counts one new role in the singular", async () => {
    const out = renderSpend({ runs: 14, returned: 32, costUsd: 0.4682, failed: 0, fresh: 1 });

    expect(out).toContain("1 new");
  });
});

describe("the ledger records yield per QUERY, not just per sweep", () => {
  it("writes how many of a query's postings were new", async () => {
    await recordQueryCost({
      sweepId: "11111111-1111-1111-1111-111111111111",
      feed: "ats",
      pool: "india",
      track: "backend",
      requested: 10,
      returned: 3,
      pricing: ATS_PRICING,
      lines: [
        { company: "A", title: "T", outcome: "pass", detail: "", isNew: true },
        { company: "B", title: "T", outcome: "flag", detail: "", isNew: false },
        { company: "C", title: "T", outcome: "reject", detail: "", isNew: true },
      ],
    });

    expect(mockRecordIngestRun).toHaveBeenCalledTimes(1);
    const row = mockRecordIngestRun.mock.calls[0]![0]!;
    expect(row["screened"]).toBe(3);
    // Which POOL still finds new roles is what decides where to cut cost, and
    // job_applications cannot answer it — it never records the query that
    // found a row.
    expect(row["fresh"]).toBe(2);
  });

  it("records zero new without failing, because that is the case that matters", async () => {
    await recordQueryCost({
      sweepId: "11111111-1111-1111-1111-111111111111",
      feed: "ats",
      pool: "netherlands",
      track: "ai",
      requested: 10,
      returned: 2,
      pricing: ATS_PRICING,
      lines: [
        { company: "A", title: "T", outcome: "pass", detail: "", isNew: false },
        { company: "B", title: "T", outcome: "flag", detail: "", isNew: false },
      ],
    });

    const row = mockRecordIngestRun.mock.calls[0]![0]!;
    expect(row["returned"]).toBe(2);
    expect(row["fresh"]).toBe(0);
  });
});

describe("sweep cadence", () => {
  it("runs every third day, not daily", () => {
    // Founder decision, 2026-08-02. Pinned as a constant rather than left as a
    // string at the call site: reverting to daily is a one-character edit that
    // triples the bill, and nothing else in the system would notice.
    expect(JOB_SWEEP_CRON).toBe("30 1 */3 * *");
  });

  it("still lands at 07:00 IST, before the founder's day starts", () => {
    const [minute, hour] = JOB_SWEEP_CRON.split(" ");
    expect(`${hour}:${minute}`).toBe("1:30");
  });
});
