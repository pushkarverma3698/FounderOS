/**
 * Unit tests — the partner permit is applied for, not granted.
 *
 * Founder, 2026-08-21: "for partner permit screen those jobs also as it is
 * currently applied and waiting for the decision."
 *
 * So the screening set is unchanged and these tests assert that first. What
 * changed is that the founder-facing wording now says the basis is pending —
 * and, crucially, that it says so on rows screened BEFORE the fact changed.
 *
 * WHY LIVE RATHER THAN STORED. Gate evidence is frozen at screening time on
 * purpose: it records what was decided about a POSTING, and re-deriving it later
 * would let today's rules rewrite yesterday's verdict. A permit basis is not
 * that. It is a fact about the PERSON, it changes, and a queue row that keeps
 * asserting a settled right to work is a row he might act on believing it.
 */

import { describe, it, expect } from "vitest";
import {
  routeLabel,
  gateProfile,
  basesForPosting,
  LIVE_PERMIT_BASES,
} from "../../../src/tools/jobhunt/permit-routes.js";

describe("partner permit — still screened", () => {
  it("remains a live basis, so those roles keep reaching the shortlist", () => {
    expect(LIVE_PERMIT_BASES).toContain("partner-permit");
  });

  it("is still one of the bases a Netherlands role is screened under", () => {
    expect(basesForPosting("hsm")).toContain("partner-permit");
  });

  it("still applies neither the sponsor gate nor the salary floor", () => {
    // Once granted it is free labour-market access. Tightening the gates would
    // manufacture rejections for a permit decision that may well come through.
    const profile = gateProfile("partner-permit");
    expect(profile.sponsorRequired).toBe(false);
    expect(profile.salaryFloorApplies).toBe(false);
  });
});

describe("partner permit — but visibly pending", () => {
  it("says the application is pending, in the label the brief prints", () => {
    expect(routeLabel("partner-permit")).toMatch(/pending/i);
  });

  it("says it in the long-form basis too, without claiming the gates are settled", () => {
    const basis = gateProfile("partner-permit").basis;
    expect(basis).toMatch(/applied for|awaiting/i);
  });

  it("does not mark the other bases pending — only this one is unresolved", () => {
    expect(routeLabel("india-local")).not.toMatch(/pending/i);
    expect(routeLabel("hsm")).not.toMatch(/pending/i);
  });

  it("passes an unknown or legacy route through unchanged rather than relabelling it", () => {
    expect(routeLabel("some-old-value")).toBe("some-old-value");
  });
});
