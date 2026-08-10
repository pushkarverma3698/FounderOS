/**
 * Unit tests — `filterCandidates`, the free lane's two cheap pre-screen filters
 * (pure, and no longer time-dependent).
 *
 * THE REGRESSION THESE PIN. Until 2026-08-09 this function also enforced a
 * six-hour publication window, and that window returned ZERO rows on every real
 * sweep: measured against 60 live boards the youngest posting on the whole
 * registry was 10.3 hours old and the median was 62 days, so 1,306,522 postings
 * were fetched and none was ever screened. Age is now nobody's business here —
 * `keepUnseen` is the first-seen detector, and it answers the question the window
 * was pretending to answer ("have we already got this one?") from the tracker
 * rather than from a clock.
 *
 * What the two survivors guard against: a title nobody on this track would apply
 * to, and a country we cannot lawfully work in. `unknown` location must survive
 * even though `other` does not — a remote posting frequently states no country
 * and is the most reachable kind of role on the board. Every drop is counted; a
 * silent drop and an empty market look identical from outside.
 */

import { describe, it, expect } from "vitest";
import { filterCandidates } from "../../../src/tools/jobhunt/free-ingest.js";
import type { FreeCandidate } from "../../../src/tools/jobhunt/free-ats-mappers.js";
import type { FreeBoard } from "../../../src/tools/jobhunt/free-boards.js";

const BOARD: FreeBoard = { name: "Acme B.V.", ats: "greenhouse", token: "acme", markets: ["NL"] };

function candidate(overrides: Partial<FreeCandidate> = {}): FreeCandidate {
  return {
    board: BOARD,
    externalId: "1",
    title: "Backend Engineer",
    url: "https://example.com/job/1",
    location: "Amsterdam, Netherlands",
    postedAt: new Date("2026-08-06T11:00:00Z"),
    description: null,
    ...overrides,
  };
}

const NOW = new Date("2026-08-06T12:00:00Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

describe("filterCandidates — age is not a reason to drop (2026-08-09 regression)", () => {
  it("KEEPS a 10-hour-old posting — the exact age that returned zero rows on every real sweep", () => {
    const tenHours = candidate({ postedAt: hoursAgo(10) });

    const { kept, notes } = filterCandidates([tenHours]);

    expect(kept).toEqual([tenHours]);
    expect(notes).toEqual([]);
  });

  it("KEEPS postings across the full age range a real board returns", () => {
    // 10.3h was the youngest posting across 8,621 candidates on 60 live boards;
    // 1,477h (62 days) was the median. Under the old six-hour window every one
    // of these was discarded.
    const ages = [10.3, 24, 72, 218, 1478, 8281];
    const aged = ages.map((h, i) => candidate({ postedAt: hoursAgo(h), url: `u${i}` }));

    const { kept, notes } = filterCandidates(aged);

    expect(kept).toEqual(aged);
    expect(notes).toEqual([]);
  });

  it("KEEPS an undated posting — with no age gate there is nothing for a date to fail", () => {
    const undated = candidate({ postedAt: null });

    const { kept, notes } = filterCandidates([undated]);

    expect(kept).toEqual([undated]);
    expect(notes).toEqual([]);
  });

  it("drops an old posting that is off-track, and blames the TRACK, never the age", () => {
    const oldAndOffTrack = candidate({ title: "Warehouse Associate", postedAt: hoursAgo(5000) });

    const { kept, notes } = filterCandidates([oldAndOffTrack]);

    expect(kept).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("not an engineering track");
    expect(notes.join(" ")).not.toMatch(/older than|publication date/);
  });
});

describe("filterCandidates — track", () => {
  it("drops a title classifyTrack cannot classify, and counts it", () => {
    const unclassifiable = candidate({ title: "Warehouse Associate" });

    const { kept, notes } = filterCandidates([unclassifiable]);

    expect(kept).toEqual([]);
    expect(notes.some((n) => n.includes("1 postings were not an engineering track"))).toBe(true);
  });
});

describe("filterCandidates — market", () => {
  it("drops a posting whose location resolves to `other`", () => {
    const other = candidate({ location: "Berlin, Germany" });

    const { kept, notes } = filterCandidates([other]);

    expect(kept).toEqual([]);
    expect(notes.some((n) => n.includes("1 postings were outside the Netherlands and India"))).toBe(
      true,
    );
  });

  it("KEEPS a posting whose location resolves to `unknown` — remote roles often state no country", () => {
    const unknownLocation = candidate({ location: "Remote" });

    const { kept, notes } = filterCandidates([unknownLocation]);

    expect(kept).toEqual([unknownLocation]);
    expect(notes).toEqual([]);
  });
});

describe("filterCandidates — counts for the log line", () => {
  it("reports a count for every filter, including the ones that dropped nothing", () => {
    // The log needs a stable shape. Notes are suppressed at zero so the founder
    // never reads "0 postings were …", but the numeric counts are always present
    // — a filter missing from the log is indistinguishable from a filter that
    // dropped nothing, and that ambiguity is what hid this bug for weeks.
    const passes = candidate({ url: "u1" });
    const offTrack = candidate({ title: "Warehouse Associate", url: "u2" });

    const { counts } = filterCandidates([passes, offTrack]);

    expect(counts).toEqual({ seen: 2, offTrack: 1, offMarket: 0, kept: 1 });
  });

  it("counts reconcile: seen === kept + every drop", () => {
    const batch = [
      candidate({ url: "u1" }),
      candidate({ title: "Warehouse Associate", url: "u2" }),
      candidate({ location: "Berlin, Germany", url: "u3" }),
      candidate({ postedAt: null, url: "u4" }),
    ];

    const { counts, kept } = filterCandidates(batch);

    expect(counts.seen).toBe(batch.length);
    expect(counts.kept).toBe(kept.length);
    expect(counts.kept + counts.offTrack + counts.offMarket).toBe(counts.seen);
  });
});

describe("filterCandidates — note discipline", () => {
  it("emits no notes at all when nothing was dropped", () => {
    const clean = candidate();

    const { kept, notes } = filterCandidates([clean]);

    expect(kept).toEqual([clean]);
    expect(notes).toEqual([]);
  });

  it("emits a note only for the filters that actually dropped something", () => {
    const passes = candidate({ url: "u1" });
    const offTrack = candidate({ title: "Warehouse Associate", url: "u2" });

    const { notes } = filterCandidates([passes, offTrack]);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("not an engineering track");
  });

  it("every note names a non-zero count", () => {
    const offTrack = candidate({ title: "Warehouse Associate", url: "u1" });
    const offMarket = candidate({ location: "Berlin, Germany", url: "u2" });

    const { notes } = filterCandidates([offTrack, offMarket]);

    expect(notes).toHaveLength(2);
    for (const note of notes) {
      expect(note).not.toMatch(/\b0 postings/);
      expect(note).toMatch(/^\d+ postings/);
    }
  });
});
