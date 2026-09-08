/**
 * Tashi applies in India too — founder directive, 2026-09-08
 * ==========================================================
 * Declared fact, not an inference: "Tashi will also apply in india". Her profile
 * targeted the Netherlands only until today, which meant every Indian posting
 * `countryFromLocation` could see resolved to `other` and was dropped by
 * `filterCandidates` before it cost a body fetch — correct while she had no
 * basis there, wrong the moment she does.
 *
 * These tests pin the three things that had to change together, because changing
 * any one alone produces a silent wrong answer:
 *
 *   1. the MARKET (targetCountries) — or the row never reaches screening;
 *   2. the BASIS (permitBases) — or it reaches screening and is rejected as
 *      "not a market you have a legal basis for", which is what her 56 existing
 *      india-local rows say today;
 *   3. the PAY YARDSTICK — or she silently inherits the founder's own ₹15 LPA
 *      line, which is his preference and a tech-market number.
 *
 * And the one thing that must NOT change: an unlocated posting still cannot be
 * carried as an Indian local hire for anybody.
 */

import { describe, it, expect } from "vitest";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";
import { countryFromLocation } from "../../../src/tools/jobhunt/country.js";
import { basesForPosting, isLiveBasis } from "../../../src/tools/jobhunt/permit-routes.js";
import { screenIndianPay, INDIA_PAY_REFERENCE_INR } from "../../../src/tools/jobhunt/pay-india.js";

const wife = getProfile("wife-nl-finance");

describe("the NL finance profile now declares the Indian market", () => {
  it("targets both NL and IN, Netherlands first", () => {
    expect(wife.targetCountries.map((c) => c.code)).toEqual(["NL", "IN"]);
  });

  it("resolves Indian locations instead of dropping them as 'other'", () => {
    expect(countryFromLocation("Bengaluru, Karnataka, India", wife)).toBe("IN");
    expect(countryFromLocation("Gurugram", wife)).toBe("IN");
    expect(countryFromLocation("Mumbai", wife)).toBe("IN");
    // Unchanged for her existing market.
    expect(countryFromLocation("Amsterdam, Netherlands", wife)).toBe("NL");
    // And still not a claim about a market nobody targets.
    expect(countryFromLocation("Bogotá, Colombia", wife)).toBe("other");
  });
});

describe("the Indian basis is live for her, and only on a positive finding", () => {
  it("holds india-local", () => {
    expect(wife.permitBases).toContain("india-local");
    expect(isLiveBasis("india-local", wife)).toBe(true);
  });

  it("screens a POSITIVELY Indian posting as an Indian local hire", () => {
    expect(basesForPosting("india", wife)).toEqual(["india-local"]);
  });

  it("REGRESSION: never reaches for india-local on an unlocated posting", () => {
    // UNCLEAR_BASES excludes india-local on purpose — it has the fewest gates of
    // any basis, so it would win every tie on a posting nobody could place. That
    // mechanism put a Bogotá role into APPLY TODAY once already.
    expect(basesForPosting("unclear", wife)).not.toContain("india-local");
  });

  it("keeps her Dutch bases exactly as they were", () => {
    expect(basesForPosting("hsm", wife)).toEqual(["zoekjaar", "hsm"]);
  });
});

describe("she does not inherit the founder's ₹15 LPA line", () => {
  /**
   * `INDIA_PAY_REFERENCE_LPA` is documented in pay-india.ts as the founder's own
   * preference, chosen by him from stated options on 2026-08-01 — not a legal
   * bar and not a market rate. `screen.ts` read it through
   * `profile.minInrLpaFloor ?? 15`, so any profile that declared none silently
   * got his.
   *
   * For a finance analyst at 2.4 years that number is far above market, so every
   * Indian row she saw would have carried a pay flag — and a flagged row lands in
   * ASK, which the free lane's alert never announces. Her entire India lane would
   * have been silent by construction on a number nobody set for her.
   *
   * The founder has not stated a line for her, so the code states that it has none
   * rather than borrowing one. Adding a screening criterion nobody asked for is
   * the thing this repo forbids outright.
   */
  it("declares no INR floor until the founder sets one", () => {
    expect(wife.minInrLpaFloor).toBeUndefined();
  });

  it("passes a stated Indian salary when no personal line is set, and prints it", () => {
    const result = screenIndianPay({ maxAnnual: 900_000, unitInferred: false, raw: "₹9,00,000" }, null);
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("9");
    // Says the line is absent rather than implying the figure cleared one.
    expect(result.evidence).toMatch(/no .*line|not set|nobody set/i);
  });

  it("still flags below the line for a profile that HAS declared one", () => {
    const result = screenIndianPay({ maxAnnual: 900_000, unitInferred: false }, INDIA_PAY_REFERENCE_INR);
    expect(result.status).toBe("flag");
  });

  it("leaves the no-pay-stated answer alone in both cases", () => {
    expect(screenIndianPay({ unitInferred: false }, null).status).toBe("pass");
    expect(screenIndianPay({ unitInferred: false }, INDIA_PAY_REFERENCE_INR).status).toBe("pass");
  });
});
