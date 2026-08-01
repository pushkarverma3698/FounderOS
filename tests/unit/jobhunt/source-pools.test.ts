/**
 * Unit tests — source pools and track classification.
 *
 * The pool split is the fix for a real coverage hole: until 2026-07-31 every
 * query set `locationSearch: ["Netherlands"]`, and the feed documents that a
 * posting with a null `locations_derived` "would always return zero rows" when
 * combined with a location search. Globally-remote roles were therefore
 * unreachable, and the `remote-contract` permit basis had a gate but no funnel.
 */

import { describe, it, expect } from "vitest";
import {
  buildAtsInput,
  DEFAULT_EXPERIENCE,
  POOL_ORDER,
  POOL_QUERIES,
  type SourcePool,
} from "../../../src/tools/jobhunt/ats-source.js";
import { classifyTrack, TRACK_PRIORITY } from "../../../src/tools/jobhunt/tracks.js";

describe("classifyTrack", () => {
  it("assigns a plain AI title to the ai track", () => {
    expect(classifyTrack("AI Engineer")).toBe("ai");
    expect(classifyTrack("Senior Machine Learning Engineer, Platform")).toBe("ai");
  });

  it("assigns backend and frontend titles to their own tracks", () => {
    expect(classifyTrack("Backend Engineer (Go)")).toBe("backend");
    expect(classifyTrack("Frontend Engineer — React")).toBe("frontend");
  });

  it("resolves a multi-track title by priority, not by match order", () => {
    // Contains both "AI Engineer" and "Backend Engineer". ai outranks backend,
    // and the answer must not depend on which phrase appears first.
    expect(classifyTrack("Backend Engineer / AI Engineer")).toBe("ai");
    expect(classifyTrack("AI Engineer / Backend Engineer")).toBe("ai");
  });

  it("returns null rather than guessing when nothing matches", () => {
    // Forcing this into a track would corrupt two gap reports at once: the
    // term is counted where it does not belong and missing where it does.
    expect(classifyTrack("Product Marketing Manager")).toBeNull();
    expect(classifyTrack("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(classifyTrack("bAcKeNd EnGiNeEr")).toBe("backend");
  });

  it("only ever returns a track that is in the priority list", () => {
    const titles = ["AI Engineer", "Backend Engineer", "React Developer", "Chef"];
    for (const title of titles) {
      const track = classifyTrack(title);
      if (track !== null) expect(TRACK_PRIORITY).toContain(track);
    }
  });
});

describe("source pools", () => {
  it("covers every pool in POOL_ORDER", () => {
    for (const pool of POOL_ORDER) {
      expect(POOL_QUERIES[pool]).toBeDefined();
    }
    expect(POOL_ORDER).toHaveLength(Object.keys(POOL_QUERIES).length);
  });

  it("sends a location filter for both Netherlands-based pools", () => {
    for (const pool of ["nl-onsite", "nl-remote"] satisfies SourcePool[]) {
      const input = buildAtsInput(POOL_QUERIES[pool]);
      expect(input["locationSearch"]).toEqual(["Netherlands"]);
    }
  });

  it("sends NO location filter for the globally-remote pool", () => {
    // The whole point of pool C. A location filter here returns zero rows for
    // exactly the postings it exists to find.
    const input = buildAtsInput(POOL_QUERIES["eu-remote-global"]);
    expect(input).not.toHaveProperty("locationSearch");
  });

  it("keeps the two Netherlands-scoped pools from paying for the same posting twice", () => {
    // Scoped to the pools that are separated BY ARRANGEMENT. `india` is
    // separated by LOCATION instead and deliberately sends no arrangement filter
    // at all — pinning it to remote is what made every on-site role in Bangalore
    // unreachable, which is the defect the pool was added to fix. It cannot
    // overlap the others regardless: they carry `locationSearch: ["Netherlands"]`
    // or omit the location entirely.
    const seen = new Set<string>();
    for (const pool of ["netherlands", "eu-remote-global"] as const) {
      const arrangements = buildAtsInput(POOL_QUERIES[pool])["aiWorkArrangementFilter"];
      expect(Array.isArray(arrangements)).toBe(true);
      for (const a of arrangements as string[]) {
        expect(seen.has(a)).toBe(false); // no posting should be paid for twice
        seen.add(a);
      }
    }
    // All four of the feed's arrangements are accounted for.
    expect(seen).toEqual(new Set(["On-site", "Hybrid", "Remote OK", "Remote Solely"]));
  });

  it("asks India for every desk arrangement, not just remote", () => {
    const input = buildAtsInput(POOL_QUERIES["india"]);
    expect(input).not.toHaveProperty("aiWorkArrangementFilter");
    expect(input["locationSearch"]).toEqual(["India"]);
  });

  it("omits the work-arrangement filter when a query does not set one", () => {
    expect(buildAtsInput({})).not.toHaveProperty("aiWorkArrangementFilter");
  });

  it("stops at the 2-5 band — the permit allowing a role is not a shortlist", () => {
    // 5-10 was added on 2026-07-31 arguing the under-30 salary band is HSM-only
    // reasoning. True about the PERMIT and irrelevant to the hiring manager: the
    // founder's verdict on seeing "Senior Platform Engineer" was that nobody
    // hires 3.5 years of experience into it. The band is a COST filter; the
    // Experience gate is what actually rejects, on stated years.
    expect(DEFAULT_EXPERIENCE).toEqual(["0-2", "2-5"]);
  });

  it("builds byte-identical input for the same pool twice", () => {
    // A surprising result must be attributable to the market, not the request.
    const a = buildAtsInput(POOL_QUERIES["netherlands"]);
    const b = buildAtsInput(POOL_QUERIES["netherlands"]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
