/**
 * Unit tests — ingest_jobs batch behaviour (DB + feed mocked).
 *
 * The sweep runs unattended, so the properties that matter are the ones nobody
 * will be watching: one bad posting must not take the batch down, an upstream
 * outage must not read as an empty market, and every posting must go through the
 * SAME gates the founder's manual paste uses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawPosting } from "../../../src/tools/jobhunt/ats-source.js";

const mockScreenPosting = vi.fn();
const mockFetch = vi.fn();

vi.mock("../../../src/tools/jobhunt/screen.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, screenPosting: mockScreenPosting };
});

vi.mock("../../../src/tools/jobhunt/ats-source.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, fetchAtsPostings: mockFetch };
});

const { screenBatch, runJobIngest, formatIngestSummary, ingestJobsTool, INGEST_SOURCE } =
  await import("../../../src/tools/jobhunt/ingest.js");

function posting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    company: "Acme BV",
    title: "AI Engineer",
    url: "https://example.com/job/1",
    description: "We use Kubernetes. Salary 5.000 euro per month. English speaking team.",
    location: "Amsterdam, North Holland, Netherlands",
    postedAt: new Date("2026-07-29T05:00:00Z"),
    ...overrides,
  };
}

function screened(status: "pass" | "flag" | "reject", company = "Acme BV") {
  return {
    kind: "screened" as const,
    company,
    title: "AI Engineer",
    route: "hsm" as const,
    verdict: { status, reasons: [`Sponsor: ${status} evidence`] },
    routesTried: 1,
    match: { verdict: "sponsor", candidates: [], evidence: "matched" },
    nearDuplicates: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("screenBatch", () => {
  it("stamps every row with the ingest provenance", async () => {
    mockScreenPosting.mockResolvedValue(screened("pass"));
    await screenBatch([posting()]);
    expect(mockScreenPosting).toHaveBeenCalledWith(
      expect.objectContaining({ source: INGEST_SOURCE }),
    );
  });

  it("passes the posting body through verbatim", async () => {
    mockScreenPosting.mockResolvedValue(screened("pass"));
    const p = posting();
    await screenBatch([p]);
    expect(mockScreenPosting).toHaveBeenCalledWith(
      expect.objectContaining({ description: p.description }),
    );
  });

  it("records each verdict against its posting", async () => {
    mockScreenPosting
      .mockResolvedValueOnce(screened("pass", "Alpha"))
      .mockResolvedValueOnce(screened("reject", "Beta"))
      .mockResolvedValueOnce(screened("flag", "Gamma"));

    const lines = await screenBatch([
      posting({ company: "Alpha" }),
      posting({ company: "Beta" }),
      posting({ company: "Gamma" }),
    ]);

    expect(lines.map((l) => l.outcome)).toEqual(["pass", "reject", "flag"]);
  });

  it("does not abort the batch when one posting throws", async () => {
    // Losing nine good screenings to the tenth bad one is the pipeline failing
    // at exactly the moment it is supposed to be unattended.
    mockScreenPosting
      .mockResolvedValueOnce(screened("pass", "Alpha"))
      .mockRejectedValueOnce(new Error("malformed body"))
      .mockResolvedValueOnce(screened("pass", "Gamma"));

    const lines = await screenBatch([
      posting({ company: "Alpha" }),
      posting({ company: "Beta" }),
      posting({ company: "Gamma" }),
    ]);

    expect(lines).toHaveLength(3);
    expect(lines[1]!.outcome).toBe("error");
    expect(lines[1]!.detail).toContain("malformed body");
    expect(lines.filter((l) => l.outcome === "pass")).toHaveLength(2);
  });

  it("reports a screening error without dropping the posting silently", async () => {
    mockScreenPosting.mockResolvedValue({ kind: "error", message: "tracker unreachable" });
    const lines = await screenBatch([posting()]);
    expect(lines[0]!.outcome).toBe("error");
    expect(lines[0]!.detail).toContain("tracker unreachable");
  });

  it("marks an already-engaged role as a skip, not a new screening", async () => {
    mockScreenPosting.mockResolvedValue({
      kind: "duplicate",
      company: "Acme BV",
      title: "AI Engineer",
      stage: "applied",
      appliedAt: new Date("2026-07-01T00:00:00Z"),
    });
    const lines = await screenBatch([posting()]);
    expect(lines[0]!.outcome).toBe("duplicate");
    expect(lines[0]!.detail).toContain("applied");
  });

  it("handles an empty batch", async () => {
    expect(await screenBatch([])).toEqual([]);
    expect(mockScreenPosting).not.toHaveBeenCalled();
  });
});

describe("runJobIngest", () => {
  it("surfaces a fetch failure instead of reporting an empty market", async () => {
    mockFetch.mockResolvedValue({ ok: false, error: "ATS feed upstream error: 521" });
    const result = await runJobIngest();
    expect(result.ok).toBe(false);
    expect(mockScreenPosting).not.toHaveBeenCalled();
  });

  it("screens everything the feed returned", async () => {
    mockFetch.mockResolvedValue({ ok: true, postings: [posting(), posting({ company: "Beta" })] });
    mockScreenPosting.mockResolvedValue(screened("pass"));
    const result = await runJobIngest();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary.fetched).toBe(2);
  });
});

describe("formatIngestSummary", () => {
  it("explains a zero result rather than leaving it ambiguous", () => {
    const out = formatIngestSummary({ fetched: 0, lines: [] });
    expect(out).toContain("0 postings");
    expect(out).toMatch(/narrow slice/i);
  });

  it("leads with the counts and groups by verdict", () => {
    const out = formatIngestSummary({
      fetched: 2,
      lines: [
        { company: "Alpha", title: "AI Engineer", outcome: "pass", detail: "clean" },
        { company: "Beta", title: "AI Engineer", outcome: "reject", detail: "not a sponsor" },
      ],
    });
    expect(out).toContain("2 postings screened");
    expect(out).toContain("pass: 1");
    expect(out).toContain("reject: 1");
    expect(out).toContain("Alpha");
    expect(out).toContain("not a sponsor");
  });

  it("omits groups with no members", () => {
    const out = formatIngestSummary({
      fetched: 1,
      lines: [{ company: "Alpha", title: "AI Engineer", outcome: "pass", detail: "clean" }],
    });
    expect(out).not.toContain("FAILED TO SCREEN");
  });
});

describe("ingestJobsTool", () => {
  it("refuses to fall back to web search when the feed is down", async () => {
    mockFetch.mockResolvedValue({ ok: false, error: "APIFY_TOKEN not set" });
    const res = await ingestJobsTool.execute({});
    expect(res.success).toBe(false);
    expect(res.error).toContain("APIFY_TOKEN not set");
    expect(res.error).toMatch(/no fallback to web search/i);
  });

  it("ignores an invalid time_range instead of passing it through", async () => {
    mockFetch.mockResolvedValue({ ok: true, postings: [] });
    await ingestJobsTool.execute({ time_range: "yesterday" });
    expect(mockFetch).toHaveBeenCalledWith(expect.not.objectContaining({ timeRange: "yesterday" }));
  });
});
