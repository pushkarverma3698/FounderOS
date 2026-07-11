/**
 * get_gap_scans — the research department's $0 retrieval path over gap_scans.
 * DB queries are mocked at the module boundary; these tests pin the tool's
 * formatting, domain normalization, and honest empty-state messages.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListGapScans = vi.fn();
const mockGetLatestGapScan = vi.fn();
const mockGetGapScanById = vi.fn();

vi.mock("../../../src/db/gap-scan-queries.js", () => ({
  listGapScans: mockListGapScans,
  getLatestGapScan: mockGetLatestGapScan,
  getGapScanById: mockGetGapScanById,
  saveGapScan: vi.fn(),
}));

const { getGapScans } = await import("../../../src/agents/agent-tools/gap-scan.js");

const SUMMARY = {
  id: "id-1",
  target_name: "Acme",
  target_domain: "acme.com",
  category: "CRM",
  gap_score: 72,
  confidence: "medium",
  completion_rate: "0.950",
  runs_total: 40,
  surfaces: ["chatgpt", "perplexity"],
  created_at: new Date("2026-07-11T09:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListGapScans.mockResolvedValue([SUMMARY]);
  mockGetLatestGapScan.mockResolvedValue(null);
  mockGetGapScanById.mockResolvedValue(null);
});

describe("get_gap_scans", () => {
  it("lists scan summaries newest first with score + confidence", async () => {
    const out = await getGapScans.invoke({ category: "CRM", limit: 5 });
    expect(mockListGapScans).toHaveBeenCalledWith({ category: "CRM", limit: 5 });
    expect(out).toContain("2026-07-11 · Acme (acme.com) · CRM · Gap Score 72/100 · confidence medium");
  });

  it("normalizes a messy domain filter before querying", async () => {
    await getGapScans.invoke({ domain: "https://www.Acme.com/pricing" });
    expect(mockListGapScans).toHaveBeenCalledWith({ domain: "acme.com" });
  });

  it("returns the latest full markdown report with full_report=true", async () => {
    mockGetLatestGapScan.mockResolvedValue({
      ...SUMMARY,
      markdown: "# AI Visibility Gap Report — Acme\n…",
    });
    const out = await getGapScans.invoke({ domain: "acme.com", full_report: true });
    expect(mockGetLatestGapScan).toHaveBeenCalledWith("acme.com");
    expect(out).toContain("# AI Visibility Gap Report — Acme");
    expect(out).toContain("id id-1");
  });

  it("fetches one exact scan by scan_id and returns its full report", async () => {
    mockGetGapScanById.mockResolvedValue({
      ...SUMMARY,
      markdown: "# AI Visibility Gap Report — Acme\n…",
    });
    const out = await getGapScans.invoke({ scan_id: "id-1" });
    expect(mockGetGapScanById).toHaveBeenCalledWith("id-1");
    expect(mockListGapScans).not.toHaveBeenCalled(); // id lookup short-circuits the list path
    expect(out).toContain("Gap scan id-1 — Acme (acme.com)");
    expect(out).toContain("# AI Visibility Gap Report — Acme");
  });

  it("says so honestly when a scan_id is unknown", async () => {
    const out = await getGapScans.invoke({ scan_id: "does-not-exist" });
    expect(out).toContain("No gap scan found with id does-not-exist");
  });

  it("says so honestly when nothing is saved (never fabricates a scan)", async () => {
    mockListGapScans.mockResolvedValue([]);
    const listed = await getGapScans.invoke({ domain: "ghost.io" });
    expect(listed).toContain("No saved gap scans found for ghost.io");

    const full = await getGapScans.invoke({ domain: "ghost.io", full_report: true });
    expect(full).toContain("No saved gap scan found for ghost.io");
  });
});
