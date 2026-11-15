/**
 * Saved profile answers must reach the form instead of being asked again (JoVE on Workable, 2026-11-14:
 * "How soon can you join (In days) ?" was asked although notice_period_days is stored).
 */
import { describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { buildFormFillPlan, type ScrapedField } from "../../../src/tools/jobhunt/form-brain.js";

const profile = (answers: ApplyProfile["answers"] = {}): ApplyProfile => ({
  first_name: "Test", last_name: "Candidate", email: "test@example.test", phone: "+31 6 12345678", answers,
});
const field = (label: string, type: ScrapedField["type"] = "text", options?: readonly string[]): ScrapedField => ({
  selector: `#f-${label.length}`, type, label, required: true, options,
});
const one = (f: ScrapedField, p: ApplyProfile) => buildFormFillPlan([f], p)[0]!;

describe("notice period synonyms", () => {
  const p = profile({ notice_period_days: 30, notice_period_detail: "30 days, negotiable" });
  it.each([
    "How soon can you join (In days) ?", "How soon can you join?", "Notice period", "When can you start?",
    "Earliest start date", "Joining time", "Opzegtermijn", "Can you tell us your notice period (in days)?",
  ])("answers %s from the stored notice period", (label) => {
    expect(one(field(label, "textarea"), p).kind).toBe("value");
  });

  it("gives days to a field that asks for days, and the detail to a free-text one", () => {
    expect(one(field("How soon can you join (In days) ?", "textarea"), p)).toMatchObject({ kind: "value", value: "30" });
    expect(one(field("Notice period", "number"), p)).toMatchObject({ kind: "value", value: "30" });
    expect(one(field("Notice period", "text"), p)).toMatchObject({ kind: "value", value: "30 days, negotiable" });
  });

  it("falls back to days, and reads 0 days as Immediately for free text", () => {
    expect(one(field("Notice period"), profile({ notice_period_days: 45 }))).toMatchObject({ value: "45 days" });
    expect(one(field("Notice period"), profile({ notice_period_days: 0 }))).toMatchObject({ value: "Immediately" });
    expect(one(field("How soon can you join (in days)?"), profile({ notice_period_days: 0 }))).toMatchObject({ value: "0" });
  });

  it("uses a number found in the detail when only the detail is stored and days are asked", () => {
    expect(one(field("Notice period (in days)"), profile({ notice_period_detail: "60 days" }))).toMatchObject({ value: "60" });
  });

  it("never invents a value when nothing is stored", () => {
    expect(one(field("How soon can you join (In days) ?", "textarea"), profile()).kind).toBe("ask");
    expect(one(field("Notice period (in days)"), profile({ notice_period_detail: "Negotiable" })).kind).toBe("ask");
  });

  it("an explicit question_bank answer still wins", () => {
    const withBank: ApplyProfile = { ...p, question_bank: { "How soon can you join (In days) ?": "15" } };
    expect(one(field("How soon can you join (In days) ?"), withBank)).toMatchObject({ value: "15" });
  });

  it("picks the day bucket for a closed list", () => {
    const opts = ["Immediately", "15 days", "30 days", "60+ days"];
    expect(one(field("How soon can you join?", "select", opts), p)).toMatchObject({ kind: "choose", option: "30 days" });
  });
});

describe("name, experience and salary synonyms", () => {
  it.each(["First name", "Firstname", "First Name *", "Forename", "first_name"])("fills %s", (label) => {
    expect(one(field(label), profile())).toMatchObject({ kind: "value", value: "Test" });
  });
  it("fills Lastname", () => {
    expect(one(field("Lastname"), profile())).toMatchObject({ value: "Candidate" });
  });

  it("chooses the years-of-experience bucket that holds the stored years", () => {
    const opts = ["0-2 years", "3-5 years", "6-10 years", "10+ years"];
    const p = profile({ years_experience: 3.5 });
    expect(one(field("Total years of experience", "select", opts), p)).toMatchObject({ kind: "choose", option: "3-5 years" });
    expect(one(field("How many years of experience do you have?", "radio-group", ["Less than 1 year", "1-3 years", "4 or more years"]), p))
      .toMatchObject({ kind: "choose", option: "1-3 years" });
    expect(one(field("Years of experience", "select", opts), profile({ years_experience: 12 }))).toMatchObject({ option: "10+ years" });
  });
  it("asks when the years fit no single bucket, or a skill is named, or none are stored", () => {
    expect(one(field("Years of experience", "select", ["0-3 years", "3-5 years"]), profile({ years_experience: 3 })).kind).toBe("ask");
    expect(one(field("Years of experience with Python", "select", ["0-2 years", "3-5 years"]), profile({ years_experience: 3.5 })).kind).toBe("ask");
    expect(one(field("Years of experience", "select", ["0-2 years", "3-5 years"]), profile()).kind).toBe("ask");
  });

  it("maps expected salary to the stored salary; CTC (an INR figure) and current salary stay asks", () => {
    const p = profile({ salary_floor_eur_year: 52000 });
    expect(one(field("Expected CTC"), p).kind).toBe("ask"); // the stored figure is EUR per year
    expect(one(field("What is your expected salary ?", "textarea"), p)).toMatchObject({ kind: "value", value: "52000" });
    expect(one(field("Current CTC"), p).kind).toBe("ask");
    expect(one(field("What is your current fixed Salary ?"), p).kind).toBe("ask");
    expect(one(field("Expected CTC"), profile()).kind).toBe("ask");
  });
});

describe("hard stops stay closed", () => {
  it("never answers visa or eligibility from a notice or experience synonym", () => {
    const p = profile({ notice_period_days: 30, years_experience: 4 });
    expect(one(field("Do you require visa sponsorship?", "radio-group", ["Yes", "No"]), p).kind).toBe("ask");
  });
});
