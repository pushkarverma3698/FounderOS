/**
 * Unit tests for Phase 1 free job funnel visibility and zero-pass streak alerts.
 */

import { describe, it, expect } from "vitest";
import { filterCandidates, type FreeFunnel } from "../../../src/tools/jobhunt/free-ingest.js";
import { afterQuietSweep, ZERO_PASS_STREAK_THRESHOLD, topDropReason, type HeartbeatState } from "../../../src/tools/jobhunt/sweep-heartbeat.js";
import type { FreeCandidate } from "../../../src/tools/jobhunt/free-ats-mappers.js";
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const BOARD: FreeBoard = { name: "Test Board", ats: "greenhouse", token: "test", markets: ["NL"] };

function candidate(overrides: Partial<FreeCandidate> = {}): FreeCandidate {
  return {
    board: BOARD,
    externalId: "1",
    title: "Backend Engineer",
    url: "https://example.com/job/1",
    location: "Amsterdam, Netherlands",
    postedAt: new Date("2026-08-08T10:00:00Z"),
    description: "Build distributed systems",
    ...overrides,
  };
}

const NOW = new Date("2026-08-08T12:00:00Z");

describe("Phase 1 — filterCandidates structured counts", () => {
  it("returns exact counts per drop reason", () => {
    const fresh = candidate({ url: "u1" });
    const undated = candidate({ postedAt: null, url: "u2" });
    const stale = candidate({ postedAt: new Date("2026-07-01T00:00:00Z"), url: "u3" }); // >720h
    const offTrack = candidate({ title: "Chef", url: "u4" });
    const offMarket = candidate({ location: "Berlin, Germany", url: "u5" });

    const result = filterCandidates([fresh, undated, stale, offTrack, offMarket], NOW, 720);

    expect(result.kept).toEqual([fresh]);
    expect(result.counts).toEqual({
      undated: 1,
      stale: 1,
      offTrack: 1,
      offMarket: 1,
    });
  });
});

describe("Phase 1 — topDropReason & zero-pass streak alert", () => {
  it("identifies the dominant drop stage from funnel", () => {
    const funnel: FreeFunnel = {
      seen: 100,
      undated: 2,
      stale: 85,
      offTrack: 10,
      offMarket: 3,
      known: 0,
      bodyless: 0,
      screened: 0,
    };

    const top = topDropReason(funnel);
    expect(top).toEqual({ reason: "stale age cutoff", count: 85 });
  });

  it("does not emit zero-pass streak alert at N-1 (5 sweeps)", () => {
    const funnel: FreeFunnel = {
      seen: 50,
      undated: 0,
      stale: 50,
      offTrack: 0,
      offMarket: 0,
      known: 0,
      bodyless: 0,
      screened: 0,
    };

    let state: HeartbeatState = { quietSweeps: 0, boardsPolled: 0, lastMessageAt: NOW.getTime(), zeroPassStreak: 0, lastFunnel: null };
    for (let i = 0; i < ZERO_PASS_STREAK_THRESHOLD - 1; i++) {
      const res = afterQuietSweep(state, 10, funnel, NOW);
      state = res.next;
      expect(res.ping).toBeNull();
    }
    expect(state.zeroPassStreak).toBe(ZERO_PASS_STREAK_THRESHOLD - 1);
  });

  it("emits zero-pass streak alert at N (6 sweeps) naming top drop reason", () => {
    const funnel: FreeFunnel = {
      seen: 100,
      undated: 0,
      stale: 95,
      offTrack: 5,
      offMarket: 0,
      known: 0,
      bodyless: 0,
      screened: 0,
    };

    let state = { quietSweeps: 0, boardsPolled: 0, lastMessageAt: NOW.getTime(), zeroPassStreak: 5, lastFunnel: funnel };
    const res = afterQuietSweep(state, 10, funnel, NOW);
    expect(res.ping).not.toBeNull();
    expect(res.ping).toContain("Job lane funnel alert");
    expect(res.ping).toContain("stale age cutoff");
    expect(res.ping).toContain("95");
  });
});

describe("Phase 1 — 100% drop regression test (F-01)", () => {
  it("reproduces 100%-drop condition and asserts funnel names stale stage", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      candidate({
        postedAt: new Date("2026-08-01T00:00:00Z"), // older than 6h, but within 720h (30d)
        url: `https://example.com/job/${i}`,
      }),
    );

    // Under old 6h cutoff: 100% dropped by stale gate
    const oldFiltered = filterCandidates(candidates, NOW, 6);
    expect(oldFiltered.kept).toHaveLength(0);
    expect(oldFiltered.counts.stale).toBe(20);

    // Under new default (720h): candidates pass freshness to be deduplicated by keepUnseen
    const newFiltered = filterCandidates(candidates, NOW, 720);
    expect(newFiltered.kept).toHaveLength(20);
    expect(newFiltered.counts.stale).toBe(0);
  });
});
