/**
 * Unit tests — the free lane's cron entrypoint (`runFreeSweep`).
 *
 * THE FAILURE THIS GUARDS AGAINST. The lane ticks 48 times a day. A message
 * every tick trains the founder to stop reading it — the same failure already
 * on record for the metered feed's old screening log, which ran flawlessly and
 * produced zero applications for weeks because nothing about it demanded a
 * reaction. So the alert must fire ONLY for a posting that is both a pass and
 * new, and an outage must never read as a quiet market.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";
import type { FreeIngestResult } from "../../../src/tools/jobhunt/free-ingest.js";

const mockRunFreeIngest = vi.fn<() => Promise<FreeIngestResult>>();
vi.mock("../../../src/tools/jobhunt/free-ingest.js", () => ({
  runFreeIngest: mockRunFreeIngest,
}));

const mockSendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat: mockSendToChat }));

// Ranking and export both touch the database and the Sheets API. Neither is
// what these tests are about — they are about WHICH messages the founder gets —
// and leaving them real would make the suite need a DB and a credential.
const mockBuildDailyBrief = vi.fn(async () => "");
vi.mock("../../../src/tools/jobhunt/daily-brief.js", () => ({
  buildDailyBrief: mockBuildDailyBrief,
}));

const mockExportJobSheet = vi.fn(async () => ({
  ok: true as const,
  queued: 3,
  logged: 9,
  url: "https://docs.google.com/spreadsheets/d/SHEET",
}));
vi.mock("../../../src/tools/jobhunt/sheet-export.js", () => ({
  exportJobSheet: mockExportJobSheet,
}));

const { runFreeSweep, FREE_SWEEP_CRON, resetHeartbeat } = await import(
  "../../../src/tools/jobhunt/sweep-runner.js"
);

function line(overrides: Partial<IngestLine> = {}): IngestLine {
  return {
    company: "Aquablu B.V.",
    title: "Embedded Software Engineer",
    outcome: "pass",
    detail: "",
    isNew: true,
    ...overrides,
  };
}

function result(overrides: Partial<FreeIngestResult> = {}): FreeIngestResult {
  return {
    seen: 10,
    screened: 5,
    lines: [],
    failures: [],
    notes: [],
    boardsPolled: 2,
    sweepId: "free-test",
    funnel: {
      seen: 10,
      undated: 0,
      stale: 0,
      offTrack: 0,
      offMarket: 0,
      known: 0,
      bodyless: 0,
      screened: 5,
    },
    ...overrides,
  };
}

describe("runFreeSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The alive-ping clock is process state that survives between tests. Without
    // this reset the suite would be order-dependent: a test that runs after a
    // simulated three-hour gap would inherit a due ping.
    resetHeartbeat(new Date());
    mockExportJobSheet.mockResolvedValue({
      ok: true as const,
      queued: 3,
      logged: 9,
      url: "https://docs.google.com/spreadsheets/d/SHEET",
    });
  });

  it("sends an alert when a new passing line exists", async () => {
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    await runFreeSweep();

    expect(mockSendToChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Aquablu B.V.");
    expect(text).toContain("Embedded Software Engineer");
  });

  it("does not alert when every line is duplicate, reject, or flag", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({
        lines: [
          line({ outcome: "duplicate", isNew: false }),
          line({ outcome: "reject", isNew: true }),
          line({ outcome: "flag", isNew: true }),
        ],
      }),
    );
    await runFreeSweep();

    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not alert when the only passing line was already seen (isNew false)", async () => {
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line({ isNew: false })] }));
    await runFreeSweep();

    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("names at most 3 passing roles and states the true total when more exist", async () => {
    const lines = Array.from({ length: 8 }, (_, i) =>
      line({ company: `Company ${i}`, title: `Role ${i}` }),
    );
    mockRunFreeIngest.mockResolvedValue(result({ lines }));
    await runFreeSweep();

    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("8 new role");
    expect(text).toContain("Company 0");
    expect(text).toContain("Company 2");
    expect(text).not.toContain("Company 3");
    expect(text).toContain("+ 5 more");
  });

  it("does not invent /draft numbers — the sheet carries the numbering", async () => {
    // The `#` column is the pinned `brief_rank`. A second set of numbers in the
    // alert would give the founder two schemes for the same jobs and no way to
    // tell which one /draft meant.
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    await runFreeSweep();

    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(text).not.toMatch(/\/draft \d/);
    expect(text).toContain("docs.google.com/spreadsheets");
  });

  it("ranks BEFORE it exports, so the sheet's # column is never blank", async () => {
    // buildDailyBrief is what writes brief_section/brief_rank, and both the `#`
    // column and the apply queue read them. Exporting first would publish the
    // new rows unranked.
    const order: string[] = [];
    mockBuildDailyBrief.mockImplementation(async () => {
      order.push("rank");
      return "";
    });
    mockExportJobSheet.mockImplementation(async () => {
      order.push("export");
      return { ok: true as const, queued: 1, logged: 1, url: "https://x/y" };
    });
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));

    await runFreeSweep();

    expect(order).toEqual(["rank", "export"]);
  });

  it("still alerts when ranking fails — the rows are screened and stored either way", async () => {
    mockBuildDailyBrief.mockRejectedValue(new Error("db down"));
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));

    await runFreeSweep();

    expect(mockSendToChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Aquablu B.V.");
  });

  it("folds an export failure into the alert rather than sending a second message", async () => {
    // Two notifications for one event is how a channel becomes noise — and the
    // unconfigured case would otherwise nag twice per sweep until setup.
    mockExportJobSheet.mockResolvedValue({
      ok: false,
      skipped: true,
      reason: "JOBHUNT_SHEET_ID is not set",
    } as any);
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));

    await runFreeSweep();

    expect(mockSendToChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Aquablu B.V.");
    expect(text).toContain("not set up yet");
  });

  it("does not rewrite the sheet on a sweep that found nothing", async () => {
    // 48 identical rewrites a day spend quota to produce no change, and would
    // overwrite the Applied column between a founder's click and his next sync.
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line({ isNew: false })] }));

    await runFreeSweep();

    expect(mockExportJobSheet).not.toHaveBeenCalled();
  });

  it("proves it is alive after three quiet hours, naming the boards it checked", async () => {
    resetHeartbeat(new Date("2026-08-06T00:00:00Z"));
    vi.setSystemTime(new Date("2026-08-06T03:30:00Z"));
    mockRunFreeIngest.mockResolvedValue(
      result({ lines: [line({ isNew: false })], boardsPolled: 285 }),
    );

    await runFreeSweep();

    expect(mockSendToChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("alive");
    expect(text).toContain("285");
    vi.useRealTimers();
  });

  it("fires the outage alert when boards failed and the sweep fetched nothing at all", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({
        seen: 0,
        screened: 0,
        failures: ["greenhouse/a: HTTP 500", "lever/b: HTTP 500", "ashby/c: HTTP 500", "greenhouse/d: HTTP 500"],
      }),
    );
    await runFreeSweep();

    expect(mockSendToChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    // Counts per (platform, reason), and EVERY failure counted — the old version
    // named the first three boards and silently dropped the fourth, which is how
    // 36 Recruitee rate limits a sweep stayed invisible for a day.
    expect(text).toContain("4 board(s) failed");
    expect(text).toMatch(/greenhouse[^;]*500[^;]*2/);
    expect(text).toContain("lever");
    expect(text).toContain("ashby");
  });

  it("does not fire the outage alert when boards failed but some postings were still screened", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({ screened: 3, failures: ["greenhouse/a: HTTP 500"], lines: [line({ isNew: false })] }),
    );
    await runFreeSweep();

    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not fire the outage alert when a board failed and seen > 0 but nothing was screened (the false positive fix)", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({ seen: 20551, screened: 0, failures: ["greenhouse/crcevans: HTTP 404"], lines: [] }),
    );
    await runFreeSweep();

    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not reject when the underlying ingest throws", async () => {
    mockRunFreeIngest.mockRejectedValue(new Error("network down"));

    await expect(runFreeSweep()).resolves.toBeUndefined();
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("FREE_SWEEP_CRON is a valid 5-field cron expression firing every 30 minutes", () => {
    const fields = FREE_SWEEP_CRON.split(" ");
    expect(fields).toHaveLength(5);
    expect(fields[0]).toBe("*/30");
    expect(fields[1]).toBe("*");
  });
});
