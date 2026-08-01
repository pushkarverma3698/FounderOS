/**
 * Unit tests — permit bases and their gate profiles.
 *
 * The distinction these tests exist to protect: a posting's route describes the
 * JOB (remote contract vs a Netherlands-based role), while a permit basis
 * describes PUSHKAR (what legally lets him hold it). Conflating them is what made
 * the old screener reject a Netherlands role he could take on a partner permit
 * purely because the employer was not a recognised sponsor.
 */

import { describe, it, expect } from "vitest";
import {
  basesForPosting,
  gateProfile,
  isLiveBasis,
  LIVE_PERMIT_BASES,
  type PermitBasis,
} from "../../../src/tools/jobhunt/permit-routes.js";

describe("gateProfile", () => {
  it("applies the sponsor requirement and the salary floor only on the HSM basis", () => {
    const hsm = gateProfile("hsm");
    expect(hsm.sponsorRequired).toBe(true);
    expect(hsm.salaryFloorApplies).toBe(true);
  });

  it("waives both sponsor and salary floor on a partner permit", () => {
    // A partner permit carries free labour-market access: no recognised sponsor,
    // no IND salary criterion. Running either gate would reject lawful roles.
    const partner = gateProfile("partner-permit");
    expect(partner.sponsorRequired).toBe(false);
    expect(partner.salaryFloorApplies).toBe(false);
  });

  it("waives both on a remote contract, which needs no Dutch permit at all", () => {
    const remote = gateProfile("remote-contract");
    expect(remote.sponsorRequired).toBe(false);
    expect(remote.salaryFloorApplies).toBe(false);
  });

  it("gives every basis a human-readable label and legal basis for the evidence line", () => {
    for (const basis of ["hsm", "partner-permit", "remote-contract"] as PermitBasis[]) {
      expect(gateProfile(basis).label.length).toBeGreaterThan(0);
      expect(gateProfile(basis).basis.length).toBeGreaterThan(0);
    }
  });
});

describe("basesForPosting", () => {
  it("screens a remote-contract posting only as a remote contract", () => {
    // No Dutch permit is involved in contracting from India, so neither the
    // sponsor gate nor the IND floor has anything to say about it.
    expect(basesForPosting("remote-contract")).toEqual(["remote-contract"]);
  });

  it("screens a Netherlands-based posting under every live NL permit basis", () => {
    const bases = basesForPosting("hsm");
    expect(bases).toContain("hsm");
    expect(bases).toContain("partner-permit");
    expect(bases).not.toContain("remote-contract");
  });

  it("screens an unclear posting under every basis that does not need a country", () => {
    const bases = basesForPosting("unclear");
    expect(bases).toEqual(
      expect.arrayContaining(["hsm", "partner-permit", "remote-contract"] as const),
    );
  });

  it("REGRESSION: an unclear posting is NEVER screened as an Indian local hire", () => {
    // `india-local` has the fewest gates of any basis — no register lookup, no
    // permit criterion, no language bar — so including it here would make it win
    // every tie on a posting nobody could place, and "we don't know where this
    // is" would resolve to the most permissive answer available. That exact
    // mechanism put a Bogotá role into APPLY TODAY on a Dutch partner permit.
    // Being in India is a POSITIVE finding from the fetcher, never a fallback.
    expect(basesForPosting("unclear")).not.toContain("india-local");
  });

  it("screens an Indian posting only as an Indian local hire", () => {
    // Not alongside remote-contract: that would put a euro yardstick beside a
    // rupee one on the same posting and let the kinder of the two win.
    expect(basesForPosting("india")).toEqual(["india-local"]);
  });

  it("never returns a basis that is not live", () => {
    for (const posting of ["hsm", "remote-contract", "india", "unclear"] as const) {
      for (const basis of basesForPosting(posting)) {
        expect(isLiveBasis(basis)).toBe(true);
      }
    }
  });

  it("returns at least one basis for every posting route", () => {
    // An empty list would mean a posting is screened under nothing and silently
    // recorded with no verdict — the exact silent failure this module prevents.
    for (const posting of ["hsm", "remote-contract", "unclear"] as const) {
      expect(basesForPosting(posting).length).toBeGreaterThan(0);
    }
  });
});
