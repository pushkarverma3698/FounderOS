/**
 * Unit tests — reading Indian pay, and screening it against the founder's line.
 *
 * WHY A SEPARATE READER AT ALL. The existing salary extractor is built around
 * the European ambiguity: "55.000" and "55,000" are both fifty-five thousand in
 * their own conventions, and "4,50" is four-fifty. Indian postings share none of
 * that syntax. They group by lakh — `15,00,000` is one and a half million, not
 * fifteen — and they quote units the EUR parser has never heard of: LPA, lakh,
 * crore. Running an Indian figure through the EUR path does not produce a
 * slightly wrong number; it produces a confident euro claim about a rupee salary.
 *
 * THE LINE IS THE FOUNDER'S, NOT OURS (decided 2026-08-01): ₹15 LPA, and it
 * FLAGS rather than rejects. Nothing is discarded for being under it — the role
 * still appears, with its number printed, in the section that asks a question.
 * Adding a screening criterion the founder did not ask for is a standing rule
 * against; this one he asked for, and it was chosen from stated options.
 */

import { describe, it, expect } from "vitest";
import {
  extractIndianPay,
  screenIndianPay,
  formatLpa,
  INDIA_PAY_REFERENCE_LPA,
} from "../../../src/tools/jobhunt/pay-india.js";

const LAKH = 100_000;

describe("extractIndianPay — lakh grouping and Indian units", () => {
  it("reads lakh-grouped rupees as the number they actually are", () => {
    // The whole point. Strip the commas wrong and this is fifteen, not 1.5M.
    const facts = extractIndianPay("Compensation: ₹15,00,000 per annum.");
    expect(facts.maxAnnual).toBe(15 * LAKH);
  });

  it("reads an LPA range and keeps the ceiling", () => {
    const facts = extractIndianPay("CTC: 18 - 24 LPA depending on experience.");
    expect(facts.minAnnual).toBe(18 * LAKH);
    expect(facts.maxAnnual).toBe(24 * LAKH);
  });

  it("reads the spelled-out forms", () => {
    expect(extractIndianPay("Salary: 12 lakhs per annum").maxAnnual).toBe(12 * LAKH);
    expect(extractIndianPay("We offer ₹22 lakh").maxAnnual).toBe(22 * LAKH);
    expect(extractIndianPay("Up to 1.2 crore for the right person").maxAnnual).toBe(1_20_00_000);
  });

  it("annualises a monthly figure", () => {
    const facts = extractIndianPay("₹1,50,000 per month");
    expect(facts.maxAnnual).toBe(1_50_000 * 12);
  });

  it("accepts Rs and INR as well as the symbol", () => {
    expect(extractIndianPay("Rs. 20,00,000 p.a.").maxAnnual).toBe(20 * LAKH);
    expect(extractIndianPay("INR 2500000 annually").maxAnnual).toBe(25 * LAKH);
  });

  it("quotes the text it read, so evidence can show its working", () => {
    expect(extractIndianPay("CTC 18 LPA").raw).toContain("18");
  });

  it("says nothing when the posting names no rupee figure", () => {
    expect(extractIndianPay("Great team, great mission.").maxAnnual).toBeUndefined();
    // A euro figure is NOT an Indian one. Reading €70,000 as ₹70,000 would call a
    // strong Dutch salary a sub-line Indian one.
    expect(extractIndianPay("Salary €70,000 per year").maxAnnual).toBeUndefined();
  });

  it("marks an inferred unit as inferred rather than asserting it", () => {
    const facts = extractIndianPay("₹90,000 monthly");
    expect(facts.unitInferred).toBe(false);
    const guessed = extractIndianPay("Rs 2000000");
    expect(guessed.maxAnnual).toBe(20 * LAKH);
    expect(guessed.unitInferred).toBe(true);
  });
});

describe("screenIndianPay — ₹15 LPA is a flag line, never a bar", () => {
  it("passes a role at or above the line", () => {
    const result = screenIndianPay(extractIndianPay("CTC 18 LPA"));
    expect(result.status).toBe("pass");
    expect(result.evidence).toContain("18");
  });

  it("FLAGS a role below the line — and never rejects it", () => {
    const result = screenIndianPay(extractIndianPay("CTC 8 LPA"));
    expect(result.status).toBe("flag");
    expect(result.status).not.toBe("reject");
    // The number has to be IN the sentence. A flag whose reason the founder
    // cannot read is the defect the whole gate record exists to prevent.
    expect(result.evidence).toContain("8");
    expect(result.evidence).toContain(String(INDIA_PAY_REFERENCE_LPA));
  });

  it("treats the line as a preference and says so, since it is not a legal bar", () => {
    const result = screenIndianPay(extractIndianPay("CTC 8 LPA"));
    expect(result.evidence.toLowerCase()).not.toContain("unlawful");
    expect(result.evidence.toLowerCase()).toMatch(/your line|worth|deliberate/);
  });

  it("passes an unstated figure, exactly as the no-floor Dutch bases do", () => {
    // Consistency with screenSalaryFacts, deliberately. An unstated figure where
    // no legal floor applies is a negotiation question, not grounds to hold the
    // role back — and the evidence still says nobody has confirmed the pay.
    const result = screenIndianPay(extractIndianPay("Great team, great mission."));
    expect(result.status).toBe("pass");
    expect(result.evidence.toLowerCase()).toContain("ask");
  });

  it("never mentions euros, permits or sponsors", () => {
    // An Indian role has no IND criterion, no recognised sponsor and no permit.
    // Quoting a euro reference at it is the mirror image of the original bug.
    const result = screenIndianPay(extractIndianPay("CTC 9 LPA"));
    expect(result.evidence).not.toContain("€");
    expect(result.evidence.toLowerCase()).not.toContain("permit");
    expect(result.evidence.toLowerCase()).not.toContain("sponsor");
  });
});

describe("formatLpa — the founder reads lakhs, not digits", () => {
  it("renders rupees as LPA", () => {
    expect(formatLpa(15 * LAKH)).toBe("₹15 LPA");
    expect(formatLpa(18.5 * LAKH)).toBe("₹18.5 LPA");
  });
});
