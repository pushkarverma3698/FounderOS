/**
 * Application filter-pipeline tests.
 *
 * The salary gate is a LEGAL constraint, not a preference: under the under-30
 * highly-skilled-migrant band an employer cannot lawfully hire below
 * €4,357/month gross excl. holiday allowance (= €52,284/year base).
 *
 * The subtle failure mode these tests pin: most Dutch ads do not state salary
 * at all. Auto-rejecting those would discard most of the reachable market, so
 * "not stated" must be a FLAG, never a rejection.
 */

import { describe, it, expect } from "vitest";
import {
  HSM_UNDER_30_ANNUAL_BASE_EUR,
  screenSalary,
  screenLanguage,
  dedupeKey,
  isStaleEnoughToReapply,
} from "../../../src/tools/jobhunt/filters.js";

describe("HSM_UNDER_30_ANNUAL_BASE_EUR", () => {
  it("is 12x the verified monthly criterion", () => {
    expect(HSM_UNDER_30_ANNUAL_BASE_EUR).toBe(4357 * 12);
    expect(HSM_UNDER_30_ANNUAL_BASE_EUR).toBe(52_284);
  });
});

describe("screenSalary", () => {
  it("passes an ad clearly above the floor", () => {
    expect(screenSalary({ min: 60_000, max: 80_000 }).status).toBe("pass");
  });

  it("rejects an ad whose maximum is below the floor", () => {
    const r = screenSalary({ min: 38_000, max: 45_000 });
    expect(r.status).toBe("reject");
    expect(r.evidence).toContain("52284");
  });

  it("passes when the range straddles the floor — negotiable upward", () => {
    expect(screenSalary({ min: 45_000, max: 65_000 }).status).toBe("pass");
  });

  it("FLAGS rather than rejects when no salary is stated", () => {
    // Most Dutch ads omit salary. Rejecting these would discard the market.
    const r = screenSalary({});
    expect(r.status).toBe("flag");
    expect(r.status).not.toBe("reject");
  });

  it("rejects exactly at one euro below the floor and passes exactly at it", () => {
    expect(screenSalary({ max: HSM_UNDER_30_ANNUAL_BASE_EUR - 1 }).status).toBe("reject");
    expect(screenSalary({ max: HSM_UNDER_30_ANNUAL_BASE_EUR }).status).toBe("pass");
  });

  it("treats a monthly-looking figure as suspicious rather than rejecting outright", () => {
    // 4500 is plainly a monthly number, not an annual salary
    expect(screenSalary({ min: 4_500, max: 5_500 }).status).toBe("flag");
  });
});

describe("screenLanguage", () => {
  it("rejects a posting requiring Dutch fluency", () => {
    expect(screenLanguage("Fluent Dutch is required for this role").status).toBe("reject");
    expect(screenLanguage("Native Dutch speaker").status).toBe("reject");
  });

  it("passes a posting where Dutch is merely a plus", () => {
    expect(screenLanguage("Dutch is a nice to have").status).toBe("pass");
    expect(screenLanguage("Dutch is a plus, English is our working language").status).toBe("pass");
  });

  it("passes a posting with no language mention", () => {
    expect(screenLanguage("We build agent infrastructure").status).toBe("pass");
  });
});

describe("dedupeKey", () => {
  it("is stable across formatting differences", () => {
    expect(dedupeKey("Weaviate B.V.", "Senior AI Engineer")).toBe(
      dedupeKey("  weaviate  ", "senior ai engineer"),
    );
  });

  it("distinguishes different roles at the same company", () => {
    expect(dedupeKey("Weaviate", "AI Engineer")).not.toBe(dedupeKey("Weaviate", "Backend Engineer"));
  });

  it("distinguishes the same role at different companies", () => {
    expect(dedupeKey("Weaviate", "AI Engineer")).not.toBe(dedupeKey("Deeploy", "AI Engineer"));
  });
});

describe("isStaleEnoughToReapply", () => {
  const now = new Date("2026-07-29T00:00:00Z");

  it("blocks a re-application within the cooldown", () => {
    expect(isStaleEnoughToReapply(new Date("2026-07-01T00:00:00Z"), now)).toBe(false);
  });

  it("allows re-application to a genuinely re-posted role after the cooldown", () => {
    expect(isStaleEnoughToReapply(new Date("2026-01-01T00:00:00Z"), now)).toBe(true);
  });

  it("treats a never-applied role as applicable", () => {
    expect(isStaleEnoughToReapply(null, now)).toBe(true);
  });
});
