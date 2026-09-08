/**
 * Unit tests — `export_jobs_csv` (src/tools/jobhunt/jobs-csv.ts).
 *
 * WHAT THIS EXISTS TO STOP (prod, 2026-09-07, one evening, twice).
 * There was no CSV export tool. The jobhunt prompt's step 4 told the worker to
 * call `job_state`, compose the CSV text itself, and hand that string to
 * `write_artifact` — so every cell in every export was model output, and
 * copying a URL from the JSON it had just read was a matter of attention rather
 * than of code. Two files went out an hour apart:
 *
 *   tashi_goyal_screened_jobs.csv  — every "Apply/Source URL" cell read "N/A",
 *                                    while the DB held a full Workday URL for
 *                                    each of those companies.
 *   job_applications_export.csv    — sent after the founder complained; most
 *                                    URLs truncated to a bare domain
 *                                    ("https://careers.abb"), the reply
 *                                    claiming they were now "direct
 *                                    application URLs".
 *
 * The artifact receipt could not contradict either claim: it verifies that a
 * file was written and how many bytes it was, never that the bytes are the
 * rows. So the tests below are about ONE property — a cell the founder clicks
 * is a value copied from the database by code, and the receipt says how many of
 * them there are.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";

const mockQueryJobState = vi.fn();
vi.mock("../../../src/db/job-queries.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/db/job-queries.js")>(
    "../../../src/db/job-queries.js",
  );
  return { ...actual, queryJobState: mockQueryJobState };
});

const mockWriteArtifactFile = vi.fn(async (args: { id: string; content: string }) => ({
  path: `/artifacts/thread/${args.id}.csv`,
  bytes: Buffer.byteLength(args.content, "utf8"),
  format: "csv" as const,
  id: args.id,
}));
vi.mock("../../../src/tools/artifact.js", () => ({
  writeArtifactFile: (...a: unknown[]) => mockWriteArtifactFile(...(a as [{ id: string; content: string }])),
}));

const { exportJobsCsvTool } = await import("../../../src/tools/jobhunt/jobs-csv.js");

/** A row shaped like the real table — only the columns the export reads are set. */
function row(over: Partial<JobApplication> = {}): JobApplication {
  return {
    id: "r1",
    company: "Baxter",
    title: "Sr Financial Analyst",
    track: "fpa",
    location: "Gurgaon",
    country: "IN",
    route: "free-ats",
    url: "https://baxter.wd1.myworkdayjobs.com/en-US/baxter/job/Gurgaon-Haryana/Sr-Financial-Analyst_JR-208236",
    stage: "screened",
    brief_rank: 1,
    brief_section: "do_today",
    liveness: "live",
    sponsor_verdict: "sponsor",
    salary_status: "pass",
    salary_evidence: null,
    gate_json: null,
    posted_at: new Date("2026-09-06T00:00:00Z"),
    created_at: new Date("2026-09-06T00:00:00Z"),
    applied_at: null,
    skipped_at: null,
    ...over,
  } as unknown as JobApplication;
}

/** The written CSV text, split into data rows (header dropped, BOM tolerated). */
function writtenRows(): string[] {
  const content = mockWriteArtifactFile.mock.calls.at(-1)![0].content;
  return content.replace(/^﻿/, "").split("\r\n").slice(1);
}

beforeEach(() => {
  mockQueryJobState.mockReset();
  mockWriteArtifactFile.mockClear();
});

describe("export_jobs_csv — the apply link is copied by code, never composed", () => {
  it("writes the row's URL verbatim, in full, with no truncation to the domain", async () => {
    const full =
      "https://baxter.wd1.myworkdayjobs.com/en-US/baxter/job/Gurgaon-Haryana/Sr-Financial-Analyst_JR-208236";
    mockQueryJobState.mockResolvedValue({ count: 1, total: 1, rows: [row({ url: full })] });

    const res = await exportJobsCsvTool.execute({ kind: "log" });

    expect(res.success).toBe(true);
    expect(writtenRows()[0]).toContain(full);
  });

  it('never emits "N/A" for a row that has a URL in the database', async () => {
    mockQueryJobState.mockResolvedValue({ count: 1, total: 1, rows: [row()] });
    await exportJobsCsvTool.execute({ kind: "log" });
    expect(writtenRows()[0]).not.toContain("N/A");
  });

  it("leaves the cell empty when the database has no URL — an absence, never an invention", async () => {
    mockQueryJobState.mockResolvedValue({ count: 1, total: 1, rows: [row({ url: null })] });
    await exportJobsCsvTool.execute({ kind: "log" });
    const cells = writtenRows()[0]!.split(",");
    expect(cells.at(-1)).toBe("");
  });

  it("reports how many rows carry a link, so a 'URLs included' claim is checkable", async () => {
    mockQueryJobState.mockResolvedValue({
      count: 3,
      total: 3,
      rows: [row(), row({ id: "r2", url: null }), row({ id: "r3" })],
    });

    const res = await exportJobsCsvTool.execute({ kind: "log" });

    expect(res.success).toBe(true);
    if (res.success) {
      const data = JSON.parse(res.data as string) as { rows: number; rowsWithUrl: number };
      expect(data.rows).toBe(3);
      expect(data.rowsWithUrl).toBe(2);
      expect(res.observed?.evidence).toContain("rows:3");
      expect(res.observed?.evidence).toContain("with_url:2");
    }
  });

  it("asks the database for full rows — the curated projection has no url on the log tab", async () => {
    mockQueryJobState.mockResolvedValue({ count: 0, total: 0, rows: [] });
    await exportJobsCsvTool.execute({ kind: "log" });
    expect(mockQueryJobState).toHaveBeenCalledWith(expect.objectContaining({ fullDetails: true }));
  });

  it("forwards the candidate filter rather than exporting the default queue", async () => {
    mockQueryJobState.mockResolvedValue({ count: 0, total: 0, rows: [] });
    await exportJobsCsvTool.execute({ profile: "Tashi", kind: "log" });
    expect(mockQueryJobState).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "wife-nl-finance" }),
    );
  });

  it("refuses an unknown candidate loudly instead of exporting somebody else's rows", async () => {
    const res = await exportJobsCsvTool.execute({ profile: "nobody" });
    expect(res.success).toBe(false);
    expect(mockQueryJobState).not.toHaveBeenCalled();
    expect(mockWriteArtifactFile).not.toHaveBeenCalled();
  });

  it("writes no file when the query matched nothing, and says so", async () => {
    mockQueryJobState.mockResolvedValue({ count: 0, total: 41, rows: [] });
    const res = await exportJobsCsvTool.execute({ kind: "log" });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("0 rows");
    expect(mockWriteArtifactFile).not.toHaveBeenCalled();
  });

  it("neutralises a company name that would execute as a spreadsheet formula", async () => {
    mockQueryJobState.mockResolvedValue({
      count: 1,
      total: 1,
      rows: [row({ company: "=cmd|'/c calc'!A1" })],
    });
    await exportJobsCsvTool.execute({ kind: "log" });
    expect(writtenRows()[0]).not.toMatch(/(^|,)=cmd/);
  });
});
