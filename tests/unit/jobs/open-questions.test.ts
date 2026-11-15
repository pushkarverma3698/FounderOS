import { describe, expect, it } from "vitest";
import { collectOpenQuestions, summaryLine, type QuestionSource } from "../../../src/tools/jobhunt/open-questions.js";

const src = (rowId: string, company: string, label: string, extra: Partial<QuestionSource> = {}): QuestionSource => ({ rowId, company, label, ...extra });
const none = () => false;

describe("collectOpenQuestions", () => {
  it("clusters wording variants on the normalised key and ranks by roles blocked", () => {
    const r = collectOpenQuestions(
      [
        src("1", "Acme", "Years of Python experience? (required)"),
        src("2", "Birch", "years of python experience"),
        src("3", "Cedar", "Years of Python experience?"),
        src("3", "Cedar", "Favourite editor"),
      ],
      none,
    );
    expect(r.questions.map((q) => [q.key, q.roles])).toEqual([["years of python experience", 3], ["favourite editor", 1]]);
    expect(r.blockedRoles).toBe(3);
    expect(summaryLine(r)).toBe("2 questions block 3 roles");
  });

  it("counts a role once per question even when the sources repeat it", () => {
    const r = collectOpenQuestions([src("1", "Acme", "Favourite editor"), src("1", "Acme", "favourite editor")], none);
    expect(r.questions[0]?.roles).toBe(1);
    expect(summaryLine(r)).toBe("1 question blocks 1 role");
  });

  it("drops a question the profile or dossier already answers", () => {
    const r = collectOpenQuestions([src("1", "Acme", "Favourite editor"), src("2", "Acme", "Pronouns used")], (l) => l === "Favourite editor");
    expect(r.questions.map((q) => q.label)).toEqual(["Pronouns used"]);
    expect(r.blockedRoles).toBe(1);
  });

  it("shows a company-specific question once as a template, across companies", () => {
    const r = collectOpenQuestions(
      [src("1", "Mollie", "Why do you want to work at Mollie?"), src("2", "Adyen", "Why do you want to work at Adyen?")],
      () => true, // even an "answered" lookup does not drop a template: it is never saved globally
    );
    expect(r.questions).toEqual([{ label: "Why do you want to work at [company]?", key: "why do you want to work at company", roles: 2, template: true }]);
  });

  it("splits eligibility, visa and self-identification out as profile fields", () => {
    const r = collectOpenQuestions(
      [
        src("1", "Acme", "Will you now or in the future require visa sponsorship?"),
        src("2", "Acme", "Gender"),
        src("3", "Acme", "Favourite editor"),
      ],
      none,
    );
    expect(r.questions.map((q) => q.label)).toEqual(["Favourite editor"]);
    expect(r.profileFields.map((q) => q.label).sort()).toEqual(["Gender", "Will you now or in the future require visa sponsorship?"]);
    expect(r.blockedRoles).toBe(1);
  });

  it("ignores file, consent and cover-letter fields", () => {
    const r = collectOpenQuestions(
      [src("1", "Acme", "Resume", { fieldType: "file" }), src("1", "Acme", "Cover letter"), src("1", "Acme", "I agree", { fieldType: "checkbox" })],
      none,
    );
    expect(r.questions).toEqual([]);
    expect(r.blockedRoles).toBe(0);
  });

  it("is empty for no sources", () => {
    expect(summaryLine(collectOpenQuestions([], none))).toBe("0 questions block 0 roles");
  });
});
