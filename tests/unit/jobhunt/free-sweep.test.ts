/**
 * Unit tests — the free lane's cron entrypoint (`runFreeSweep`).
 *
 * THE FAILURE THIS GUARDS AGAINST. The lane ticks 48 times a day. A message
 * every tick trains the founder to stop reading it — the same failure already
 * on record for the metered feed's old screening log, which ran flawlessly and
 * produced zero applications for weeks because nothing about it demanded a
 * reaction. So the alert must fire ONLY for a posting that is both a pass and
 * new, and an outage must never read as a quiet market.
 *
 * SINCE 2026-10-05 a sweep BUFFERS its new roles and one batched message goes to the jobs group at each of
 * three daily slots (alert-digest.ts, covered on its own in alert-digest.test.ts). Lane-health notices
 * (alive ping, funnel alert, outage, sheet export failure) go to the founder DM, never the group.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";
import type { FreeIngestResult } from "../../../src/tools/jobhunt/free-ingest.js";
import type { BoardSweep } from "../../../src/tools/jobhunt/free-ats-source.js";

const mockRunFreeIngest = vi.fn<() => Promise<FreeIngestResult>>();
vi.mock("../../../src/tools/jobhunt/free-ingest.js", () => ({
  runFreeIngest: mockRunFreeIngest,
}));

// The board poll moved OUT of runFreeIngest and into runFreeSweep on 2026-09-04
// (poll once, screen for every profile). Unmocked it would really hit 1,297
// boards and time this suite out.
vi.mock("../../../src/tools/jobhunt/aggregator-source.js", () => ({ sweepAggregators: vi.fn(async () => ({ candidates: [], failures: [], boardsPolled: 0 })) }));
vi.mock("../../../src/tools/jobhunt/free-ats-source.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  sweepBoards: vi.fn(async () => ({ candidates: [], failures: [], boardsPolled: 0 })),
  sweepAggregators: vi.fn(async () => ({ candidates: [], failures: [], boardsPolled: 0 })),
}));
vi.mock("../../../src/tools/jobhunt/free-boards.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  getFreeBoards: () => [],
}));

// ONE profile, deliberately. These tests are about WHICH message the founder
// gets for a given lane outcome; the fan-out across profiles is a different
// question and is tested on its own in sweep-multi-profile.test.ts. Leaving both
// profiles registered here would double every assertion for no added coverage.
vi.mock("../../../src/tools/jobhunt/profile-config.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  const pushkar = actual["PUSHKAR_PROFILE"];
  return { ...actual, listProfiles: () => [pushkar] };
});

const mockSendToJobsChat = vi.fn(async () => {});
const mockSendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToJobsChat: mockSendToJobsChat, sendToChat: mockSendToChat }));

// The batch buffer lives in job_digest_state. Faked in memory, same shape, so this suite needs no Postgres.
type FakePending = { rows: { company: string; title: string }[]; backfill: number; overflow: number };
const mockDigestStore = new Map<string, { pending: FakePending | null; lastDigestAt: Date | null }>();
const mockSavePendingAlerts = vi.fn(async (profileId: string, pending: FakePending) => {
  mockDigestStore.set(profileId, { pending, lastDigestAt: mockDigestStore.get(profileId)?.lastDigestAt ?? null });
});
vi.mock("../../../src/db/job-digest-queries.js", () => ({
  loadDigestStates: async (ids: string[]) => new Map(ids.flatMap((id) => (mockDigestStore.has(id) ? [[id, mockDigestStore.get(id)!]] : []))),
  savePendingAlerts: mockSavePendingAlerts,
  markDigestSent: async (profileId: string, at: Date) => {
    mockDigestStore.set(profileId, { pending: null, lastDigestAt: at });
  },
}));
vi.mock("../../../src/db/job-ref-queries.js", () => ({ jobIdsByDedupeKey: async () => new Map() }));

/** 09:30 in Asia/Kolkata: the first digest slot of the day has started. */
const SLOT_OPEN = new Date("2026-08-06T04:00:00Z");
/** 07:30 in Asia/Kolkata: before the first slot, so nothing is delivered. */
const BEFORE_SLOT = new Date("2026-08-06T02:00:00Z");

// Heartbeat state moved from an in-process Map to job_lane_heartbeats
// (2026-09-07 — see sweep-runner.ts's doc comment). Faked here the same
// shape, still in-memory, so this suite needs no real Postgres.
const mockHeartbeatStore = new Map<string, unknown>();
const mockLoadLaneHeartbeat = vi.fn(async (profileId: string) => mockHeartbeatStore.get(profileId) ?? null);
const mockSaveLaneHeartbeat = vi.fn(async (profileId: string, state: unknown) => {
  mockHeartbeatStore.set(profileId, state);
});
const mockClearLaneHeartbeats = vi.fn(async () => {
  mockHeartbeatStore.clear();
});
vi.mock("../../../src/db/job-heartbeat-queries.js", () => ({
  loadLaneHeartbeat: mockLoadLaneHeartbeat,
  saveLaneHeartbeat: mockSaveLaneHeartbeat,
  clearLaneHeartbeats: mockClearLaneHeartbeats,
}));

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
const mockRunPooledIngest = vi.fn(async () => ({
  fetched: 5,
  failures: [],
  notes: [],
  newBoards: [],
}));
vi.mock("../../../src/tools/jobhunt/ingest.js", () => ({
  runPooledIngest: mockRunPooledIngest,
}));

const { runFreeSweep, runJobIngestSweep, FREE_SWEEP_CRON, resetHeartbeat } = await import(
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
  beforeEach(async () => {
    vi.clearAllMocks();
    mockDigestStore.clear();
    vi.setSystemTime(SLOT_OPEN);
    // The alive-ping clock is persisted state that survives between tests.
    // Without this reset the suite would be order-dependent: a test that runs
    // after a simulated three-hour gap would inherit a due ping.
    await resetHeartbeat(new Date());
    mockExportJobSheet.mockResolvedValue({
      ok: true as const,
      queued: 3,
      logged: 9,
      url: "https://docs.google.com/spreadsheets/d/SHEET",
    });
  });

  afterEach(() => vi.useRealTimers());

  it("sends an alert when a new passing line exists", async () => {
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    await runFreeSweep();

    expect(mockSendToJobsChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToJobsChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Aquablu B.V.");
    expect(text).toContain("Embedded Software Engineer");
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("buffers a new role and sends nothing to the group before the first slot of the day", async () => {
    vi.setSystemTime(BEFORE_SLOT);
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    await runFreeSweep();

    expect(mockSendToJobsChat).not.toHaveBeenCalled();
    expect(mockSavePendingAlerts).toHaveBeenCalledOnce();
    expect(mockDigestStore.get("pushkar-nl-tech")?.pending?.rows[0]?.company).toBe("Aquablu B.V.");
  });

  it("sends the batch once per slot however many sweeps follow", async () => {
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    await runFreeSweep();
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line({ company: "Second Co" })] }));
    await runFreeSweep();
    vi.setSystemTime(new Date(SLOT_OPEN.getTime() + 30 * 60_000));
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line({ company: "Third Co" })] }));
    await runFreeSweep();

    expect(mockSendToJobsChat).toHaveBeenCalledOnce();
    expect(mockDigestStore.get("pushkar-nl-tech")?.pending?.rows.map((r) => r.company)).toEqual(["Second Co", "Third Co"]);
  });

  it("does not record the sweep as announced when the buffer cannot be written", async () => {
    mockSavePendingAlerts.mockRejectedValueOnce(new Error("db down"));
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    const savesBefore = mockSaveLaneHeartbeat.mock.calls.length;

    await runFreeSweep();

    expect(mockSaveLaneHeartbeat.mock.calls.length).toBe(savesBefore);
    expect(mockSendToJobsChat).not.toHaveBeenCalled();
  });

  it("does not alert when every line is a duplicate or a reject", async () => {
    // A duplicate is not new and a reject is legally void — neither is an action.
    // A FLAG used to be in this list and no longer is: founder, 2026-09-08,
    // "alerted every time we pass them, whenever we find new roles". See the
    // test below, and sweep-heartbeat.ts's formatNewRowsAlert.
    mockRunFreeIngest.mockResolvedValue(
      result({
        lines: [
          line({ outcome: "duplicate", isNew: false }),
          line({ outcome: "reject", isNew: true }),
        ],
      }),
    );
    await runFreeSweep();

    expect(mockSendToJobsChat).not.toHaveBeenCalled();
  });

  it("DOES alert on a new flagged role", async () => {
    // The NL-finance lane is mostly flags — non-sponsor employers, no salary
    // stated — so filtering to `pass` meant it ranked roles and stayed silent.
    mockRunFreeIngest.mockResolvedValue(
      result({ lines: [line({ outcome: "flag", isNew: true })] }),
    );
    await runFreeSweep();

    expect(mockSendToJobsChat).toHaveBeenCalled();
  });

  it("does not alert when the only passing line was already seen (isNew false)", async () => {
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line({ isNew: false })] }));
    await runFreeSweep();

    expect(mockSendToJobsChat).not.toHaveBeenCalled();
  });

  it("names at most 8 roles in the batch and states the true total when more exist", async () => {
    const lines = Array.from({ length: 12 }, (_, i) =>
      line({ company: `Company ${i}`, title: `Role ${i}` }),
    );
    mockRunFreeIngest.mockResolvedValue(result({ lines }));
    await runFreeSweep();

    const [text] = (mockSendToJobsChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("12 new role");
    expect(text).toContain("Company 0");
    expect(text).toContain("Company 7");
    expect(text).not.toContain("Company 8");
    expect(text).toContain("+ 4 more");
  });

  it("does not invent /draft row numbers, and carries no sheet link in the group message", async () => {
    // A row number is a position in a list that is re-ranked every sweep. The sheet link is a founder-facing
    // fact: the candidates in the group do not need it.
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    await runFreeSweep();

    const [text] = (mockSendToJobsChat.mock.calls as unknown as [string][])[0]!;
    expect(text).not.toMatch(/\/draft \d/);
    expect(text).not.toContain("docs.google.com/spreadsheets");
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

    expect(mockSendToJobsChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToJobsChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Aquablu B.V.");
  });

  it("keeps the sheet notice out of the group batch when sheet export is skipped (unconfigured)", async () => {
    mockExportJobSheet.mockResolvedValueOnce({
      ok: false,
      skipped: true,
      reason: "JOBHUNT_SHEET_ID is not set",
    } as any);
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));

    await runFreeSweep();

    expect(mockSendToJobsChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToJobsChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Aquablu B.V.");
    expect(text).not.toContain("not set up");
    expect(text).not.toContain("null");
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("tells the founder in his DM, not the group, when the sheet export really fails", async () => {
    mockExportJobSheet.mockResolvedValueOnce({
      ok: false,
      skipped: false,
      reason: "quota exceeded",
    } as any);
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));

    await runFreeSweep();

    const [dm] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(dm).toContain("could not be updated");
    const [text] = (mockSendToJobsChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Aquablu B.V.");
    expect(text).not.toContain("could not be updated");
  });

  it("sends metered sweep summary without null or link when export is skipped", async () => {
    mockExportJobSheet.mockResolvedValueOnce({
      ok: false,
      skipped: true,
      reason: "JOBHUNT_SHEET_ID is not set",
    } as any);

    await runJobIngestSweep();

    expect(mockSendToJobsChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToJobsChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Screened");
    expect(text).not.toContain("null");
    expect(text).not.toContain("not set up");
  });

  it("does not rewrite the sheet on a sweep that found nothing", async () => {
    // 48 identical rewrites a day spend quota to produce no change, and would
    // overwrite the Applied column between a founder's click and his next sync.
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line({ isNew: false })] }));

    await runFreeSweep();

    expect(mockExportJobSheet).not.toHaveBeenCalled();
  });

  it("proves it is alive in the founder DM after three quiet hours, naming the boards it checked", async () => {
    await resetHeartbeat(new Date("2026-08-06T00:00:00Z"));
    vi.setSystemTime(new Date("2026-08-06T03:30:00Z"));
    mockRunFreeIngest.mockResolvedValue(
      result({ lines: [line({ isNew: false })], boardsPolled: 285 }),
    );

    await runFreeSweep();

    expect(mockSendToJobsChat).not.toHaveBeenCalled();
    expect(mockSendToChat).toHaveBeenCalledOnce();
    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("alive");
    expect(text).toContain("285");
  });

  it("names how many boards are retired and why in the same alive ping, in one line", async () => {
    await resetHeartbeat(new Date("2026-08-06T00:00:00Z"));
    vi.setSystemTime(new Date("2026-08-06T03:30:00Z"));
    mockRunFreeIngest.mockResolvedValue(
      result({
        lines: [line({ isNew: false })],
        boardsPolled: 285,
        retired: [
          { board: "bamboohr/a", reason: "HTML instead of JSON" },
          { board: "bamboohr/b", reason: "HTML instead of JSON" },
          { board: "workday/c", reason: "HTTP 403" },
        ],
      } as never),
    );

    await runFreeSweep();

    const [text] = (mockSendToChat.mock.calls as unknown as [string][])[0]!;
    expect(text).toContain("Retired 3 dead boards, no longer polled: HTML instead of JSON ×2, HTTP 403 ×1.");
  });

  it("DMs the founder an outage alert when boards failed and the sweep fetched nothing at all", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({
        seen: 0,
        screened: 0,
        failures: ["greenhouse/a: HTTP 500", "lever/b: HTTP 500", "ashby/c: HTTP 500", "greenhouse/d: HTTP 500"],
      }),
    );
    await runFreeSweep();

    expect(mockSendToJobsChat).not.toHaveBeenCalled();
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

    expect(mockSendToJobsChat).not.toHaveBeenCalled();
  });

  it("does not fire the outage alert when a board failed and seen > 0 but nothing was screened (the false positive fix)", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({ seen: 20551, screened: 0, failures: ["greenhouse/crcevans: HTTP 404"], lines: [] }),
    );
    await runFreeSweep();

    expect(mockSendToJobsChat).not.toHaveBeenCalled();
  });

  it("does not reject when the underlying ingest throws", async () => {
    mockRunFreeIngest.mockRejectedValue(new Error("network down"));

    await expect(runFreeSweep()).resolves.toBeUndefined();
    expect(mockSendToJobsChat).not.toHaveBeenCalled();
  });

  // The dead-board record is opt-in per caller, and this is the caller that matters: the
  // cron. If this wiring goes, every test of the skip still passes while production polls
  // the same 30 dead boards every half hour, exactly as before.
  it("polls with the persisted dead-board record, so a 404-ing board stays skipped across restarts", async () => {
    mockRunFreeIngest.mockResolvedValue(result());
    const { sweepBoards } = await import("../../../src/tools/jobhunt/free-ats-source.js");

    await runFreeSweep();

    expect(sweepBoards).toHaveBeenCalledTimes(1);
    const [, health] = vi.mocked(sweepBoards).mock.calls[0]!;
    expect(health).toMatchObject({ root: expect.any(String), now: expect.any(Function) });
  });

  it("hands every profile the dead-board skip list even after aggregator postings are merged in", async () => {
    const { sweepBoards } = await import("../../../src/tools/jobhunt/free-ats-source.js");
    const { sweepAggregators } = await import("../../../src/tools/jobhunt/aggregator-source.js");
    vi.mocked(sweepBoards).mockResolvedValueOnce({
      candidates: [],
      failures: ["greenhouse/live: HTTP 500"],
      boardsPolled: 5,
      skippedDead: ["greenhouse/dead"],
    });
    vi.mocked(sweepAggregators).mockResolvedValueOnce({
      candidates: [{ url: "https://example.com/jobs/1", board: { name: "Acme B.V." }, title: "Financial Analyst" }],
      failures: ["aggregator: down"],
      harvestedTokens: [],
    } as never);
    mockRunFreeIngest.mockResolvedValue(result());

    await runFreeSweep();

    const [{ sweep }] = (mockRunFreeIngest.mock.calls as unknown as [{ sweep: BoardSweep }][])[0]!;
    expect(sweep.candidates).toHaveLength(1);
    expect(sweep.failures).toEqual(["greenhouse/live: HTTP 500", "aggregator: down"]);
    expect(sweep.skippedDead).toEqual(["greenhouse/dead"]);
    expect(sweep.boardsPolled).toBe(5);
  });

  it("FREE_SWEEP_CRON is a valid 5-field cron expression firing every 30 minutes", () => {
    const fields = FREE_SWEEP_CRON.split(" ");
    expect(fields).toHaveLength(5);
    expect(fields[0]).toBe("*/30");
    expect(fields[1]).toBe("*");
  });
});
