/**
 * Unit tests — `filterCandidates`, the free lane's three cheap pre-screen
 * filters (pure; `now` is passed in rather than read).
 *
 * THE FAILURE EACH FILTER GUARDS AGAINST: an undated posting read as fresh is
 * how a three-year-old listing reaches the top of a brief that promised new
 * roles; a remote posting with no stated country is the most reachable kind of
 * role on the board, so `unknown` must survive even though `other` does not.
 * Every drop must be counted — a silent drop and an empty market look identical
 * from outside.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { filterCandidates, FREE_LANE_MAX_AGE_HOURS } from "../../../src/tools/jobhunt/free-ingest.js";
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

describe("filterCandidates — freshness", () => {
  it("keeps a posting inside the window and drops + counts one outside it", () => {
    const fresh = candidate({ postedAt: new Date("2026-08-06T10:00:00Z"), url: "u1" }); // 2h old
    const stale = candidate({ postedAt: new Date("2026-08-06T00:00:00Z"), url: "u2" }); // 12h old

    const { kept, notes } = filterCandidates([fresh, stale], NOW, 6);

    expect(kept).toEqual([fresh]);
    expect(notes.some((n) => n.includes("1 postings older than 6h"))).toBe(true);
  });

  it("keeps a posting exactly at the window edge", () => {
    const edge = candidate({ postedAt: new Date("2026-08-06T06:00:00Z") }); // exactly 6h old

    const { kept, notes } = filterCandidates([edge], NOW, 6);

    expect(kept).toEqual([edge]);
    expect(notes).toEqual([]);
  });

  it("drops a posting one minute past the window edge", () => {
    const pastEdge = candidate({ postedAt: new Date("2026-08-06T05:59:00Z") }); // 6h01m old

    const { kept, notes } = filterCandidates([pastEdge], NOW, 6);

    expect(kept).toEqual([]);
    expect(notes.some((n) => n.includes("older than 6h"))).toBe(true);
  });

  it("uses FREE_LANE_MAX_AGE_HOURS as the default window when none is given", () => {
    const withinDefault = candidate({
      postedAt: new Date(NOW.getTime() - (FREE_LANE_MAX_AGE_HOURS - 1) * 3_600_000),
      url: "u1",
    });
    const beyondDefault = candidate({
      postedAt: new Date(NOW.getTime() - (FREE_LANE_MAX_AGE_HOURS + 1) * 3_600_000),
      url: "u2",
    });

    const { kept } = filterCandidates([withinDefault, beyondDefault], NOW);

    expect(kept).toEqual([withinDefault]);
  });
});

describe("FREE_LANE_MAX_AGE_HOURS — env parsing", () => {
  /**
   * REGRESSION. The window was widened to 30 days because a 6h window dropped
   * 18,865 of 18,884 live postings and the lane screened zero. The first fix
   * read the override as `Number(process.env[...] ?? 720)`, which restores that
   * outcome from a single blank line in a .env: `??` only substitutes for
   * `undefined`, so `FREE_LANE_MAX_AGE_HOURS=` parses to `Number("")` === 0,
   * every posting is older than the window, and the lane goes dark with a green
   * test suite and no error anywhere.
   *
   * A misparse must therefore fail WIDE (fall back to 720), never NARROW. Zero
   * is not a legal window; it is the shape of a mistake.
   */
  const ORIGINAL = process.env["FREE_LANE_MAX_AGE_HOURS"];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env["FREE_LANE_MAX_AGE_HOURS"];
    else process.env["FREE_LANE_MAX_AGE_HOURS"] = ORIGINAL;
    vi.resetModules();
  });

  async function windowFor(raw: string | undefined): Promise<number> {
    if (raw === undefined) delete process.env["FREE_LANE_MAX_AGE_HOURS"];
    else process.env["FREE_LANE_MAX_AGE_HOURS"] = raw;
    vi.resetModules();
    const mod = await import("../../../src/tools/jobhunt/free-ingest.js");
    return mod.FREE_LANE_MAX_AGE_HOURS;
  }

  it.each([
    ["unset", undefined],
    ["blank", ""],
    ["whitespace", "   "],
    ["zero", "0"],
    ["negative", "-6"],
    ["non-numeric", "30d"],
  ])("falls back to 720h when the override is %s", async (_label, raw) => {
    await expect(windowFor(raw)).resolves.toBe(720);
  });

  it("honours a deliberate numeric override", async () => {
    await expect(windowFor("48")).resolves.toBe(48);
  });

  it("never yields a window that would drop every posting", async () => {
    for (const raw of [undefined, "", "   ", "0", "-6", "30d", "48"]) {
      expect(await windowFor(raw)).toBeGreaterThan(0);
    }
  });
});

describe("filterCandidates — undated postings", () => {
  it("drops a posting with no publication date and counts it separately from stale ones", () => {
    // Treating unknown age as fresh is the specific failure this guards against.
    const undated = candidate({ postedAt: null, url: "u1" });
    const stale = candidate({ postedAt: new Date("2026-08-01T00:00:00Z"), url: "u2" });

    const { kept, notes } = filterCandidates([undated, stale], NOW, 6);

    expect(kept).toEqual([]);
    const undatedNote = notes.find((n) => n.includes("stated no publication date"));
    const staleNote = notes.find((n) => n.includes("older than 6h"));
    expect(undatedNote).toContain("1 postings");
    expect(staleNote).toContain("1 postings");
    expect(undatedNote).not.toBe(staleNote);
  });
});

describe("filterCandidates — track", () => {
  it("drops a title classifyTrack cannot classify, and counts it", () => {
    const unclassifiable = candidate({ title: "Warehouse Associate" });

    const { kept, notes } = filterCandidates([unclassifiable], NOW, 6);

    expect(kept).toEqual([]);
    expect(notes.some((n) => n.includes("1 postings were not an engineering track"))).toBe(true);
  });
});

describe("filterCandidates — market", () => {
  it("drops a posting whose location resolves to `other`", () => {
    const other = candidate({ location: "Berlin, Germany" });

    const { kept, notes } = filterCandidates([other], NOW, 6);

    expect(kept).toEqual([]);
    expect(notes.some((n) => n.includes("1 postings were outside the Netherlands and India"))).toBe(
      true,
    );
  });

  it("KEEPS a posting whose location resolves to `unknown` — remote roles often state no country", () => {
    const unknownLocation = candidate({ location: "Remote" });

    const { kept, notes } = filterCandidates([unknownLocation], NOW, 6);

    expect(kept).toEqual([unknownLocation]);
    expect(notes).toEqual([]);
  });
});

describe("filterCandidates — note discipline", () => {
  it("emits no notes at all when nothing was dropped", () => {
    const clean = candidate();

    const { kept, notes } = filterCandidates([clean], NOW, 6);

    expect(kept).toEqual([clean]);
    expect(notes).toEqual([]);
  });

  it("emits a note only for the filters that actually dropped something, in a mixed batch", () => {
    const passes = candidate({ url: "u1" });
    const offTrack = candidate({ title: "Warehouse Associate", url: "u2" });

    const { notes } = filterCandidates([passes, offTrack], NOW, 6);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("not an engineering track");
  });

  it("every note names a non-zero count", () => {
    const undated = candidate({ postedAt: null, url: "u1" });
    const stale = candidate({ postedAt: new Date("2026-08-01T00:00:00Z"), url: "u2" });
    const offTrack = candidate({ title: "Warehouse Associate", url: "u3" });
    const offMarket = candidate({ location: "Berlin, Germany", url: "u4" });

    const { notes } = filterCandidates([undated, stale, offTrack, offMarket], NOW, 6);

    expect(notes).toHaveLength(4);
    for (const note of notes) {
      expect(note).not.toMatch(/\b0 postings/);
      expect(note).toMatch(/^\d+ postings/);
    }
  });
});

describe("filterCandidates — a 10h+ unseen posting survives on age alone", () => {
  /**
   * THE FOUNDER-REQUESTED REGRESSION (2026-08-10).
   *
   * The 6h window was not merely too tight, it was disjoint from the data: across
   * 285 live registry boards, 18,846 candidates, the YOUNGEST posting was 10.3
   * hours old and the median was 62 days. Prod recorded 64 sweeps, 1,306,522
   * postings requested, 0 screened. These cases pin the exact ages that used to
   * return nothing, so a future narrowing of the window fails here first rather
   * than in a silent sweep.
   *
   * Deduplication is `keepUnseen`'s job, not the window's — these candidates are
   * UNSEEN, and age must not be what removes them.
   */
  const AGES_THAT_RETURNED_ZERO = [10.3, 12, 24, 48, 72, 218, 719];

  it.each(AGES_THAT_RETURNED_ZERO)("keeps an unseen posting %sh old", (hours) => {
    const posting = candidate({ postedAt: new Date(NOW.getTime() - hours * 3_600_000) });

    const { kept } = filterCandidates([posting], NOW);

    expect(kept).toEqual([posting]);
  });

  it("keeps the exact 10.3h posting that was the youngest on the whole registry", () => {
    const youngest = candidate({ postedAt: new Date(NOW.getTime() - 10.3 * 3_600_000) });

    const { kept, notes } = filterCandidates([youngest], NOW);

    expect(kept).toEqual([youngest]);
    expect(notes.join(" ")).not.toMatch(/older than/);
  });

  it("drops a 10h posting for TRACK, never for age — the reason must name the real cause", () => {
    const offTrack = candidate({
      title: "Warehouse Associate",
      postedAt: new Date(NOW.getTime() - 10 * 3_600_000),
    });

    const { kept, notes } = filterCandidates([offTrack], NOW);

    expect(kept).toEqual([]);
    expect(notes.some((n) => n.includes("not an engineering track"))).toBe(true);
    expect(notes.join(" ")).not.toMatch(/older than/);
  });

  it("the default window admits everything the boards actually publish", () => {
    // p90 across the live registry was 8,281h; the default must at minimum admit
    // the median (1,478h) so a normal board is not 50% invisible.
    expect(FREE_LANE_MAX_AGE_HOURS).toBeGreaterThan(720 - 1);
  });
});
