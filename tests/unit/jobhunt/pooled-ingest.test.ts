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
    expect(mockFetchAts).toHaveBeenCalledTimes(POOL_ORDER.length);
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

    expect(result.fetched).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("HTTP 521");
    expect(result.failures[0]).toContain("nl-remote");
  });

  it("reports every pool failing as failures, NOT as an empty market", async () => {
    mockFetchAts.mockResolvedValue({ ok: false, error: "upstream down" });
    const result = await runPooledIngest({ limit: 30 });
    expect(result.fetched).toBe(0);
    expect(result.failures).toHaveLength(POOL_ORDER.length);
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
    expect(result.fetched).toBe(POOL_ORDER.length);
    expect(result.failures.some((f) => f.includes("actor timeout"))).toBe(true);
  });
});
