import { describe, it, expect } from "vitest";
import { sanitiseCompanyName, isLikelyGarbledCompanyName } from "../../../src/tools/jobhunt/aggregator-source.js";

describe("company-sanitise", () => {
  describe("sanitiseCompanyName", () => {
    it("strips job application prefix and extracts company after 'at'", () => {
      const raw = "Job Application for Product Manager, Procure-to-Pay at Zone & Co";
      expect(sanitiseCompanyName(raw)).toBe("Zone & Co");
    });

    it("extracts company after '@' separator", () => {
      const raw = "Design system manager @ Pennylane SAS";
      expect(sanitiseCompanyName(raw)).toBe("Pennylane SAS");
    });

    it("strips ATS suffix", () => {
      const raw1 = "Senior Manager, Internal Communications - Greenhouse";
      expect(sanitiseCompanyName(raw1)).toBe("Senior Manager, Internal Communications");
      
      const raw2 = "Senior Full-Stack Engineer - AI Cost Visibility - Lever";
      expect(sanitiseCompanyName(raw2)).toBe("Senior Full-Stack Engineer - AI Cost Visibility");
    });

    it("returns normal company names unchanged", () => {
      expect(sanitiseCompanyName("Stripe")).toBe("Stripe");
      expect(sanitiseCompanyName("Acme Corp")).toBe("Acme Corp");
    });

    it("handles empty or whitespace strings", () => {
      expect(sanitiseCompanyName("")).toBe("");
      expect(sanitiseCompanyName("   ")).toBe("");
    });

    it("does not mangle known good companies", () => {
      expect(sanitiseCompanyName("Greenhouse")).toBe("Greenhouse");
      expect(sanitiseCompanyName("Lever")).toBe("Lever");
    });
  });

  describe("isLikelyGarbledCompanyName", () => {
    it("flags garbled names with typical ATS suffixes or separators", () => {
      expect(isLikelyGarbledCompanyName("Senior Manager, Internal Communications - Greenhouse")).toBe(true);
      expect(isLikelyGarbledCompanyName("Design system manager @ Pennylane SAS")).toBe(true);
      expect(isLikelyGarbledCompanyName("Job Application for Engineer at Stripe")).toBe(true);
    });

    it("flags job titles based on words", () => {
      expect(isLikelyGarbledCompanyName("Senior Engineer")).toBe(true);
      expect(isLikelyGarbledCompanyName("Lead Product Developer")).toBe(true);
      expect(isLikelyGarbledCompanyName("Staff Software Engineer")).toBe(true);
    });

    it("does not flag normal company names", () => {
      expect(isLikelyGarbledCompanyName("Stripe")).toBe(false);
      expect(isLikelyGarbledCompanyName("Acme Corp")).toBe(false);
      expect(isLikelyGarbledCompanyName("Pennylane SAS")).toBe(false);
      expect(isLikelyGarbledCompanyName("Zone & Co")).toBe(false);
    });
  });
});
