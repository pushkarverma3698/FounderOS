/**
 * Unit tests — `read_cv` must answer for the CANDIDATE it was asked about.
 *
 * 2026-09-07: `read_cv` had no `profileId` argument at all. Its personal-rag
 * REST call and its wiki.md fallback are both structurally Pushkar's own
 * data — `personal-rag`'s own tool instructions describe it as "Pushkar
 * Verma's personal knowledge base" — so asking about a second registered
 * candidate (e.g. "what's Tashi's experience with FP&A") silently answered
 * from HIS background, not hers. `tailor_cv`/`cv_gaps`/`daily-brief` already
 * carried the fix for this exact class of bug via `cvPathsForProfile`
 * (career.ts's own doc comment); `read_cv` just never plugged into it.
 *
 * These pin: a non-default profile skips personal-rag and wiki.md entirely —
 * both are the wrong person's data, not a degraded source — and reads that
 * profile's own CV file straight; the default (founder / omitted) path is
 * byte-for-byte unchanged, per career-cv-fallback.test.ts and career.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockReadFileSync = vi.fn();

vi.mock("node:fs", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, readFileSync: mockReadFileSync };
});

const { readCvTool } = await import("../../../src/tools/career.js");

// Long enough to clear MIN_PLAUSIBLE_CV_CHARS (800) — see career-cv-fallback.test.ts,
// which hit this floor first. A shorter fixture would exercise the "CV too short,
// refuse" path while looking like it tested the read.
const WIFE_CV_CONTENT = [
  "# Tashi Goyal",
  "FP&A / Business Controlling / Regulatory Compliance (KYC-AML) / Audit · Amsterdam",
  "",
  "## Experience",
  "### Senior Analyst, TIDE (Jan 2024 – Aug 2024)",
  "- Owned KYC/AML case reviews across the EU onboarding funnel, clearing a backlog",
  "  of over 400 flagged accounts within one quarter.",
  "### Analyst, TIDE (Oct 2022 – Dec 2023)",
  "- Built the monthly FP&A reporting pack for the leadership team, consolidating",
  "  revenue, headcount and burn across four business units.",
  "### Finance Intern, HBS (Mar 2026 – present)",
  "- Owns the FTE Tracker end to end, reporting directly to two directors and",
  "  presenting headcount planning scenarios at the monthly leadership review.",
  "",
  "## Skills",
  "- FP&A, Power BI dashboards, IFRS statutory reporting, KYC/AML case review,",
  "  business controlling, variance analysis, stakeholder reporting.",
  "",
  "## Education",
  "- MSc, Auditing — thesis on internal-controls effectiveness in fintech.",
].join("\n");

function apiDown(): void {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("should never be called for a non-default profile")));
}

describe("read_cv — profileId argument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes profileId in its input schema", () => {
    const props = readCvTool.input_schema?.properties as Record<string, unknown> | undefined;
    expect(props).toHaveProperty("profileId");
  });

  it("does not call personal-rag at all for a non-default profile — that API is the founder's own knowledge base", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockReadFileSync.mockImplementation((path: string) =>
      String(path).includes("wife") ? WIFE_CV_CONTENT : "irrelevant",
    );

    await readCvTool.execute({ query: "FP&A experience", profileId: "wife-nl-finance" });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("reads the named profile's own CV file and returns her content, not a fallback to wiki.md", async () => {
    apiDown();
    mockReadFileSync.mockImplementation((path: string) => {
      if (String(path).includes("wife")) return WIFE_CV_CONTENT;
      throw new Error(`unexpected path in test: ${path}`);
    });

    const result = await readCvTool.execute({ query: "FP&A experience", profileId: "wife-nl-finance" });

    expect(result.success).toBe(true);
    expect(String(result.data)).toContain("Tashi Goyal");
    expect(String(result.data)).not.toContain("wiki fallback");
  });

  it("names the candidate in a loud error when her CV file cannot be read — never falls back to Pushkar's wiki", async () => {
    apiDown();
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = await readCvTool.execute({ query: "anything", profileId: "wife-nl-finance" });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("Tashi Goyal");
  });

  it("omitting profileId leaves the existing founder default path byte-for-byte unchanged", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        query: "TypeScript",
        results: [{ text: "Pushkar has TypeScript experience.", metadata: { source_file: "wiki.md" }, score: 0.9 }],
        total: 1,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await readCvTool.execute({ query: "TypeScript" });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
