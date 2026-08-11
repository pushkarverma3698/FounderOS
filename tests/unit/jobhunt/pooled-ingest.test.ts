/**
 * Unit tests — the pooled sweep (feed + screening mocked).
 *
 * This runs at 01:30 UTC with nobody watching, so the properties that matter are
 * the ones that fail silently: one pool dying must not take the others with it,
 * a dead source must not read as a thin market, and the budget must not be
 * consumed by the first pool before the remote-contract pools are reached — that
 * last one being the exact coverage hole this design exists to close.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawPosting } from "../../../src/tools/jobhunt/ats-source.js";

const mockScreenPosting = vi.fn();
const mockFetchAts = vi.fn();
const mockFetchIndeed = vi.fn();
const mockRecordQueryCost = vi.fn(async () => {});
const mockCheckSweepBudget = vi.fn();

/**
 * The cost ledger is a DATABASE WRITE and this is a unit test.
 *
 * It was not mocked until 2026-08-01, and the omission was invisible because
 * `recordQueryCost` swallows its own errors — so on CI, where no Postgres is
 * running, every call sat through a connection timeout and then succeeded
 * quietly. Each test paid that once per query: at 10 queries the file took ~17s
 * a test and stayed under vitest's 30s limit, and the moment the India pool took
 * it to 14 the two slowest tests tipped over and the suite went red on timing
 * rather than on behaviour.
 *
 * Mocked here rather than by raising the timeout: a unit test that opens a
 * database connection is the bug, and a longer timeout would only hide it until
 * the next query was added.
 */
vi.mock("../../../src/tools/jobhunt/ingest-ledger.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, recordQueryCost: mockRecordQueryCost };
});

/**
 * The spend gate reads the cost ledger, which is a DATABASE READ.
 *
 * Same reasoning as `recordQueryCost` above: unmocked, every test sat through a
 * Postgres connection timeout before the gate failed open, which took this file
 * from ~100ms to 1.6s and would have kept climbing with each new query. A unit
 * test that opens a connection is the bug. `spend-gate.test.ts` covers the
 * decision itself, against numbers rather than a database.
 */
vi.mock("../../../src/tools/jobhunt/spend-gate.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, checkSweepBudget: mockCheckSweepBudget };
});

vi.mock("../../../src/tools/jobhunt/screen.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, screenPosting: mockScreenPosting };
});

vi.mock("../../../src/tools/jobhunt/ats-source.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchAtsPostings: mockFetchAts };
});

vi.mock("../../../src/tools/jobhunt/indeed-source.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchIndeedPostings: mockFetchIndeed };
});

const { runPooledIngest, INGEST_SOURCE } = await import("../../../src/tools/jobhunt/ingest.js");
const { POOL_ORDER } = await import("../../../src/tools/jobhunt/ats-source.js");
const { INDEED_SOURCE } = await import("../../../src/tools/jobhunt/indeed-source.js");
const { TRACK_PRIORITY, TRACK_TITLES } = await import("../../../src/tools/jobhunt/tracks.js");

/** One actor run per pool per track — the guarantee that no track can be starved. */
const ATS_QUERIES = POOL_ORDER.length * TRACK_PRIORITY.length;

function posting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    company: "Acme BV",
    title: "AI Engineer",
    url: "https://example.com/job/1",
    description: "We use Kubernetes. English speaking team.",
    location: "Amsterdam, Netherlands",
    postedAt: new Date("2026-07-30T05:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckSweepBudget.mockResolvedValue({
    ok: true,
    reason: "$0.10 spent this cycle of $2.00; this sweep projects $0.30.",
    spentUsd: 0.1,
    projectedUsd: 0.3,
    capUsd: 2,
    remainingUsd: 1.9,
  });
  mockScreenPosting.mockResolvedValue({
    kind: "screened",
    company: "Acme BV",
    title: "AI Engineer",
    route: "hsm",
    track: "ai",
    verdict: { status: "pass", reasons: ["Sponsor: matched"] },
    routesTried: 1,
    match: { verdict: "sponsor", candidates: [], evidence: "matched" },
    nearDuplicates: [],
  });
  mockFetchAts.mockResolvedValue({ ok: true, postings: [posting()] });
  mockFetchIndeed.mockResolvedValue({ ok: true, postings: [], droppedThin: 0 });
});

describe("runPooledIngest", () => {
  it("queries every pool, not just the first", async () => {
    await runPooledIngest({ limit: 30 });
    expect(mockFetchAts).toHaveBeenCalledTimes(ATS_QUERIES);
  });

  it("gives EVERY track its own query, so no track can be starved by another", async () => {
    // The 2026-08-01 defect: all twelve title phrases went into one titleSearch
    // with one budget, AI first. Frontend — the deepest track on the CV — came
    // back empty, and an unasked track is indistinguishable from an empty one.
    await runPooledIngest({ limit: 30 });

    for (const track of TRACK_PRIORITY) {
      const callsForTrack = mockFetchAts.mock.calls.filter(
        (c) => JSON.stringify(c[0].titles) === JSON.stringify(TRACK_TITLES[track]),
      );
      expect(callsForTrack, track).toHaveLength(POOL_ORDER.length);
    }
  });

  it("reports a track that fetched nothing instead of staying quiet about it", async () => {
    mockFetchAts.mockResolvedValue({ ok: true, postings: [] });
    const result = await runPooledIngest({ limit: 30 });
    for (const track of TRACK_PRIORITY) {
      expect(result.perTrack[track]).toBe(0);
      expect(result.failures.some((f) => f.includes(`Track "${track}": 0 postings`))).toBe(true);
    }
  });

  it("SCREENS early-career postings instead of dropping them before the table", async () => {
    // Reversed on 2026-08-01. These used to be dropped here, before screening,
    // so they never reached job_applications and the founder could not audit
    // what had been thrown away for him — a filter and an empty market look
    // identical from outside. The founder's instruction was explicit: "store all
    // the data we are collecting even if it is senior and of no use to us".
    // The Experience gate rejects them now, WITH a stored reason.
    mockFetchAts.mockResolvedValue({
      ok: true,
      postings: [posting(), posting({ title: "Software Engineer Intern" })],
    });

    const result = await runPooledIngest({ limit: 30 });

    const screenedTitles = mockScreenPosting.mock.calls.map((c) => c[0].title);
    expect(screenedTitles).toContain("Software Engineer Intern");
    expect(result.fetched).toBe(POOL_ORDER.length * TRACK_PRIORITY.length * 2);
  });

  it("splits the budget across pools instead of spending it first-come", async () => {
    // Pool A returns the most rows. A shared allowance would be gone before the
    // remote pools were ever reached, which is how remote-contract ended up with
    // a gate and no funnel.
    await runPooledIngest({ limit: 30 });
    for (const call of mockFetchAts.mock.calls) {
      expect(call[0].limit).toBe(10);
    }
  });

  it("never asks for fewer than the actor's minimum", async () => {
    await runPooledIngest({ limit: 3 });
    for (const call of mockFetchAts.mock.calls) {
      expect(call[0].limit).toBeGreaterThanOrEqual(10);
    }
  });

  it("keeps screening when ONE pool fails, and names the failure", async () => {
    mockFetchAts
      .mockResolvedValueOnce({ ok: true, postings: [posting()] })
      .mockResolvedValueOnce({ ok: false, error: "HTTP 521" })
      .mockResolvedValueOnce({ ok: true, postings: [posting()] });

    const result = await runPooledIngest({ limit: 30 });

    // One query of the nine died; the other eight still produced a posting each.
    expect(result.fetched).toBe(ATS_QUERIES - 1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("HTTP 521");
    // Queries run pool-major, so the second one is the first pool paired with
    // the SECOND track in priority order.
    expect(result.failures[0]).toContain("netherlands");
    expect(result.failures[0]).toContain(TRACK_PRIORITY[1]!);
  });

  it("reports every pool failing as failures, NOT as an empty market", async () => {
    mockFetchAts.mockResolvedValue({ ok: false, error: "upstream down" });
    const result = await runPooledIngest({ limit: 30 });
    expect(result.fetched).toBe(0);
    // One per dead query, plus one per track that consequently fetched nothing.
    expect(result.failures).toHaveLength(ATS_QUERIES + TRACK_PRIORITY.length);
  });

  it("stamps ATS rows with the ATS provenance", async () => {
    await runPooledIngest({ limit: 30 });
    for (const call of mockScreenPosting.mock.calls) {
      expect(call[0].source).toBe(INGEST_SOURCE);
    }
  });

  it("leaves Indeed alone unless it is asked for", async () => {
    await runPooledIngest({ limit: 30 });
    expect(mockFetchIndeed).not.toHaveBeenCalled();
  });

  it("preserves an Indeed row's OWN provenance and job key", async () => {
    // Liveness reads `source` to decide which check to run. Recording an Indeed
    // row as an ATS row would silently downgrade it to a URL fetch — the check
    // ghost postings are best at passing.
    mockFetchAts.mockResolvedValue({ ok: true, postings: [] });
    mockFetchIndeed.mockResolvedValue({
      ok: true,
      postings: [posting({ source: INDEED_SOURCE, externalId: "jk123" })],
      droppedThin: 0,
    });

    await runPooledIngest({ limit: 30, includeIndeed: true });

    const indeedCalls = mockScreenPosting.mock.calls.filter(
      (c) => c[0].source === INDEED_SOURCE,
    );
    expect(indeedCalls.length).toBeGreaterThan(0);
    expect(indeedCalls[0]![0].externalId).toBe("jk123");
  });

  it("surfaces dropped thin bodies rather than letting them look like a thin market", async () => {
    mockFetchAts.mockResolvedValue({ ok: true, postings: [] });
    mockFetchIndeed.mockResolvedValue({ ok: true, postings: [], droppedThin: 7 });

    const result = await runPooledIngest({ limit: 30, includeIndeed: true });

    expect(result.failures.some((f) => f.includes("7 posting(s) dropped"))).toBe(true);
  });

  it("keeps the ATS pools when Indeed fails entirely", async () => {
    mockFetchIndeed.mockResolvedValue({ ok: false, error: "actor timeout" });
    const result = await runPooledIngest({ limit: 30, includeIndeed: true });
    expect(result.fetched).toBe(ATS_QUERIES);
    expect(result.failures.some((f) => f.includes("actor timeout"))).toBe(true);
  });

  /**
   * A sweep that FETCHES fine and then fails to screen anything is an outage,
   * and until 2026-08-05 it was reported as a quiet market.
   *
   * `failures` was fed only by fetch errors and empty tracks. When the sponsor
   * register stopped resolving in the built output, every posting came back
   * `kind: "error"`, `failures` stayed empty, and the brief said nothing was
   * wrong for four consecutive sweeps.
   */
  it("reports a total screening failure as a failure, not as a thin market", async () => {
    // Arrange — the feed is healthy; the gates are not.
    mockScreenPosting.mockResolvedValue({
      kind: "error",
      message: "IND sponsor register unreadable at /opt/founderos/dist/docs/…: ENOENT",
    });

    // Act
    const result = await runPooledIngest({ limit: 30 });

    // Assert — the founder must be told, and told WHY.
    expect(result.failures.some((f) => f.includes("failed to screen"))).toBe(true);
    expect(result.failures.some((f) => f.includes("ENOENT"))).toBe(true);
  });

  /**
   * The cap must stop the spend, not merely record it.
   *
   * The account is on Apify's FREE plan with a $5 hard platform cap shared with
   * the research actors, and until 2026-08-05 nothing in the pipeline could
   * refuse to spend — the cadence was the only brake, and the cadence does not
   * know the balance.
   */
  it("buys nothing at all when the sweep would cross the spend cap", async () => {
    mockCheckSweepBudget.mockResolvedValue({
      ok: false,
      reason: "Sweep SKIPPED to stay under the cap. $1.90 already spent this cycle of $2.00.",
      spentUsd: 1.9,
      projectedUsd: 0.3,
      capUsd: 2,
      remainingUsd: 0.1,
    });

    const result = await runPooledIngest({ limit: 30, includeIndeed: true });

    // Not one actor run — the refusal has to come BEFORE the money is spent.
    expect(mockFetchAts).not.toHaveBeenCalled();
    expect(mockFetchIndeed).not.toHaveBeenCalled();
    expect(result.fetched).toBe(0);
  });

  it("says out loud that it skipped the sweep, rather than reporting an empty market", async () => {
    mockCheckSweepBudget.mockResolvedValue({
      ok: false,
      reason: "Sweep SKIPPED to stay under the cap. $1.90 already spent this cycle of $2.00.",
      spentUsd: 1.9,
      projectedUsd: 0.3,
      capUsd: 2,
      remainingUsd: 0.1,
    });

    const result = await runPooledIngest({ limit: 30 });

    expect(result.failures.some((f) => f.includes("SKIPPED"))).toBe(true);
  });

  it("does not cry outage when screening merely rejects everything", async () => {
    // Rejection is the gates working. Only an `error` outcome is a fault, and
    // conflating the two would make the alarm useless within a week.
    mockScreenPosting.mockResolvedValue({
      kind: "screened",
      company: "Acme BV",
      title: "AI Engineer",
      route: "hsm",
      track: "ai",
      verdict: { status: "reject", reasons: ["Sponsor: not on the register"] },
      routesTried: 1,
      match: { verdict: "not-sponsor", candidates: [], evidence: "no match" },
      nearDuplicates: [],
    });

    const result = await runPooledIngest({ limit: 30 });

    expect(result.failures.some((f) => f.includes("failed to screen"))).toBe(false);
  });
});
