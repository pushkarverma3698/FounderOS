/**
 * The free sweep runs for EVERY profile, off ONE board poll
 * ========================================================
 * This is the defect the first pass at multi-profile shipped with: every module
 * downstream of the sweep took a profile, and the sweep never passed one — so a
 * second candidate could be fully configured, fully tested, and still produce
 * zero rows in production forever. Nothing in `pnpm test` could see it, because
 * "profile not passed" type-checks against an optional parameter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sweepBoards = vi.fn();
const runFreeIngest = vi.fn();
const buildDailyBrief = vi.fn();
const sendToChat = vi.fn(async (_message: string) => undefined);

vi.mock("../../../src/tools/jobhunt/free-ats-source.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  sweepBoards,
}));
vi.mock("../../../src/tools/jobhunt/free-boards.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  getFreeBoards: () => [{ name: "acme", ats: "greenhouse", token: "acme", markets: [] }],
}));
vi.mock("../../../src/tools/jobhunt/free-ingest.js", () => ({ runFreeIngest }));
vi.mock("../../../src/tools/jobhunt/daily-brief.js", () => ({ buildDailyBrief }));
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat }));
vi.mock("../../../src/tools/jobhunt/sheet-export.js", () => ({
  exportJobSheet: async () => ({ ok: true, url: "https://sheet" }),
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
  beforeEach(() => {
    vi.clearAllMocks();
    resetHeartbeat(new Date("2026-09-04T00:00:00Z"));
    sweepBoards.mockResolvedValue(BOARD_SWEEP);
    runFreeIngest.mockResolvedValue(ingestResult());
    buildDailyBrief.mockResolvedValue("brief");
  });

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

    // Each call gets the SAME sweep object — not a re-poll.
    for (const call of runFreeIngest.mock.calls) {
      expect(call[0].sweep).toBe(BOARD_SWEEP);
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

  it("does not poll the boards at all when the sweep itself fails", async () => {
    sweepBoards.mockRejectedValueOnce(new Error("network down"));
    await runFreeSweep();
    expect(runFreeIngest).not.toHaveBeenCalled();
  });

  it("names the candidate in the alert once there is more than one", async () => {
    await runFreeSweep();
    const messages = sendToChat.mock.calls.map((c) => String(c[0] ?? ""));
    const named = messages.filter((m) => m.includes("passed screening for "));
    expect(named.length).toBeGreaterThan(0);
  });
});
