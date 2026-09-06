/**
 * Unit tests for Phase 1 free job funnel visibility and zero-pass streak alerts.
 */

import { describe, it, expect } from "vitest";
import { filterCandidates, type FreeFunnel } from "../../../src/tools/jobhunt/free-ingest.js";
import { afterQuietSweep, ZERO_PASS_STREAK_THRESHOLD, funnelClosingStage, type HeartbeatState } from "../../../src/tools/jobhunt/sweep-heartbeat.js";
import type { FreeCandidate } from "../../../src/tools/jobhunt/free-ats-source.js";
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

describe("Phase 1 — funnelClosingStage & zero-pass streak alert", () => {
  // CHANGED 2026-09-06, from "the stage with the largest count" to "the stage
  // that took the survivors to zero". The old rule reported `stale` on every
  // real production funnel — it is the first filter and 53% of a 47,000-posting
  // sweep is always older than the window — which reads exactly the same on a
  // healthy day as during a total outage. The alert exists only to explain a
  // CLOSED funnel, and the stage that closed it is the one the founder can act
  // on. During the 2026-09-06 outage the old rule would have named 25,139 stale
  // postings while the actual closer was 7 bodyless ones.
  it("names the stage that took the survivors to zero, not the biggest one", () => {
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

    expect(funnelClosingStage(funnel)).toEqual({ reason: "outside target market", count: 3 });
  });

  it("names bodyless on the real production funnel that closed the lane", () => {
    // Verbatim from agents.job_ingest_runs, 2026-09-06 09:01 UTC, wife-nl-finance.
    const funnel: FreeFunnel = {
      seen: 46991,
      undated: 1476,
      stale: 25139,
      offTrack: 20005,
      offMarket: 312,
      known: 58,
      bodyless: 1,
      screened: 0,
    };

    expect(funnelClosingStage(funnel)).toEqual({ reason: "no body description", count: 1 });
  });

  it("returns null when the funnel is not closed", () => {
    const funnel: FreeFunnel = {
      seen: 100,
      undated: 0,
      stale: 90,
      offTrack: 5,
      offMarket: 0,
      known: 0,
      bodyless: 0,
      screened: 5,
    };

    expect(funnelClosingStage(funnel)).toBeNull();
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

  it("emits zero-pass streak alert at N (6 sweeps) naming the closing stage", () => {
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
    // The closer is off-track (5 survivors of 100 reached it and none got past),
    // NOT the 95 stale postings that never had a chance of being screened.
    expect(res.ping).toContain("off-track title");
    expect(res.ping).toContain("5");
    expect(res.ping).not.toContain("stale age cutoff");
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
