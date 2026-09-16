/**
 * Unit tests — the years gate's "with N years of X" qualifier.
 *
 * THE PROD DEFECT, verbatim from `gate_json` on 2026-09-15. LinkedIn, "Staff
 * Software Engineer (Applied AI)", sitting at rank 32 of Pushkar's DO TODAY:
 *
 *   Asks for 2 year(s) — within reach of your ~3.5 shipped. Their words:
 *   "8+ years of software engineering experience, with 2+ years hands-on
 *    building applied AI/LLM-based systems in production"
 *
 * The verdict quotes the sentence that contradicts it. `extractExperienceDemand`
 * takes the minimum across every figure it finds, and inside ONE sentence that
 * rule inverts the requirement: the "2+" is a sub-requirement nested inside the
 * "8+", not an alternative to it. Two more live rows carried the same shape
 * (Tashi's "Supplier Quality Auditor" 10→2, "Software Application Architect"
 * 8→2), so three of the 167 scored rows had a bar reported as a quarter of what
 * the employer wrote.
 *
 * WHAT MUST NOT CHANGE. The minimum rule is correct ACROSS sentences and inside
 * a range — "3-5 years" is a 3-year bar, and "7 years with Kubernetes is a plus"
 * in its own sentence is a wish list. Those cases have their own tests in
 * experience.test.ts and are asserted again here as the over-correction guard:
 * a fix that reads only the first number anywhere would start rejecting the
 * roles the range tests exist to protect.
 */

import { describe, it, expect } from "vitest";
import {
  extractExperienceDemand,
  experienceGate,
} from "../../../src/tools/jobhunt/experience.js";
import { PUSHKAR_PROFILE } from "../../../src/tools/jobhunt/profile-config.js";

describe("extractExperienceDemand — a nested qualifier is not a lower bar", () => {
  it("reads the PRIMARY figure when a 'with N years' qualifier follows it", () => {
    // The live row. The bar is 8, not 2.
    const text =
      "8+ years of software engineering experience, with 2+ years hands-on building " +
      "applied AI/LLM-based systems in production";
    expect(extractExperienceDemand(text).minYears).toBe(8);
  });

  it("handles the other qualifier words the same way", () => {
    for (const [text, expected] of [
      ["10 years of audit experience, including 2 years in a supervisory role", 10],
      ["8 years of experience of which 3 years in SAP", 8],
      ["7 years of experience, with at least 2 years of experience in FP&A", 7],
      ["Minimaal 8 jaar ervaring, waarvan 2 jaar in een leidinggevende rol", 8],
    ] as const) {
      expect(extractExperienceDemand(text).minYears, text).toBe(expected);
    }
  });

  it("quotes the sentence the PRIMARY figure came from", () => {
    // The evidence and the verdict must agree. A verdict quoting a sentence that
    // contradicts it is what made this defect invisible for weeks.
    const text =
      "8+ years of software engineering experience, with 2+ years hands-on AI work.";
    const demand = extractExperienceDemand(text);
    expect(demand.evidence).toContain("8+ years");
  });

  it("still takes the FLOOR of a plain range", () => {
    // Over-correction guard. "3-5 years" must stay a 3-year bar.
    expect(extractExperienceDemand("3-5 years of experience in backend.").minYears).toBe(3);
    expect(extractExperienceDemand("2 to 6 years of experience required.").minYears).toBe(2);
  });

  it("still takes the LOWEST figure across SEPARATE sentences", () => {
    // Over-correction guard. Two independent sentences are alternatives, and the
    // lower one is the entry bar.
    const text =
      "You have 3 years of experience building APIs. 7 years of experience with " +
      "Kubernetes is a plus.";
    expect(extractExperienceDemand(text).minYears).toBe(3);
  });

  it("still ignores a company advertising its own age", () => {
    expect(
      extractExperienceDemand("We have over 20 years of experience, with 5 years in the EU.")
        .minYears,
    ).toBeNull();
  });

  it("reads a bare qualifier with no primary figure as that figure", () => {
    // "with 2+ years of Python" standing alone is a real 2-year bar, not a
    // qualifier on something unstated. The fix must not swallow it.
    expect(extractExperienceDemand("Comfortable with 2+ years of Python experience.").minYears)
      .toBe(2);
  });
});

describe("experienceGate — the live row now reads as the reject it is", () => {
  it("rejects the LinkedIn Staff posting instead of passing it on 2 years", () => {
    const description =
      "8+ years of software engineering experience, with 2+ years hands-on building " +
      "applied AI/LLM-based systems in production. Nice to Have: experience with " +
      "fine-tuning or custom model training.";
    const gate = experienceGate(description, "Staff Software Engineer (Applied AI)", PUSHKAR_PROFILE);
    expect(gate.status).toBe("reject");
    expect(gate.evidence).toContain("8");
  });
});
