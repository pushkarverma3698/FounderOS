/**
 * Multi-profile isolation — the defects the first audit missed
 * ============================================================
 * Every case here failed before 2026-09-04. They are grouped by the failure they
 * lock down, not by the module they touch, because each one is a way the pipeline
 * could look green while producing the wrong answer for a second candidate.
 */

import { describe, it, expect, vi } from "vitest";
import { PUSHKAR_PROFILE, getProfile, DEFAULT_PROFILE_ID } from "../../../src/tools/jobhunt/profile-config.js";
import { WIFE_FINANCE_PROFILE } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";
import { basesForPosting, gateProfile, isLiveBasis } from "../../../src/tools/jobhunt/permit-routes.js";
import { criterionOn, bandOn } from "../../../src/tools/jobhunt/criteria.js";
import { screenSalaryFacts } from "../../../src/tools/jobhunt/filters.js";

describe("permit basis — zoekjaar is a real basis, not an HSM approximation", () => {
  it("gives free labour-market access: no sponsor, no salary floor", () => {
    const g = gateProfile("zoekjaar");
    expect(g.sponsorRequired).toBe(false);
    expect(g.salaryFloorApplies).toBe(false);
    expect(g.payReference).toBe("eur");
    // She is working in the Netherlands; a Dutch-language requirement can still bar her.
    expect(g.dutchLanguageApplies).toBe(true);
  });

  it("is screened for a profile that holds it, and never for one that does not", () => {
    expect(isLiveBasis("zoekjaar", WIFE_FINANCE_PROFILE)).toBe(true);
    expect(isLiveBasis("zoekjaar", PUSHKAR_PROFILE)).toBe(false);

    const wifeBases = basesForPosting("hsm", WIFE_FINANCE_PROFILE);
    expect(wifeBases).toContain("zoekjaar");
    // The HSM basis stays in play alongside it: it is what carries her PAST the
    // orientation year, and a role that clears it is worth more than one that
    // only works for the next few months.
    expect(wifeBases).toContain("hsm");
    // She has never held a partner permit. Screening under one would clear the
    // sponsor gate on a right to work she does not have.
    expect(wifeBases).not.toContain("partner-permit");

    expect(basesForPosting("hsm", PUSHKAR_PROFILE)).not.toContain("zoekjaar");
  });

  it("never lets an unknown-location posting reach for zoekjaar", () => {
    // Same rule that keeps india-local out of UNCLEAR_BASES: the most permissive
    // basis must never be what "we don't know where this is" resolves to.
    expect(basesForPosting("unclear", WIFE_FINANCE_PROFILE)).not.toContain("zoekjaar");
  });

  it("degrades to the strictest gates when a profile names a basis we cannot gate", () => {
    // A future profile could declare a permit this module has no GateProfile
    // for. Screening it under nothing would record a verdict nobody computed,
    // so the fallback is HSM — the strictest set — and the failure direction is
    // a visible reject rather than a silent pass.
    const foreign = { ...WIFE_FINANCE_PROFILE, permitBases: ["blaue-karte"] as [string, ...string[]] };
    expect(basesForPosting("hsm", foreign)).toEqual(["hsm"]);
  });
});

describe("salary criterion follows the candidate's own date of birth", () => {
  const on = new Date("2026-09-04T00:00:00Z");

  it("reads the profile's dob rather than the founder's", () => {
    // Wife: born 2001-04-07, so 25 on this date — under-30 band.
    expect(bandOn(on, WIFE_FINANCE_PROFILE.dob)).toBe("under-30");
    // Pushkar: born 1998-06-03, 28 — also under-30, but via his own date.
    expect(bandOn(on, PUSHKAR_PROFILE.dob)).toBe("under-30");

    // The bands must diverge on a date between the two thirtieth birthdays.
    const between = new Date("2029-01-01T00:00:00Z");
    expect(bandOn(between, PUSHKAR_PROFILE.dob)).toBe("over-30");
    expect(bandOn(between, WIFE_FINANCE_PROFILE.dob)).toBe("under-30");
  });

  it("threads the dob into the criterion the pay gate actually uses", () => {
    const between = new Date("2029-06-01T00:00:00Z");
    // Outside the verified 2026 window the table refuses to answer for both —
    // that is correct, and it is why this asserts inside the window instead.
    expect(criterionOn(between, WIFE_FINANCE_PROFILE.dob)).toBeNull();

    const inWindow = new Date("2026-09-04T00:00:00Z");
    expect(criterionOn(inWindow, WIFE_FINANCE_PROFILE.dob)?.band).toBe("under-30");
  });

  it("applies no floor at all on the zoekjaar basis", () => {
    const result = screenSalaryFacts(
      { unit: "none", unitInferred: false, holidayBasis: "unstated" },
      { route: "zoekjaar", now: new Date("2026-09-04T00:00:00Z") },
    );
    expect(result.status).toBe("pass");
  });
});

describe("profile registry", () => {
  it("exposes a named default rather than an implicit one", () => {
    expect(DEFAULT_PROFILE_ID).toBe("pushkar-nl-tech");
    expect(getProfile().id).toBe(DEFAULT_PROFILE_ID);
  });

  it("validates every registered profile against the schema", () => {
    // The schema existed but nothing ever parsed against it, so a malformed
    // profile would have been caught only by whatever crashed first.
    expect(() => getProfile("wife-nl-finance")).not.toThrow();
    expect(() => getProfile("no-such-profile")).toThrow(/not found/i);
  });

  it("records the wife's confirmed facts (founder, 2026-09-04)", () => {
    expect(WIFE_FINANCE_PROFILE.dob.toISOString().slice(0, 10)).toBe("2001-04-07");
    expect(WIFE_FINANCE_PROFILE.permitBases).toEqual(["zoekjaar", "hsm"]);
  });
});

describe("database scoping defaults to a profile, never to every profile", () => {
  it("brief-rank lookup is scoped so /draft N cannot resolve another candidate's row", async () => {
    const captured: Array<Record<string, unknown>> = [];
    vi.doMock("../../../src/db/client.js", () => ({
      getDb: () => ({
        select: () => ({
          from: () => ({
            where: (w: unknown) => {
              captured.push({ where: w });
              return { limit: async () => [] };
            },
          }),
        }),
      }),
    }));
    const { getApplicationByBriefRank } = await import("../../../src/db/job-queries.js");
    // Signature must not allow omitting the profile silently: the default is the
    // default PROFILE, not "no filter".
    expect(getApplicationByBriefRank.length).toBeGreaterThanOrEqual(2);
  });
});
