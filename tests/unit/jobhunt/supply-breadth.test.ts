/**
 * Regression — the pool must stay open to startups and scale-ups.
 *
 * FOUNDER REPORT (2026-08-01): "No remote jobs, no full stack jobs, no visa
 * sponsor jobs, no frontend jobs, no backend jobs."
 *
 * The investigation found no company-size filter anywhere — the feed supports
 * one (`liOrganizationSizeFilter`) and we have never sent it. What actually
 * selected for large employers was the TITLE VOCABULARY: `titleSearch` matches
 * substrings, and the list only contained "Engineer" spellings. Dutch startups
 * and scale-ups overwhelmingly advertise "Developer", and full-stack roles are
 * spelled three different ways ("Full Stack", "Full-Stack", "Fullstack"), only
 * one of which was searched.
 *
 * These tests hold both properties open: no size filter, and a vocabulary that
 * covers how small companies actually name roles.
 */

import { describe, it, expect } from "vitest";
import {
  buildAtsInput,
  FORBIDDEN_INPUT_KEYS,
  POOL_ORDER,
} from "../../../src/tools/jobhunt/ats-source.js";
import {
  TRACK_PRIORITY,
  TRACK_TITLES,
  classifyTrack,
  type RoleTrack,
} from "../../../src/tools/jobhunt/tracks.js";
import { SOURCE_EXCLUDED_TITLE_TERMS } from "../../../src/tools/jobhunt/seniority.js";

/** Lowercased title phrases across every track, with the `:*` marker stripped. */
const ALL_PHRASES = Object.values(TRACK_TITLES)
  .flat()
  .map((p) => p.replace(/:\*$/, "").toLowerCase());

/** True when the feed's substring matching would return this title for some phrase. */
function wouldMatch(title: string): boolean {
  const normalised = title.toLowerCase();
  return ALL_PHRASES.some((phrase) => normalised.includes(phrase));
}

describe("company size is never filtered", () => {
  it("sends no headcount parameter, on any pool", () => {
    // Capping size to "find startups" would discard the recognised sponsors the
    // HSM basis depends on; flooring it to "find sponsors" would discard the
    // scale-ups most likely to hire remotely. Size is the wrong instrument —
    // the permit basis is already screened per posting.
    for (const pool of POOL_ORDER) {
      const input = buildAtsInput({ titles: TRACK_TITLES.ai, limit: 10 });
      for (const forbidden of FORBIDDEN_INPUT_KEYS) {
        expect(Object.keys(input), `${pool} sent ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("title vocabulary reaches startups and scale-ups", () => {
  it("matches the 'Developer' spellings small companies actually post", () => {
    for (const title of [
      "Full-Stack Developer",
      "Fullstack Developer",
      "Full Stack Developer",
      "Backend Developer",
      "Frontend Developer",
      "Software Developer",
      "React Developer",
    ]) {
      expect(wouldMatch(title), title).toBe(true);
    }
  });

  it("matches startup-native titles that have no enterprise equivalent", () => {
    // A startup's first engineering hire is never advertised as "Backend
    // Engineer II".
    expect(wouldMatch("Founding Engineer"), "Founding Engineer").toBe(true);
    expect(wouldMatch("Product Engineer"), "Product Engineer").toBe(true);
  });

  it("matches all three spellings of full-stack", () => {
    // Matching one of three drops roughly two thirds of the full-stack market —
    // the founder's "no full stack jobs" report.
    for (const title of ["Full Stack Engineer", "Full-Stack Engineer", "Fullstack Engineer"]) {
      expect(wouldMatch(title), title).toBe(true);
    }
  });

  it("still matches senior roles without enumerating seniority prefixes", () => {
    // Substring matching means "Backend Engineer" already covers these. Listing
    // "Senior Backend Engineer" separately would be redundant, and its absence
    // must not be mistaken for a gap.
    for (const title of [
      "Senior Backend Engineer",
      "Staff Software Engineer",
      "Lead Frontend Developer",
    ]) {
      expect(wouldMatch(title), title).toBe(true);
    }
  });
});

describe("fullstack is its own track with its own budget", () => {
  it("is present in the priority list", () => {
    expect(TRACK_PRIORITY).toContain("fullstack" as RoleTrack);
  });

  it("outranks backend, so a hybrid title reads as the more specific one", () => {
    expect(TRACK_PRIORITY.indexOf("fullstack")).toBeLessThan(TRACK_PRIORITY.indexOf("backend"));
    expect(classifyTrack("Full Stack Software Engineer")).toBe("fullstack");
  });

  it("keeps the other tracks classifying where they did before", () => {
    expect(classifyTrack("AI Engineer")).toBe("ai");
    expect(classifyTrack("Senior Backend Engineer")).toBe("backend");
    expect(classifyTrack("React Developer")).toBe("frontend");
    expect(classifyTrack("Head of Marketing")).toBeNull();
  });

  it("gives every track a non-empty phrase list", () => {
    // A track with no phrases would fetch nothing and report "0 postings",
    // indistinguishable from an empty market.
    for (const track of TRACK_PRIORITY) {
      expect(TRACK_TITLES[track].length, track).toBeGreaterThan(0);
    }
  });
});

describe("early-career exclusion at source", () => {
  it("is sent to the feed, so interns are not paid for and then discarded", () => {
    const input = buildAtsInput({ titles: TRACK_TITLES.backend });
    expect(input["titleExclusionSearch"]).toEqual([...SOURCE_EXCLUDED_TITLE_TERMS]);
  });

  it("contains only terms that are safe as a SUBSTRING", () => {
    // The feed applies exclusions as substrings with no word boundary, and an
    // excluded posting is never returned, never counted, and never appears in
    // any drop tally. So "intern" upstream would silently delete every
    // "Internal" and "International" role — a worse failure than the one it
    // solves. Ambiguous terms stay client-side, where drops are counted.
    const realTitlesThatMustSurvive = [
      "Internal Tools Engineer",
      "International Platform Engineer",
      "Database Upgrade Engineer",
      "Staging Environment Engineer",
      "Backend Engineer, Starter Kits",
    ];

    for (const title of realTitlesThatMustSurvive) {
      const normalised = title.toLowerCase();
      for (const term of SOURCE_EXCLUDED_TITLE_TERMS) {
        expect(normalised.includes(term.toLowerCase()), `"${term}" would delete "${title}"`).toBe(
          false,
        );
      }
    }
  });

  it("still catches the unambiguous early-career titles", () => {
    for (const title of [
      "Software Engineering Internship",
      "Graduate Software Engineer",
      "Trainee Developer",
      "Werkstudent Data Engineer",
    ]) {
      const normalised = title.toLowerCase();
      expect(
        SOURCE_EXCLUDED_TITLE_TERMS.some((t) => normalised.includes(t.toLowerCase())),
        title,
      ).toBe(true);
    }
  });
});
