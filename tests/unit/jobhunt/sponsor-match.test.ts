/**
 * Sponsor-register matching tests.
 *
 * This gate decides whether an application is even legal. The asymmetry matters:
 * a false NEGATIVE loses one opportunity; a false POSITIVE burns a whole
 * application on a company that cannot lawfully hire him. So "uncertain" is a
 * first-class verdict that routes to manual review — never a silent pass or drop.
 *
 * The naive substring approach was already tried and produced 1,427 false
 * positives ("ing" matching "Consulting"/"Holding"). These tests pin that shut.
 */

import { describe, it, expect } from "vitest";
import {
  normaliseCompanyName,
  matchSponsor,
  type SponsorIndex,
} from "../../../src/tools/jobhunt/sponsor-match.js";

const index: SponsorIndex = new Map([
  ["booking com", "Booking.com B.V."],
  ["weaviate", "Weaviate B.V."],
  ["deeploy", "Deeploy B.V."],
  ["adyen", "Adyen N.V."],
  ["asml netherlands", "ASML Netherlands B.V."],
  ["elasticsearch", "elasticsearch B.V."],
]);

describe("normaliseCompanyName", () => {
  it("strips Dutch legal suffixes", () => {
    expect(normaliseCompanyName("Weaviate B.V.")).toBe("weaviate");
    expect(normaliseCompanyName("Adyen N.V.")).toBe("adyen");
    expect(normaliseCompanyName("Deeploy BV")).toBe("deeploy");
  });

  it("normalises punctuation and spacing", () => {
    expect(normaliseCompanyName("Booking.com")).toBe("booking com");
    expect(normaliseCompanyName("  BOOKING.COM   B.V. ")).toBe("booking com");
  });

  it("does not strip a suffix that is part of the actual name", () => {
    // "Nedap" must not lose letters to an over-eager suffix rule
    expect(normaliseCompanyName("Nedap N.V.")).toBe("nedap");
  });

  it("is idempotent", () => {
    const once = normaliseCompanyName("Booking.com B.V.");
    expect(normaliseCompanyName(once)).toBe(once);
  });
});

describe("matchSponsor", () => {
  it("matches an exact registered name", () => {
    const r = matchSponsor("Weaviate B.V.", index);
    expect(r.verdict).toBe("sponsor");
    expect(r.registered_name).toBe("Weaviate B.V.");
  });

  it("matches when the ad omits the legal suffix", () => {
    expect(matchSponsor("Weaviate", index).verdict).toBe("sponsor");
    expect(matchSponsor("Booking.com", index).verdict).toBe("sponsor");
  });

  it("rejects a company genuinely absent from the register", () => {
    const r = matchSponsor("Miro", index);
    expect(r.verdict).toBe("not-sponsor");
  });

  it("NEVER substring-matches a shorter name inside a longer one", () => {
    // the 1,427-false-positive bug: these must not match "adyen" or "deeploy"
    expect(matchSponsor("Adyen Consulting Group", index).verdict).not.toBe("sponsor");
    expect(matchSponsor("Deeploy Holding Partners", index).verdict).not.toBe("sponsor");
  });

  it("returns 'uncertain' for a plausible partial rather than guessing", () => {
    // "ASML" alone is a real prefix of a registered entity — a human should check
    const r = matchSponsor("ASML", index);
    expect(r.verdict).toBe("uncertain");
    expect(r.candidates).toContain("ASML Netherlands B.V.");
  });

  it("treats an empty or junk company name as uncertain, not as a sponsor", () => {
    expect(matchSponsor("", index).verdict).toBe("uncertain");
    expect(matchSponsor("   ", index).verdict).toBe("uncertain");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(matchSponsor("  eLaStIcSeArCh  b.v. ", index).verdict).toBe("sponsor");
  });

  it("always returns evidence explaining the verdict", () => {
    for (const name of ["Weaviate", "Miro", "ASML"]) {
      expect(matchSponsor(name, index).evidence.length).toBeGreaterThan(0);
    }
  });
});
