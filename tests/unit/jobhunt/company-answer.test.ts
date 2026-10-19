import { describe, expect, it } from "vitest";
import { namesCompany } from "../../../src/tools/jobhunt/company-answer.js";

describe("namesCompany", () => {
  it("matches the company name anywhere in the answer, ignoring case", () => {
    expect(namesCompany("Mollie's Career Site", "Mollie")).toBe(true);
    expect(namesCompany("found you via MOLLIE jobs", "mollie")).toBe(true);
    expect(namesCompany("LinkedIn", "Mollie")).toBe(false);
  });

  it("ignores company names shorter than 3 characters and blank ones", () => {
    expect(namesCompany("I like it at ING", "ING")).toBe(true);
    expect(namesCompany("Go to the office", "Go")).toBe(false);
    expect(namesCompany("anything", "  ")).toBe(false);
  });
});
