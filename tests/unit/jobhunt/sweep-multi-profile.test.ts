/**
 * The free sweep runs for EVERY profile, off ONE board poll
 * ========================================================
 * This is the defect the first pass at multi-profile shipped with: every module
 * downstream of the sweep took a profile, and the sweep never passed one — so a
 * second candidate could be fully configured, fully tested, and still produce
 * zero rows in production forever. Nothing in `pnpm test` could see it, because
 * "profile not passed" type-checks against an optional parameter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sweepBoards = vi.fn();
const sweepAggregators = vi.fn();
const runFreeIngest = vi.fn();
const buildDailyBrief = vi.fn();
const sendToJobsChat = vi.fn(async (_message: string) => undefined);
const sendToChat = vi.fn(async (_message: string) => undefined);
// New-role alerts are BUFFERED per sweep and sent as one batch at a daily slot (alert-digest.ts). In memory here.
type FakePending = { rows: { company: string; title: string }[]; backfill: number; overflow: number };
const digestStore = new Map<string, { pending: FakePending | null; lastDigestAt: Date | null }>();
const savePendingAlerts = vi.fn(async (profileId: string, pending: FakePending) => {
  digestStore.set(profileId, { pending, lastDigestAt: digestStore.get(profileId)?.lastDigestAt ?? null });
});
vi.mock("../../../src/db/job-digest-queries.js", () => ({
  loadDigestStates: async (ids: string[]) => new Map(ids.flatMap((id) => (digestStore.has(id) ? [[id, digestStore.get(id)!]] : []))),
  savePendingAlerts,
  markDigestSent: async (profileId: string, at: Date) => {
    digestStore.set(profileId, { pending: null, lastDigestAt: at });
  },
}));
vi.mock("../../../src/db/job-ref-queries.js", () => ({ jobIdsByDedupeKey: async () => new Map(), jobRowsByDedupeKey: async () => [] }));
/** 09:30 in Asia/Kolkata: the first digest slot of the day has started. */
const SLOT_OPEN = new Date("2026-09-04T04:00:00Z");
// Hoisted to module scope (rather than inlined in the factories below) so a test
// can make either of them REJECT. Both sit in `runFreeSweepForProfile` after the
// guarded region, which is exactly where the 2026-09-08 defect lived.
const exportJobSheet = vi.fn(async () => ({ ok: true, url: "https://sheet" }));

// Heartbeat state moved from an in-process Map to job_lane_heartbeats
// (2026-09-07 — see sweep-runner.ts's doc comment). Faked here the same
// shape, still in-memory, so this suite needs no real Postgres.
const mockHeartbeatStore = new Map<string, unknown>();
const saveLaneHeartbeat = vi.fn(async (profileId: string, state: unknown) => {
  mockHeartbeatStore.set(profileId, state);
});

// Wired to the shared `sweepAggregators` const, not a fresh `vi.fn`. It was an
// inline one until 2026-09-08, so `sweepAggregators.mockResolvedValue(...)` in a
// test set a spy nothing called — `runFreeSweep` imports from THIS module, and
// the aggregator branch was therefore never exercised by any test in this file.
vi.mock("../../../src/tools/jobhunt/aggregator-source.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  sweepAggregators,
}));
vi.mock("../../../src/tools/jobhunt/free-ats-source.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  sweepBoards,
  sweepAggregators,
}));
const registerDiscoveredBoard = vi.fn(async () => undefined);
vi.mock("../../../src/tools/jobhunt/free-boards.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  getFreeBoards: () => [{ name: "acme", ats: "greenhouse", token: "acme", markets: [] }],
  registerDiscoveredBoard,
}));
vi.mock("../../../src/tools/jobhunt/free-ingest.js", () => ({ runFreeIngest }));
vi.mock("../../../src/tools/jobhunt/daily-brief.js", () => ({ buildDailyBrief }));
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToJobsChat, sendToChat }));
vi.mock("../../../src/tools/jobhunt/sheet-export.js", () => ({ exportJobSheet }));

vi.mock("../../../src/db/job-heartbeat-queries.js", () => ({
  loadLaneHeartbeat: vi.fn(async (profileId: string) => mockHeartbeatStore.get(profileId) ?? null),
  saveLaneHeartbeat,
  clearLaneHeartbeats: vi.fn(async () => {
    mockHeartbeatStore.clear();
  }),
}));

const { runFreeSweep, resetHeartbeat } = await import("../../../src/tools/jobhunt/sweep-runner.js");
const { listProfiles } = await import("../../../src/tools/jobhunt/profile-config.js");

const BOARD_SWEEP = { candidates: [], failures: [], boardsPolled: 1 };

function ingestResult(overrides: Record<string, unknown> = {}) {
  return {
    seen: 10,
    screened: 4,
    lines: [{ company: "ING", title: "Financial Analyst", outcome: "pass", isNew: true }],
    failures: [],
    notes: [],
    boardsPolled: 1,
    sweepId: "s1",
    funnel: { seen: 10, undated: 0, stale: 0, offTrack: 0, offMarket: 0, known: 0, bodyless: 0, screened: 4 },
    ...overrides,
  };
}

describe("runFreeSweep", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    digestStore.clear();
    vi.setSystemTime(SLOT_OPEN);
    await resetHeartbeat(new Date("2026-09-04T00:00:00Z"));
    exportJobSheet.mockResolvedValue({ ok: true, url: "https://sheet" });
    saveLaneHeartbeat.mockImplementation(async (profileId: string, state: unknown) => {
      mockHeartbeatStore.set(profileId, state);
    });
    sweepBoards.mockResolvedValue(BOARD_SWEEP);
    sweepAggregators.mockResolvedValue({
      candidates: [],
      failures: [],
      harvestedTokens: [],
      sourceCounts: new Map(),
    });
    runFreeIngest.mockResolvedValue(ingestResult());
    buildDailyBrief.mockResolvedValue("brief");
    // `resetHeartbeat` writes the default profile's row, so clear AFTER setup —
    // otherwise a test asserting on who was written to counts the fixture.
    saveLaneHeartbeat.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("polls the boards ONCE no matter how many profiles are registered", async () => {
    await runFreeSweep();
    // 1,297 boards is the expensive half of this lane and the result says
    // nothing about who is looking. Polling per profile would double it every
    // thirty minutes for identical data.
    expect(sweepBoards).toHaveBeenCalledTimes(1);
  });

  it("screens that one poll for every registered profile", async () => {
    await runFreeSweep();
    const profiles = listProfiles();
    expect(profiles.length).toBeGreaterThan(1);
    expect(runFreeIngest).toHaveBeenCalledTimes(profiles.length);

    const screenedFor = runFreeIngest.mock.calls.map((c) => c[0].profile.id).sort();
    expect(screenedFor).toEqual(profiles.map((p) => p.id).sort());

    // Each call gets the combined sweep object — not a re-poll.
    for (const call of runFreeIngest.mock.calls) {
      expect(call[0].sweep).toMatchObject({ boardsPolled: expect.any(Number) });
    }
  });

  it("ranks each profile's rows under that profile", async () => {
    await runFreeSweep();
    const ranked = buildDailyBrief.mock.calls.map((c) => c[0].profile.id).sort();
    expect(ranked).toEqual(listProfiles().map((p) => p.id).sort());
  });

  it("keeps running the other profiles when one of them fails", async () => {
    // A broken lane for one candidate must not silence the other's. Before the
    // loop existed there was only one lane, so this had no way to go wrong.
    runFreeIngest.mockRejectedValueOnce(new Error("boom"));
    await runFreeSweep();
    expect(runFreeIngest).toHaveBeenCalledTimes(listProfiles().length);
  });

  /**
   * REGRESSION, 2026-09-08. The test above asserted the right property and
   * exercised the ONE failure site that was already guarded: `runFreeSweepForProfile`
   * wraps `runFreeIngest` in its own try/catch, so injecting there proved nothing
   * about the loop. `publishSheet`, `sendToJobsChat` and `saveLaneHeartbeat` were not
   * guarded anywhere, and `sendToJobsChat` rethrows by design (unlike `sendStatusText`,
   * which logs and swallows).
   *
   * Pushkar is first in `listProfiles()`, so one Telegram failure on his alert
   * meant: the second candidate was never screened, HIS OWN heartbeat was never
   * advanced (the save is after the send), and `runFreeSweep()` itself rejected
   * into the cron's `.catch()` — one log line, whole tick gone.
   */
  it("keeps running the other profiles when the FIRST profile's buffer write throws", async () => {
    savePendingAlerts.mockRejectedValueOnce(new Error("db down"));
    await expect(runFreeSweep()).resolves.toBeUndefined();
    expect(runFreeIngest).toHaveBeenCalledTimes(listProfiles().length);
  });

  it("never records a sweep as announced when its roles could not be buffered", async () => {
    // The heartbeat write is what resets the alive-ping clock, so recording it
    // after a failed buffer write would claim roles the founder will never be told about and
    // buy the lane another three hours of silence. The honest state is the one
    // it already had, so the next quiet roll-up still pings.
    savePendingAlerts.mockRejectedValueOnce(new Error("db down"));
    await runFreeSweep();

    const [first, ...rest] = listProfiles().map((p) => p.id);
    const saved = saveLaneHeartbeat.mock.calls.map((c) => c[0]);
    expect(saved).not.toContain(first);
    // ...and the profiles behind it are unaffected.
    for (const id of rest) expect(saved).toContain(id);
  });

  it("keeps the buffer and does not reject when the batched Telegram send throws", async () => {
    // sendToJobsChat rethrows by design. The roles stay buffered, so the next sweep delivers them.
    sendToJobsChat.mockRejectedValueOnce(new Error("Bad Request: message is too long"));
    await expect(runFreeSweep()).resolves.toBeUndefined();
    expect(runFreeIngest).toHaveBeenCalledTimes(listProfiles().length);
    for (const { id } of listProfiles()) expect(digestStore.get(id)?.pending?.rows).toHaveLength(1);

    await runFreeSweep();
    expect(sendToJobsChat).toHaveBeenCalledTimes(2);
    for (const { id } of listProfiles()) expect(digestStore.get(id)?.pending).toBeNull();
  });

  it("sends nothing to the group during a sweep before the first slot of the day", async () => {
    vi.setSystemTime(new Date("2026-09-04T02:00:00Z"));
    await runFreeSweep();
    expect(sendToJobsChat).not.toHaveBeenCalled();
    for (const { id } of listProfiles()) expect(digestStore.get(id)?.pending?.rows).toHaveLength(1);
  });

  it("keeps running the other profiles when the sheet export throws", async () => {
    // exportJobSheet is contracted to RETURN a failure rather than throw, but it
    // is a network call behind a Google client and nothing enforces that.
    exportJobSheet.mockRejectedValueOnce(new Error("sheets API down"));
    await expect(runFreeSweep()).resolves.toBeUndefined();
    expect(runFreeIngest).toHaveBeenCalledTimes(listProfiles().length);
  });

  it("does not poll the boards at all when the sweep itself fails", async () => {
    sweepBoards.mockRejectedValueOnce(new Error("network down"));
    await runFreeSweep();
    expect(runFreeIngest).not.toHaveBeenCalled();
  });

  it("sends ONE batched message that names every candidate", async () => {
    // Both lanes share the daily cap: two candidates must not double the group's message count.
    await runFreeSweep();
    expect(sendToJobsChat).toHaveBeenCalledTimes(1);
    const text = String(sendToJobsChat.mock.calls[0]?.[0] ?? "");
    expect(text).toContain("Tashi Goyal");
    expect(text).toContain("Pushkar Verma");
    expect(text).toMatch(/new roles? for/);
  });

  it("prints a selector in the second candidate's commands and none in the default candidate's", async () => {
    // Both alerts land in one group chat. A bare `/draft 2` acts on the default queue, so hers must say whose it is.
    await runFreeSweep();
    const text = String(sendToJobsChat.mock.calls[0]?.[0] ?? "");
    const blocks = text.split(/(?=🆕)/);
    const hers = blocks.find((block) => block.includes("Tashi Goyal")) ?? "";
    const his = blocks.find((block) => block.includes("Pushkar Verma")) ?? "";
    expect(hers).toContain("Tashi Goyal");
    expect(hers).toContain("/jobs tashi for the ranked list");
    expect(his).toContain("Pushkar Verma");
    expect(his).toContain("/jobs for the ranked list");
    expect(his).not.toContain("/jobs tashi");
  });
});

/**
 * REGRESSION, 2026-09-08: the registry's self-growth mechanism was dead two ways.
 *
 * `startBoardHarvest`/`collectBoardTokens`/`flushBoardHarvest` had exactly one
 * caller — `ingest.ts`, the metered sweep, whose `cron.schedule()` was removed on
 * 2026-08-21. And the free lane's aggregator branch computed board tokens, logged
 * the COUNT, and threw them away; it could not have written them anyway, because
 * `harvestedTokens` is `{ats, token}` and `registerDiscoveredBoard` needs a name.
 *
 * Net: `/opt/founderos-data/free-ats-discovered.csv` did not exist on the
 * production box, and no board had been discovered since August. The module
 * header's claim — "one aggregator sweep discovers boards that every future ATS
 * sweep polls directly, forever" — described a mechanism that had never fired.
 */
describe("runFreeSweep grows the board registry from aggregator URLs", () => {
  beforeEach(async () => {
    // Full reset: this block is a sibling of the suite above, not nested inside
    // it, so it does not inherit that beforeEach — and without the clear, one
    // test's discovery is still on the spy when the next one asserts.
    vi.clearAllMocks();
    await resetHeartbeat(new Date("2026-09-04T00:00:00Z"));
    sweepBoards.mockResolvedValue(BOARD_SWEEP);
    runFreeIngest.mockResolvedValue(ingestResult({ lines: [] }));
    buildDailyBrief.mockResolvedValue("brief");
    exportJobSheet.mockResolvedValue({ ok: true, url: "https://sheet" });
    saveLaneHeartbeat.mockImplementation(async () => undefined);
    sweepAggregators.mockResolvedValue({
      candidates: [
        {
          board: { name: "Speechify", ats: "greenhouse", token: "aggregator-arbeitnow", markets: [] },
          externalId: "arbeitnow:1",
          title: "Financial Analyst",
          url: "https://boards.greenhouse.io/speechify/jobs/4123",
          location: "Amsterdam",
          postedAt: new Date("2026-09-08T00:00:00Z"),
          description: "A finance role.",
        },
      ],
      failures: [],
      harvestedTokens: [{ ats: "greenhouse", token: "speechify" }],
      sourceCounts: new Map(),
    });
  });

  it("writes a board it found on an aggregator's posting URL", async () => {
    await runFreeSweep();
    expect(registerDiscoveredBoard).toHaveBeenCalledWith(
      expect.objectContaining({ ats: "greenhouse", token: "speechify", name: "Speechify" }),
    );
  });

  it("claims no market it has not established", async () => {
    // The aggregator's location string has not been resolved against any
    // candidate's markets at this point, so an empty column is the honest answer —
    // the same rule harvestNewBoardTokens already applies to `other`/`unknown`.
    await runFreeSweep();
    const written = registerDiscoveredBoard.mock.calls.at(0)?.at(0) as
      | { markets: readonly string[] }
      | undefined;
    expect(written?.markets).toEqual([]);
  });

  it("does not write a board the registry already has", async () => {
    // getFreeBoards is mocked to return greenhouse/acme, so a sighting of it is
    // not a discovery.
    sweepAggregators.mockResolvedValue({
      candidates: [
        {
          board: { name: "Acme", ats: "greenhouse", token: "aggregator-arbeitnow", markets: [] },
          externalId: "arbeitnow:2",
          title: "Analyst",
          url: "https://boards.greenhouse.io/acme/jobs/1",
          location: "Amsterdam",
          postedAt: new Date("2026-09-08T00:00:00Z"),
          description: "x",
        },
      ],
      failures: [],
      harvestedTokens: [],
      sourceCounts: new Map(),
    });
    await runFreeSweep();
    expect(registerDiscoveredBoard).not.toHaveBeenCalled();
  });
});
