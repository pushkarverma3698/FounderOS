/**
 * Hand-off rows: the pure builder behind the copy-answers panel.
 * Fixtures are invented people; no real profile value appears here.
 */

import { describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import type { CandidateDossier } from "../../../src/tools/jobhunt/candidate-dossier.js";
import { buildHandoffRows, GROUP_ABOUT, GROUP_FORM, GROUP_LETTER, GROUP_SAVED, isWorkdayUrl } from "../../../src/tools/jobhunt/handoff-rows.js";

const JOB = { company: "Acme BV", title: "Support Engineer", url: "https://jobs.example.test/acme/1" };

const profile: ApplyProfile = {
  first_name: "Ada",
  last_name: "Fixture",
  email: "ada@example.test",
  phone: "+31 6 00000000",
  linkedin: "https://linkedin.example.test/in/ada-fixture",
  answers: {
    location_city: "Utrecht",
    location_country: "Netherlands",
    work_authorization: "authorized-no-sponsorship",
    years_experience: 4,
    notice_period_days: 30,
    salary_floor_eur_year: 60000,
  },
  question_bank: { "Do you have a driving licence?": "Yes, category B" },
};

const dossier: CandidateDossier = {
  facts: { "notice period": "One month" },
  qaPairs: { "why do you want to work here": "Because the product is useful.", "do you have a driving licence": "Old answer that the bank overrides" },
  sections: {},
  rawText: "",
};

const labels = (rows: readonly { label: string }[]): string[] => rows.map((r) => r.label);

describe("buildHandoffRows", () => {
  it("lists the standard answers in the standard order when the form was not read", () => {
    const rows = buildHandoffRows(profile, dossier, undefined, JOB);
    expect(labels(rows).slice(0, 11)).toEqual([
      "First name", "Last name", "Full name", "Email", "Phone", "LinkedIn", "City, country",
      "Years of experience", "Notice period", "Salary expectation", "Work authorisation",
    ]);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Full name"]).toBe("Ada Fixture");
    expect(byLabel["City, country"]).toBe("Utrecht, Netherlands");
    expect(byLabel["Years of experience"]).toBe("4");
    expect(byLabel["Notice period"]).toBe("One month");
    expect(byLabel["Salary expectation"]).toBe("60000 EUR per year");
    expect(byLabel["Work authorisation"]).toMatch(/no visa sponsorship/i);
    expect(rows.slice(0, 11).every((r) => r.group === GROUP_ABOUT)).toBe(true);
  });

  it("adds every learned answer once, the question bank winning over the dossier", () => {
    const rows = buildHandoffRows(profile, dossier, undefined, JOB).filter((r) => r.group === GROUP_SAVED);
    expect(rows.map((r) => r.value).sort()).toEqual(["Because the product is useful.", "Yes, category B"]);
  });

  it("gives each row a distinct id and puts the cover letter last", () => {
    const rows = buildHandoffRows(profile, dossier, undefined, { ...JOB, coverLetterText: "Dear team,\nHello." });
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    const last = rows[rows.length - 1]!;
    expect(last).toMatchObject({ group: GROUP_LETTER, value: "Dear team,\nHello." });
    expect(last.label).toContain("Acme BV");
  });

  it("makes no row for a fact the profile does not hold, and never guesses work authorisation", () => {
    const bare: ApplyProfile = { first_name: "Bo", last_name: "Test", email: "bo@example.test", phone: "1", answers: { work_authorization: "unknown" } };
    const rows = buildHandoffRows(bare, null, undefined, JOB);
    expect(labels(rows)).toEqual(["First name", "Last name", "Full name", "Email", "Phone"]);
  });

  it("leads with the form's own labels and order when the form was read", () => {
    const scraped = [
      { label: "Email address", fieldType: "text" },
      { label: "First name *", fieldType: "text" },
      { label: "Resume/CV", fieldType: "file" },
      { label: "Why do you want to work here?", fieldType: "textarea" },
      { label: "reCAPTCHA", fieldType: "captcha" },
      { label: "Surname", fieldType: "text" },
      { label: "Favourite colour", fieldType: "text" },
    ];
    const rows = buildHandoffRows(profile, dossier, scraped, JOB);
    expect(labels(rows).slice(0, 4)).toEqual(["Email address", "First name *", "Why do you want to work here?", "Surname"]);
    expect(rows.slice(0, 4).every((r) => r.group === GROUP_FORM)).toBe(true);
    expect(rows[0]!.value).toBe("ada@example.test");
    expect(rows[2]!.value).toBe("Because the product is useful.");
    expect(labels(rows)).not.toContain("Resume/CV");
    expect(labels(rows)).not.toContain("Favourite colour");
  });

  it("still shows every stored answer the form did not ask for, after the form's own rows", () => {
    const rows = buildHandoffRows(profile, dossier, [{ label: "Email", fieldType: "text" }], JOB);
    expect(rows[0]).toMatchObject({ group: GROUP_FORM, label: "Email" });
    const rest = rows.slice(1);
    expect(labels(rest)).toContain("Phone");
    expect(labels(rest)).not.toContain("Email");
    expect(rest.some((r) => r.group === GROUP_SAVED && r.value === "Yes, category B")).toBe(true);
  });

  it("uses the value the bot filled for a field it matched by itself", () => {
    const rows = buildHandoffRows(profile, null, [{ label: "Preferred pronouns", fieldType: "text", value: "they/them" }], JOB);
    expect(rows[0]).toMatchObject({ group: GROUP_FORM, label: "Preferred pronouns", value: "they/them" });
  });
});

describe("isWorkdayUrl", () => {
  it("matches Workday tenants only", () => {
    expect(isWorkdayUrl("https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/1")).toBe(true);
    expect(isWorkdayUrl("https://jobs.example.test/workday-tips")).toBe(false);
    expect(isWorkdayUrl("not a url")).toBe(false);
  });
});
