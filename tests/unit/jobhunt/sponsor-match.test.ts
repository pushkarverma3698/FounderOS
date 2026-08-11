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

  it("strips non-Dutch legal suffixes the board registry and paid feed actually carry", () => {
    // The free-board registry names employers as their board does ("Exploding
    // Kittens, Inc.") while the paid feed names them as the ad does ("Exploding
    // Kittens"). dedupeKey() builds on this function, so a suffix that survives
    // here splits one job into two rows — one per lane.
    expect(normaliseCompanyName("Exploding Kittens, Inc.")).toBe("exploding kittens");
    expect(normaliseCompanyName("Zeeco, Inc.")).toBe("zeeco");
    expect(normaliseCompanyName("Infosys Pvt. Ltd.")).toBe("infosys");
    // Spelled-out and abbreviated forms of the same legal form must agree —
    // prod row "Hybrid Laboratories India Private Limited" is the live case.
    expect(normaliseCompanyName("Hybrid Laboratories India Private Limited")).toBe(
      "hybrid laboratories india",
    );
    expect(normaliseCompanyName("Zalando SE")).toBe("zalando");
    expect(normaliseCompanyName("Celonis GmbH")).toBe("celonis");
  });

  it("never strips a legal token that is the whole name, or a non-trailing one", () => {
    // The guard is positional: only TRAILING tokens are legal-form noise.
    expect(normaliseCompanyName("Ltd")).toBe("ltd");
    expect(normaliseCompanyName("Co & Co Amsterdam")).toBe("co co amsterdam");
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

/**
 * A register entry whose whole identity is one category word ("X-Systems B.V." →
 * "systems") used to be inherited as a candidate by every company with that word
 * in its name, which is what flooded the approval queue. A word carried by many
 * register entries is a category, not an identity.
 *
 * Thirteen entries carry "systems" here; "weaviate" is carried by one.
 */
const categoryIndex: SponsorIndex = new Map([
  ...["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"].map(
    (w) => [`systems ${w}`, `Systems ${w} B.V.`] as [string, string],
  ),
  ["x systems", "X-Systems B.V."],
  ["weaviate", "Weaviate B.V."],
]);

describe("matchSponsor — category words versus identities", () => {
  it("does not queue an unrelated company that merely shares a category word", () => {
    const r = matchSponsor("Fnordling Systems", categoryIndex);
    expect(r.verdict).toBe("not-sponsor");
  });

  it("still queues an unrelated company that shares a distinctive name", () => {
    // "weaviate" identifies exactly one entry, so the overlap is worth a human.
    const r = matchSponsor("Fnordling Weaviate", categoryIndex);
    expect(r.verdict).toBe("uncertain");
    expect(r.candidates).toContain("Weaviate B.V.");
  });

  it("still queues an abbreviation, even one made of a category word", () => {
    // The other direction — the ad gives less name than the register, as with
    // "ASML" for "ASML Netherlands B.V.". That is recall, and it is untouched.
    expect(matchSponsor("Systems", categoryIndex).verdict).toBe("uncertain");
  });

  it("still queues a multi-word register entry sitting inside a longer ad name", () => {
    // Two common words together are an identity again; only the lone-category-word
    // entries are dropped.
    const r = matchSponsor("Fnordling Systems Alpha", categoryIndex);
    expect(r.verdict).toBe("uncertain");
    expect(r.candidates).toContain("Systems alpha B.V.");
  });
});
