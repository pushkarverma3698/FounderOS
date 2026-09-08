/**
 * The brief's legend describes THE CANDIDATE READING IT
 * =====================================================
 * MEASURED 2026-09-08, by rendering `renderLegend` against the real gate set
 * stored on Tashi's ranked Thales row. Four of the five lines were false about
 * her, because `GATE_GLOSSARY` was a module constant written when there was one
 * candidate:
 *
 *   Experience — "versus your ~3.5 years shipped"        she has 2.4
 *   Salary     — "€4,357/month base, under-30 band"      her rows are screened
 *                                                        against €3,122 (reduced)
 *   Sponsor    — "Only a recognised sponsor can hire you" her leading basis
 *                                                        (zoekjaar) needs none
 *   Location   — "neither the Netherlands nor India"      she had no India market
 *
 * The legend exists BECAUSE the founder asked "what is this? sponsor?" — a label
 * nobody defined is not information. A label defined with another person's CV and
 * another person's permit is worse than undefined: it is confidently wrong, on
 * the one block of the brief whose entire job is to explain the rest.
 */

import { describe, it, expect } from "vitest";
import { gateGlossary } from "../../../src/tools/jobhunt/gates.js";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";

/** Mid-window so `criterionOn` resolves rather than returning null. */
const NOW = new Date("2026-09-08T00:00:00Z");

const wife = getProfile("wife-nl-finance");
const founder = getProfile("pushkar-nl-tech");

describe("the legend states the reading candidate's own experience", () => {
  it("uses her years, not the founder's", () => {
    const line = gateGlossary(wife, NOW)["Experience"] ?? "";
    expect(line).toContain("2.4");
    expect(line).not.toContain("3.5");
  });

  it("still uses the founder's years on his own brief", () => {
    const line = gateGlossary(founder, NOW)["Experience"] ?? "";
    expect(line).toContain("3.5");
    expect(line).not.toContain("2.4");
  });
});

describe("the legend quotes the salary criterion actually applied to her rows", () => {
  it("names the reduced criterion for an orientation-year candidate", () => {
    const line = gateGlossary(wife, NOW)["Salary"] ?? "";
    expect(line).toContain("3,122");
    expect(line).not.toContain("4,357");
  });

  it("names the standard under-30 criterion for the founder", () => {
    const line = gateGlossary(founder, NOW)["Salary"] ?? "";
    expect(line).toContain("4,357");
    expect(line).not.toContain("3,122");
  });
});

describe("the legend does not imply a sponsor is needed on a basis that needs none", () => {
  it("says which of her bases needs no recognised sponsor", () => {
    const line = gateGlossary(wife, NOW)["Sponsor"] ?? "";
    expect(line.toLowerCase()).toContain("zoekjaar");
  });

  it("says the same for the founder, whose partner permit needs none either", () => {
    const line = gateGlossary(founder, NOW)["Sponsor"] ?? "";
    expect(line.toLowerCase()).toContain("partner");
  });
});

describe("the legend names the markets this candidate actually targets", () => {
  it("lists both of hers now that she applies in India too", () => {
    const line = gateGlossary(wife, NOW)["Location"] ?? "";
    expect(line).toContain("Netherlands");
    expect(line).toContain("India");
  });

  it("never invents a market the profile does not declare", () => {
    const nlOnly = {
      ...wife,
      targetCountries: wife.targetCountries.filter((c) => c.code === "NL"),
    };
    const line = gateGlossary(nlOnly, NOW)["Location"] ?? "";
    expect(line).toContain("Netherlands");
    expect(line).not.toContain("India");
  });
});

describe("the Pay line never borrows a line the candidate was not asked for", () => {
  it("quotes HER line, never the founder's", () => {
    const line = gateGlossary(wife, NOW)["Pay"] ?? "";
    expect(line).toContain("20");
    expect(line).not.toContain("15");
  });

  it("says the line is unset for a profile that declares none", () => {
    const noLine = { ...wife, minInrLpaFloor: undefined };
    expect((gateGlossary(noLine, NOW)["Pay"] ?? "").toLowerCase()).toMatch(/no .*line|not set/);
  });

  it("quotes the founder's own declared line on his brief", () => {
    const line = gateGlossary(founder, NOW)["Pay"] ?? "";
    expect(line).toContain("15");
  });
});

describe("the glossary keeps the shape every caller depends on", () => {
  it("still defines every gate name the renderer can encounter", () => {
    const keys = Object.keys(gateGlossary(founder, NOW));
    for (const gate of ["Sponsor", "Basis", "Salary", "Rate", "Pay", "Language", "Experience", "Location", "Posting"]) {
      expect(keys).toContain(gate);
    }
  });
});
