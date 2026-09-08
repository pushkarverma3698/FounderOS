/**
 * The reduced IND criterion is a DATE, not a permanent property of a person
 * =========================================================================
 * The *verlaagd salariscriterium* — €3,122/month against the standard €4,357 —
 * applies to someone moving to a highly skilled migrant permit within THREE
 * YEARS of completing a Dutch orientation year or obtaining a qualifying degree.
 * It is time-boxed by law.
 *
 * It was selected by `permitBases.includes("zoekjaar")`: a string membership test
 * on a profile constant, permanent by construction. So it could never expire, and
 * the failure direction is the silent-permissive one this pipeline exists to
 * avoid — it would go on clearing roles at a floor 28% below the lawful one and
 * say nothing, weeks before anyone found out.
 *
 * Tashi graduates 1 October 2026 (founder, 2026-09-08), so her window runs to
 * 2029-10-01. These tests pin both ends of it and the boundary between them.
 */

import { describe, it, expect } from "vitest";
import { criterionOn } from "../../../src/tools/jobhunt/criteria.js";
import { screenSalaryFacts } from "../../../src/tools/jobhunt/filters.js";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";

const DOB = new Date("2001-04-07T00:00:00Z");

/**
 * A window end inside calendar 2026, so these tests exercise the BAND SELECTION
 * without needing IND figures for a year nobody has verified. `criteria.ts`
 * covers one calendar year at a time by design and returns null outside it —
 * inventing a 2029 row to make a test pass would be the exact failure that table
 * exists to prevent. Her real window (2029-10-01) is asserted against the profile
 * at the bottom of this file, where no lookup is involved.
 */
const WINDOW_ENDS = new Date("2026-06-01T00:00:00Z");
const INSIDE = new Date("2026-03-01T00:00:00Z");
const AFTER = new Date("2026-09-08T00:00:00Z");

describe("criterionOn honours the reduced window's end date", () => {
  it("applies the reduced criterion inside the window", () => {
    const c = criterionOn(INSIDE, DOB, WINDOW_ENDS);
    expect(c?.band).toBe("reduced");
    expect(c?.monthly).toBe(3122);
  });

  it("falls back to the standard band once the window has passed", () => {
    const c = criterionOn(AFTER, DOB, WINDOW_ENDS);
    expect(c?.band).not.toBe("reduced");
    expect(c?.monthly).toBe(4357);
  });

  it("treats the last day of the window as still inside it", () => {
    const c = criterionOn(WINDOW_ENDS, DOB, WINDOW_ENDS);
    expect(c?.band).toBe("reduced");
  });

  it("never applies the reduced band when no window is declared", () => {
    // A profile that has never been near an orientation year or a Dutch degree
    // must get the standard criterion, and the ABSENCE of a date is what says so.
    const c = criterionOn(AFTER, DOB, undefined);
    expect(c?.band).not.toBe("reduced");
  });

  it("still steps up at thirty when the reduced window is not in play", () => {
    // The age band and the reduced band are different rules; switching one off
    // must not switch the other off with it.
    // Both inside 2026, one either side of a synthetic thirtieth birthday.
    expect(criterionOn(AFTER, DOB, undefined)?.monthly).toBe(4357);
    expect(criterionOn(AFTER, new Date("1990-01-01T00:00:00Z"), undefined)?.monthly).toBe(5942);
  });
});

describe("the salary gate carries the window through", () => {
  const stated = {
    min: 40_000,
    unit: "annual" as const,
    unitInferred: false,
    holidayBasis: "excluded" as const,
    raw: "€40.000 per year",
  };

  it("clears a €40k role while the reduced criterion is in force", () => {
    // €3,122 × 12 = €37,464 — €40k is above it.
    const result = screenSalaryFacts(stated, {
      route: "hsm",
      now: INSIDE,
      dob: DOB,
      reducedCriterionUntil: WINDOW_ENDS,
    });
    expect(result.status).toBe("pass");
  });

  it("REJECTS the same role once the window has lapsed", () => {
    // €4,357 × 12 = €52,284 — €40k is now below the lawful floor, and the whole
    // point of dating this is that the verdict has to change here.
    const result = screenSalaryFacts(stated, {
      route: "hsm",
      now: AFTER,
      dob: DOB,
      reducedCriterionUntil: WINDOW_ENDS,
    });
    expect(result.status).not.toBe("pass");
  });
});

describe("the profile declares the window as a date", () => {
  it("gives Tashi a window ending three years after she graduates", () => {
    const wife = getProfile("wife-nl-finance");
    // Graduation 2026-10-01, confirmed by the founder 2026-09-08.
    expect(wife.reducedCriterionUntil?.toISOString().slice(0, 10)).toBe("2029-10-01");
  });

  it("gives the founder no window at all", () => {
    expect(getProfile("pushkar-nl-tech").reducedCriterionUntil).toBeUndefined();
  });
});
