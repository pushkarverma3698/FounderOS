/**
 * The fact sheet: each audit category maps from real-shaped question wordings to a stored value, the fill is
 * trusted by auto-send, and a blank category never fills. All values are fake.
 */
import { describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { isTrustedAnswer, answerSourceOf } from "../../../src/tools/jobhunt/answer-source.js";
import { factCategoryOf, factSheetStatus } from "../../../src/tools/jobhunt/fact-sheet.js";
import { buildFormFillPlan, type ScrapedField } from "../../../src/tools/jobhunt/form-brain.js";

const profile = (answers: ApplyProfile["answers"] = {}): ApplyProfile => ({
  first_name: "Test", last_name: "Candidate", email: "test@example.test", phone: "+31 6 12345678", answers,
});
const field = (label: string, type: ScrapedField["type"] = "text", options?: readonly string[]): ScrapedField => ({
  selector: `#f-${label.length}`, type, label, required: true, options,
});
const one = (f: ScrapedField, p: ApplyProfile) => buildFormFillPlan([f], p)[0]!;

const filled = profile({
  work_authorization: "authorized-no-sponsorship",
  salary_floor_eur_year: 70000,
  referral_source: "Company careers page",
  current_title: "Test Engineer",
  current_company: "Example BV",
  years_experience: 6,
  notice_period_days: 30,
  self_identification: { gender: "Prefer not to say" },
  fact_sheet: {
    legal_name: "Testy Q. Candidate",
    nationality: "Fakeland",
    languages: "English (fluent), Dutch (basic)",
    address_line: "1 Example Street",
    address_state: "Noord-Test",
    postal_code: "1234 AB",
    "skill_years.python": "5",
    "skill_years.node-js": "3",
    "skill_years.rust": "0",
  },
});

describe("new fact-sheet categories fill from stored values", () => {
  it.each([
    ["Full legal name", "Testy Q. Candidate"],
    ["Please enter your name as it appears on your passport", "Testy Q. Candidate"],
    ["Nationality", "Fakeland"],
    ["Country of citizenship", "Fakeland"],
    ["Which languages do you speak?", "English (fluent), Dutch (basic)"],
    ["Languages", "English (fluent), Dutch (basic)"],
    ["Street address", "1 Example Street"],
    ["Address Line 1", "1 Example Street"],
    ["State/Province", "Noord-Test"],
    ["Postal code", "1234 AB"],
    ["ZIP / Postcode *", "1234 AB"],
  ])("%s", (label, value) => {
    expect(one(field(label), filled)).toMatchObject({ kind: "value", value, confidence: 1 });
  });

  it("is trusted by answerSourceOf and isTrustedAnswer, even on a sensitive label", () => {
    const a = one(field("Country of citizenship"), filled);
    expect(answerSourceOf(a.why)).toBe("factsheet");
    expect(isTrustedAnswer({ label: "Country of citizenship", source: "factsheet", confidence: 1 })).toBe(true);
    expect(isTrustedAnswer({ label: "x", source: "unknown", confidence: 1 })).toBe(false);
  });

  it("never fills a blank category: the field stays an ask", () => {
    for (const label of ["Nationality", "Postal code", "Street address", "State/Province", "Full legal name", "Languages"]) {
      expect(one(field(label), profile({}))).toMatchObject({ kind: "ask" });
    }
  });

  it("does not put a place name into a yes/no question, nor an email address into the street address", () => {
    expect(one(field("Are you a citizen of the European Union?"), filled).kind).not.toBe("value");
    expect(one(field("Email address"), filled)).toMatchObject({ value: "test@example.test" });
    expect(one(field("Do you live in the United States?"), filled).kind).not.toBe("value");
  });

  it("picks the matching option on a closed list", () => {
    expect(one(field("State", "select", ["Select...", "Noord-Test", "Zuid-Test"]), filled)).toMatchObject({ kind: "choose", option: "Noord-Test" });
    expect(one(field("Nationality", "select", ["Fakeland", "Otherland"]), filled)).toMatchObject({ kind: "choose", option: "Fakeland" });
  });

  it("a number input takes only a numeric value", () => {
    expect(one(field("Postal code", "number"), filled).kind).toBe("ask");
    expect(one(field("Postal code", "number"), profile({ fact_sheet: { postal_code: "1234" } }))).toMatchObject({ kind: "value", value: "1234" });
  });
});

describe("years and yes/no experience per skill", () => {
  it.each([
    ["How many years of experience do you have with Python?", "5"],
    ["Years of experience with Node.js", "3"],
    ["How many years of professional experience do you have using Python?", "5"],
  ])("%s", (label, value) => {
    expect(one(field(label), filled)).toMatchObject({ kind: "value", value, why: expect.stringMatching(/^fact sheet \(skill_years\./) });
    expect(one(field(label, "number"), filled)).toMatchObject({ kind: "value", value });
  });

  it("answers yes/no experience from the years, 0 meaning No", () => {
    expect(one(field("Do you have experience with Python?", "radio-group", ["Yes", "No"]), filled)).toMatchObject({ kind: "choose", option: "Yes" });
    expect(one(field("Do you have experience with Rust?", "radio-group", ["Yes", "No"]), filled)).toMatchObject({ kind: "choose", option: "No" });
    expect(one(field("Do you have experience with Python?"), filled)).toMatchObject({ kind: "value", value: "Yes" });
  });

  it("buckets years into a closed list", () => {
    expect(one(field("Years of experience with Python", "select", ["0-2", "3-5", "6+"]), filled)).toMatchObject({ kind: "choose", option: "3-5" });
  });

  it("asks when the skill is not on the sheet or two skills are named", () => {
    expect(one(field("How many years of experience do you have with Go?"), filled).kind).toBe("ask");
    expect(one(field("Years of experience with Python or Node.js?"), filled).kind).toBe("ask");
  });

  it("leaves the total-years question to the profile's years_experience", () => {
    expect(one(field("Years of experience"), filled)).toMatchObject({ kind: "value", value: "6" });
  });
});

describe("categories that live in existing fields still answer, with trusted sources", () => {
  const cases: ReadonlyArray<readonly [string, ScrapedField["type"], readonly string[] | undefined, string]> = [
    ["Will you now or in the future require sponsorship for employment visa status?", "radio-group", ["Yes", "No"], "No"],
    ["Desired salary (EUR)", "text", undefined, "70000"],
    ["How did you hear about this job?", "text", undefined, "Company careers page"],
    ["Current job title", "text", undefined, "Test Engineer"],
    ["Current employer", "text", undefined, "Example BV"],
    ["How soon can you join (in days)?", "text", undefined, "30"],
  ];
  it.each(cases)("%s", (label, type, options, expected) => {
    const a = one(field(label, type, options), filled);
    expect(a.kind === "value" ? a.value : a.kind === "choose" ? a.option : a.kind).toBe(expected);
    expect(isTrustedAnswer({ label, source: answerSourceOf(a.why), confidence: a.kind === "ask" || a.kind === "file" ? 0 : a.confidence })).toBe(true);
  });
});

describe("the category classifier and the editor markers", () => {
  it.each([
    ["Will you now or in the future require sponsorship", "work_authorization"],
    ["Are you legally authorized to work in the Netherlands?", "work_authorization"],
    ["Desired salary (EUR)", "salary"],
    ["How did you hear about this job?", "referral_source"],
    ["Gender", "eeo"],
    ["Veteran status", "eeo"],
    ["Notice period", "notice"],
    ["Current job title", "current_title"],
    ["Do you have experience with Kubernetes?", "skill_years"],
    ["Years of experience with Java", "skill_years"],
    ["How many years of experience do you have in total?", "experience_years"],
    ["Postal code", "postal_code"],
    ["Preferred pronouns", "eeo"],
  ])("%s is %s", (label, key) => {
    expect(factCategoryOf(label)?.key).toBe(key);
  });

  it.each(["Why do you want to work here?", "Upload your CV", "Open source contributions", "Current salary"])("%s is not a fact", (label) => {
    expect(factCategoryOf(label)).toBeNull();
  });

  it("marks each category blank or filled, never returning the values", () => {
    const blank = factSheetStatus(profile({}));
    expect(blank.every((s) => !s.filled)).toBe(true);
    expect(blank.map((s) => s.key)).toEqual(expect.arrayContaining(["skill_years", "work_authorization", "eeo", "legal_name", "postal_code"]));
    const done = factSheetStatus(filled);
    expect(done.every((s) => s.filled)).toBe(true);
    expect(JSON.stringify(done)).not.toContain("Fakeland");
  });

  it("treats work authorization unknown as blank", () => {
    expect(factSheetStatus(profile({ work_authorization: "unknown" })).find((s) => s.key === "work_authorization")?.filled).toBe(false);
  });
});

describe("address_state and nationality only match address-style labels", () => {
  it.each(["State/Province", "Province", "State"])("%s fills", (label) => {
    expect(one(field(label), filled).value).toBe("Noord-Test");
  });
  it.each([
    "Please state any accommodations you need",
    "Which region would you like to work in?",
  ])("%s is not a fact-sheet answer", (label) => {
    expect(one(field(label), filled).why).not.toMatch(/^fact sheet/);
    expect(one(field(label, "select", ["Noord-Test", "Other"]), filled).why).not.toMatch(/^fact sheet/);
  });
  it("yes/no nationality questions never fill, text or choice", () => {
    const q = "Do you need nationality-based sponsorship?";
    expect(one(field(q), filled).why).not.toMatch(/^fact sheet/);
    expect(one(field(q, "select", ["Yes", "No"]), filled).why).not.toMatch(/^fact sheet/);
    expect(one(field(q, "select", ["Fakeland", "Other"]), filled).why).not.toMatch(/^fact sheet/);
  });
});
