/**
 * Regression tests from the 2026-10-16 live multi-ATS QA (Greenhouse Telnyx, Ashby EMA, Lever AppZen, Workable).
 * Each case is a wrong fill or a wrong ask observed on a real application form.
 */
import { describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { matchChoiceOption } from "../../../src/tools/jobhunt/candidate-dossier.js";
import { buildFormFillPlan, type ScrapedField } from "../../../src/tools/jobhunt/form-brain.js";
import { pickAutocompleteOption } from "../../../src/tools/jobhunt/form-combobox.js";

const PROFILE: ApplyProfile = {
  first_name: "Pushkar",
  last_name: "Verma",
  email: "candidate@example.com",
  phone: "+91 00000 00000",
  answers: {
    location_city: "Mohali",
    location_country: "India",
    work_authorization: "requires-sponsorship",
    salary_floor_eur_year: 52284,
    notice_period_days: 0,
  },
};

const text = (label: string, type: ScrapedField["type"] = "text"): ScrapedField => ({
  selector: `[id="${label.slice(0, 12)}"]`,
  type,
  label,
  required: true,
});

function planFor(field: ScrapedField, profile: ApplyProfile = PROFILE) {
  const [action] = buildFormFillPlan([field], profile);
  return action!;
}

describe("matchChoiceOption whole-word tie-break", () => {
  it("picks India +91 over British Indian Ocean Territory when both contain 'india'", () => {
    expect(matchChoiceOption("India", ["British Indian Ocean Territory +246", "India +91"])).toBe("India +91");
  });
});

describe("pickAutocompleteOption", () => {
  const MOHALI = [
    "SAS Nagar Mohali, Punjab, India",
    "Mohali, Maharashtra, India",
    "Mohali Khurd, Punjab, India",
    "Mohali, Madhya Pradesh, India",
  ];

  it("keeps the provider's first whole-word match for the city", () => {
    expect(pickAutocompleteOption("Mohali, India", MOHALI)).toBe("SAS Nagar Mohali, Punjab, India");
  });

  it("matches the country as a whole word, not as a prefix of Indian", () => {
    expect(pickAutocompleteOption("India", ["British Indian Ocean Territory +246", "India +91"])).toBe("India +91");
  });

  it("prefers the option that also contains the other segments", () => {
    expect(pickAutocompleteOption("Amsterdam, Netherlands", ["Amsterdam, NY, USA", "Amsterdam, North Holland, Netherlands"])).toBe(
      "Amsterdam, North Holland, Netherlands",
    );
  });

  it("returns null when no option names the place", () => {
    expect(pickAutocompleteOption("Mohali, India", ["Mumbai, Maharashtra, India"])).toBeNull();
    expect(pickAutocompleteOption("", ["India +91"])).toBeNull();
  });
});

describe("form-brain fixes from live QA", () => {
  it("asks a yes/no location question instead of typing the candidate's city into it", () => {
    const action = planFor(text("Are you based in The Netherlands or Ireland?*"));
    expect(action.kind).toBe("ask");
  });

  it("still fills a real location question", () => {
    const action = planFor(text("Location (City)*"));
    expect(action).toMatchObject({ kind: "value", value: "Mohali, India" });
  });

  it("does not answer Ethnicity with the city or an open-source question with a referral source", () => {
    expect(planFor(text("Ethnicity")).kind).toBe("ask");
    const withSource: ApplyProfile = { ...PROFILE, answers: { ...PROFILE.answers, referral_source: "LinkedIn" } };
    expect(planFor(text("Which open source projects have you contributed to?"), withSource).kind).toBe("ask");
    expect(planFor(text("How did you hear about us?"), withSource)).toMatchObject({ kind: "value", value: "LinkedIn" });
  });

  it("never types the salary expectation into a current-salary field", () => {
    expect(planFor(text("Current Base Salary")).kind).toBe("ask");
    expect(planFor(text("What is your base salary expectation?"))).toMatchObject({ kind: "value", value: "52284" });
  });

  it("types a number into a number field: notice period 0 days becomes 0, not 'Immediately'", () => {
    expect(planFor(text("Current Notice period (in days)", "number"))).toMatchObject({ kind: "value", value: "0" });
    const detail: ApplyProfile = { ...PROFILE, answers: { ...PROFILE.answers, notice_period_detail: "Immediately" } };
    expect(planFor(text("Current Notice period (in days)", "number"), detail)).toMatchObject({ kind: "value", value: "0" });
    const words: ApplyProfile = { ...PROFILE, answers: { ...PROFILE.answers, notice_period_detail: "One month after offer" } };
    expect(planFor(text("Current Notice period (in days)", "number"), words).kind).toBe("ask");
  });

  it("uses the founder's own answer over the standard profile mapping", () => {
    const answered: ApplyProfile = { ...PROFILE, question_bank: { "Location (City)*": "Mohali, Punjab, India" } };
    expect(planFor(text("Location (City)*"), answered)).toMatchObject({ kind: "value", value: "Mohali, Punjab, India" });
  });
});
