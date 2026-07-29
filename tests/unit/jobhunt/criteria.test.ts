/**
 * Unit tests — IND salary criteria by date.
 *
 * The predecessor was a bare `4357` literal. IND revises every 1 January, so it
 * silently becomes a WRONG legal floor on 2027-01-01 while still producing
 * confident verdicts. These tests pin the refusal to answer outside a verified
 * window, which is the whole point of the module.
 */

import { describe, it, expect } from "vitest";
import {
  criterionOn,
  bandOn,
  bandExpiryDate,
  FOUNDER_DOB,
} from "../../../src/tools/jobhunt/criteria.js";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("bandOn", () => {
  it("is under-30 today", () => {
    expect(bandOn(at("2026-07-29"))).toBe("under-30");
  });

  it("is still under-30 the day before the thirtieth birthday", () => {
    expect(bandOn(at("2028-06-02"))).toBe("under-30");
  });

  it("flips to over-30 on the thirtieth birthday itself", () => {
    // The 36% budget jump that makes every month of delay more expensive.
    expect(bandOn(at("2028-06-03"))).toBe("over-30");
  });
});

describe("bandExpiryDate", () => {
  it("is the thirtieth birthday", () => {
    expect(bandExpiryDate(FOUNDER_DOB).toISOString().slice(0, 10)).toBe("2028-06-03");
  });
});

describe("criterionOn", () => {
  it("returns the verified 2026 under-30 criterion", () => {
    const c = criterionOn(at("2026-07-29"));
    expect(c).not.toBeNull();
    expect(c!.band).toBe("under-30");
    expect(c!.monthly).toBe(4357);
    expect(c!.annualBase).toBe(52_284);
  });

  it("derives an hourly floor for the remote-contract track", () => {
    const c = criterionOn(at("2026-07-29"))!;
    expect(c.hourly).toBeCloseTo(52_284 / 2080, 2);
  });

  it("holds through the last day of the verified window", () => {
    expect(criterionOn(at("2026-12-31"))).not.toBeNull();
  });

  it("REFUSES to answer once the verified window ends", () => {
    // IND revises on 1 January. Asserting a stale legal floor is the failure this
    // module exists to prevent — the caller flags instead of inventing a verdict.
    expect(criterionOn(at("2027-01-01"))).toBeNull();
    expect(criterionOn(at("2028-07-01"))).toBeNull();
  });

  it("refuses for dates before the verified window too", () => {
    expect(criterionOn(at("2025-12-31"))).toBeNull();
  });

  it("carries a human-readable basis for evidence strings", () => {
    expect(criterionOn(at("2026-07-29"))!.basis).toContain("4357");
  });
});
