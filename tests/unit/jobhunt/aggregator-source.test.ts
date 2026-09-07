/**
 * Tests for the aggregator source adapters and sweep orchestrator.
 *
 * These test the pure conversion logic without hitting real APIs. Each adapter's
 * `toAggregatorJob` is tested via the public surface — constructing the source
 * and feeding it mocked fetch responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Arbeitnow ────────────────────────────────────────────────────────────────

describe("arbeitnow adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses a single-page response into AggregatorJobs", async () => {
    const mockResponse = {
      data: [
        {
          slug: "test-job",
          company_name: "TestCorp",
          title: "Senior Engineer",
          description: "Build things",
          remote: true,
          url: "https://www.arbeitnow.com/view/test-job",
          tags: ["typescript", "react"],
          location: "Amsterdam, NL",
          created_at: 1725148800, // 2024-09-01T00:00:00Z
        },
        {
          // Missing title — should be skipped
          company_name: "SkipCorp",
          title: "",
          url: "https://example.com/skip",
        },
      ],
      links: { next: null },
      meta: { current_page: 1 },
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { createArbeitnowSource } = await import(
      "../../../src/tools/jobhunt/aggregators/arbeitnow.js"
    );
    const source = createArbeitnowSource();
    const jobs = await source.fetchJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Senior Engineer",
      company: "TestCorp",
      source: "arbeitnow",
      location: "Amsterdam, NL",
    });
    expect(jobs[0]!.postedAt).toBeInstanceOf(Date);
  });

  it("returns empty on HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });

    const { createArbeitnowSource } = await import(
      "../../../src/tools/jobhunt/aggregators/arbeitnow.js"
    );
    const source = createArbeitnowSource();
    const jobs = await source.fetchJobs();

    expect(jobs).toHaveLength(0);
  });
});

// ── Remotive ─────────────────────────────────────────────────────────────────

describe("remotive adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses response into AggregatorJobs", async () => {
    const mockResponse = {
      "job-count": 1,
      jobs: [
        {
          id: 123,
          url: "https://remotive.com/remote-jobs/software-dev/test-123",
          title: "Backend Developer",
          company_name: "RemoteCo",
          category: "software-dev",
          tags: ["python"],
          publication_date: "2024-09-01T00:00:00",
          candidate_required_location: "Europe",
          description: "<p>Work remotely</p>",
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { createRemotiveSource } = await import(
      "../../../src/tools/jobhunt/aggregators/remotive.js"
    );
    const source = createRemotiveSource();
    const jobs = await source.fetchJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Backend Developer",
      company: "RemoteCo",
      source: "remotive",
      location: "Europe",
    });
  });
});

// ── Himalayas ────────────────────────────────────────────────────────────────

describe("himalayas adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses cursor-paginated response", async () => {
    const page1 = {
      jobs: [
        {
          id: "abc",
          title: "Full Stack Dev",
          companyName: "HimCorp",
          applicationUrl: "https://himalayas.app/jobs/abc/apply",
          description: "Build full stack",
          locationRestrictions: ["Netherlands", "Germany"],
          pubDate: "2024-09-01",
          categories: ["engineering"],
        },
      ],
      meta: { total: 1, nextCursor: null },
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(page1),
    });

    const { createHimalayasSource } = await import(
      "../../../src/tools/jobhunt/aggregators/himalayas.js"
    );
    const source = createHimalayasSource();
    const jobs = await source.fetchJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Full Stack Dev",
      company: "HimCorp",
      source: "himalayas",
      location: "Netherlands, Germany",
    });
  });
});

// ── Jobicy ───────────────────────────────────────────────────────────────────

describe("jobicy adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses response into AggregatorJobs", async () => {
    const mockResponse = {
      jobCount: 1,
      jobs: [
        {
          id: 456,
          url: "https://jobicy.com/jobs/456-test",
          jobTitle: "DevOps Engineer",
          companyName: "CloudCo",
          jobGeo: "Europe",
          jobDescription: "Deploy things",
          pubDate: "2024-09-01",
          jobIndustry: ["cloud"],
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const { createJobicySource } = await import(
      "../../../src/tools/jobhunt/aggregators/jobicy.js"
    );
    const source = createJobicySource();
    const jobs = await source.fetchJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "DevOps Engineer",
      company: "CloudCo",
      source: "jobicy",
      location: "Europe",
    });
  });
});

// ── Aggregator Sweep ─────────────────────────────────────────────────────────

describe("sweepAggregators", () => {
  it("converts aggregator jobs to FreeCandidate shape", async () => {
    // The sweep calls all sources. Mock fetch to return a known job from one
    // source and empty from the rest.
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (typeof url === "string" && url.includes("arbeitnow")) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              data: [
                {
                  title: "Engineer",
                  company_name: "ArbCorp",
                  url: "https://boards.greenhouse.io/arbcorp/jobs/123",
                  location: "NL",
                  description: "Build things",
                  created_at: 1725148800,
                },
              ],
              links: { next: null },
            }),
        };
      }
      // All other sources return empty
      return { ok: true, json: () => Promise.resolve({ data: [], jobs: [] }) };
    });

    try {
      const { sweepAggregators } = await import(
        "../../../src/tools/jobhunt/aggregator-source.js"
      );
      const result = await sweepAggregators();

      expect(result.candidates.length).toBeGreaterThanOrEqual(1);

      const arbCandidate = result.candidates.find(
        (c) => c.board.name === "ArbCorp",
      );
      expect(arbCandidate).toBeDefined();
      expect(arbCandidate!.title).toBe("Engineer");
      expect(arbCandidate!.description).toBe("Build things");

      // Board token should be harvested from the Greenhouse URL
      const ghToken = result.harvestedTokens.find(
        (t) => t.ats === "greenhouse" && t.token === "arbcorp",
      );
      expect(ghToken).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
