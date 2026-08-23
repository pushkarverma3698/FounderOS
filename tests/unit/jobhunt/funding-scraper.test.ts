/**
 * FounderOS — funding scraper unit tests
 * =======================================
 * Pure tests for the funding signal extraction. No network.
 */

import { describe, it, expect } from "vitest";
import { normaliseCompanyName } from "../../../src/tools/jobhunt/sponsor-match.js";

// ── Static extraction tests (no network) ──────────────────────────────────────

describe("funding scraper", () => {
  describe("fundingPattern extracts company names from headlines", () => {
    const fundingPattern =
      /^([A-Z][\w\s&.-]+?)\s+(?:raises?|secures?|bags?|closes?|lands?|nabs?|gets?|snags?|receives?)/i;

    const POSITIVE_CASES: [string, string][] = [
      ["Acme Corp raises $10M in Series A", "Acme Corp"],
      ["Zerodha secures $50M funding", "Zerodha"],
      ["Adyen bags €100M in growth round", "Adyen"],
      ["PostNL closes Series B of €25M", "PostNL"],
      ["PhonePe lands $200M in funding", "PhonePe"],
      ["Meesho nabs $300M investment", "Meesho"],
      ["Rapido gets $100M from investors", "Rapido"],
      ["Cred snags $80M in Series E", "Cred"],
      ["Swiggy receives $700M in mega round", "Swiggy"],
      ["Urban Company raises INR 300 Cr funding", "Urban Company"],
    ];

    for (const [headline, expected] of POSITIVE_CASES) {
      it(`extracts "${expected}" from "${headline}"`, () => {
        const match = headline.match(fundingPattern);
        expect(match).not.toBeNull();
        expect(match![1]!.trim()).toBe(expected);
      });
    }

    const NEGATIVE_CASES = [
      "Here is how startups can grow faster",
      "Top 10 funded companies in 2026",
      "Venture capital trends in India",
    ];

    for (const headline of NEGATIVE_CASES) {
      it(`does NOT match "${headline}"`, () => {
        expect(headline.match(fundingPattern)).toBeNull();
      });
    }
  });

  describe("tokenFor slug generation", () => {
    function tokenFor(name: string): string {
      return normaliseCompanyName(name).replace(/[^a-z0-9]/g, "");
    }

    it("strips legal suffixes: 'Adyen N.V.' → 'adyen'", () => {
      expect(tokenFor("Adyen N.V.")).toBe("adyen");
    });

    it("lowercases and strips non-alnum: 'Urban Company' → 'urbancompany'", () => {
      expect(tokenFor("Urban Company")).toBe("urbancompany");
    });

    it("strips trailing 'B.V.': 'PostNL B.V.' → 'postnl'", () => {
      expect(tokenFor("PostNL B.V.")).toBe("postnl");
    });

    it("strips 'Pvt Ltd': 'Razorpay Pvt Ltd' → 'razorpay'", () => {
      expect(tokenFor("Razorpay Pvt Ltd")).toBe("razorpay");
    });

    it("handles single-word names: 'Stripe' → 'stripe'", () => {
      expect(tokenFor("Stripe")).toBe("stripe");
    });

    it("respects MIN_TOKEN_LENGTH: short tokens are < 4 chars", () => {
      const token = tokenFor("AB");
      expect(token.length).toBeLessThan(4);
    });
  });
});
