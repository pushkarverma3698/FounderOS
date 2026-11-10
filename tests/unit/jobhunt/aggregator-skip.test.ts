/**
 * A cooldown skip (`fetchJobs` -> null) must be distinguishable from a real
 * zero-job fetch. Prod looked dead on 2026-11-10 because both logged as 0.
 */
import { describe, it, expect, vi } from "vitest";

const info = vi.fn();
vi.mock("../../../src/infra/logger.js", () => ({
  childLogger: () => ({ info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/tools/jobhunt/aggregators/index.js", () => ({
  getAllAggregatorSources: () => [
    { name: "cooling", fetchJobs: async () => null },
    { name: "quiet", fetchJobs: async () => [] },
    {
      name: "busy",
      fetchJobs: async () => [
        {
          title: "Engineer",
          company: "Acme",
          url: "https://example.com/j/1",
          location: "NL",
          description: "Build",
          postedAt: null,
          source: "busy",
          tags: [],
        },
      ],
    },
  ],
}));

describe("sweepAggregators skip vs zero", () => {
  it("keeps a skipped source out of counts and reports it as skipped", async () => {
    const { sweepAggregators } = await import("../../../src/tools/jobhunt/aggregator-source.js");
    const result = await sweepAggregators();

    expect(result.skipped).toEqual(["cooling"]);
    expect(result.sourceCounts.has("cooling")).toBe(false);
    expect(result.sourceCounts.get("quiet")).toBe(0);
    expect(result.sourceCounts.get("busy")).toBe(1);
    expect(result.failures).toEqual([]);

    const fields = info.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(fields.skipped).toEqual(["cooling"]);
    expect(fields.counts).toEqual({ quiet: 0, busy: 1 });
  });
});
