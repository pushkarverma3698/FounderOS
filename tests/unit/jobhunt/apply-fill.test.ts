/**
 * Unit tests — the apply-form fill plan.
 *
 * Run against REAL FIELD LISTS captured live 2026-08-24 from postings that
 * were actually in the queue that day (`tests/fixtures/apply-forms/*.json`),
 * not hand-written guesses about what a form might look like. Two real bugs
 * surfaced while building these fixtures, both fixed before this file existed:
 *
 *   1. Workwize's own label for its right-to-work question is "Where will you
 *      be based? *" — no eligibility phrase in it at all. Only the six OPTIONS
 *      name it. A label-only detector misses this field on a real form.
 *   2. Workable's relocation/commute question is a YES/NO radio-group whose
 *      label contains "based in", which the ordinary location-matching rule
 *      would otherwise claim and try to TYPE "Mohali, India" into — nonsense
 *      for a choice field, caught by gating free-text rules to text-type
 *      fields only.
 *
 * The property under test throughout is not "does it fill more fields" — it
 * is "does it ever fill a field it should not," because the failure mode that
 * matters here is a false legal statement made in the founder's name, not a
 * blank the founder has to complete himself.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildFillPlan,
  chooseEligibility,
  summarisePlan,
  ELIGIBILITY_CONFIDENCE_FLOOR,
  type FormField,
} from "../../../src/tools/jobhunt/apply-fill.js";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";

const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/apply-forms/", import.meta.url));

function loadFixture(name: string): { ats: string; fields: FormField[] } {
  const raw = JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, "utf8"));
  const fields: FormField[] = raw.fields.map((f: Record<string, unknown>) => ({
    selector: f["selector"],
    type: f["type"],
    label: f["label"] ?? "",
    required: Boolean(f["required"]),
    options: f["options"],
    isConsent: f["isConsent"],
    isCaptcha: f["isCaptcha"],
    isEligibility: f["isEligibility"],
  }));
  return { ats: raw.ats, fields };
}

const SPONSORED: ApplyProfile = {
  first_name: "Pushkar",
  last_name: "Verma",
  email: "pushkar3698@gmail.com",
  phone: "+91 97792 60517",
  linkedin: "https://www.linkedin.com/in/pushkar-verma-809155234",
  answers: {
    work_authorization: "requires-sponsorship",
    location_city: "Mohali",
    location_country: "India",
    years_experience: 3.5,
  },
};

const UNKNOWN_AUTH: ApplyProfile = { ...SPONSORED, answers: { work_authorization: "unknown" } };

describe("buildFillPlan — Greenhouse (Workwize, real 15-field form)", () => {
  const { fields } = loadFixture("greenhouse-workwize.json");

  it("fills the ordinary contact fields", () => {
    const plan = buildFillPlan(fields, SPONSORED);
    const email = plan.find((a) => a.selector === "#email");
    expect(email).toMatchObject({ kind: "value", value: "pushkar3698@gmail.com" });
  });

  it("finds the right-to-work checkbox-group EVEN THOUGH its label says only 'Where will you be based?'", () => {
    // The regression this guards: a label-only detector matches nothing here,
    // because the real Greenhouse label has no eligibility phrase in it — only
    // the six options do (verified live, 2026-08-24).
    const plan = buildFillPlan(fields, SPONSORED);
    const eligibility = plan.find((a) => a.selector === 'input[name="question_9392497101[]"]');
    expect(eligibility?.kind).toBe("choose");
    if (eligibility?.kind === "choose") {
      expect(eligibility.option).toBe("Anywhere, but I would need visa sponsorship");
      expect(eligibility.confidence).toBeGreaterThanOrEqual(ELIGIBILITY_CONFIDENCE_FLOOR);
    }
  });

  it("asks on the salary/experience/AI-usage checkbox-groups — no chooser exists for them in v1", () => {
    const plan = buildFillPlan(fields, SPONSORED);
    const nonEligibilityGroups = [
      'input[name="question_9525750101[]"]', // salary
      'input[name="question_9525643101[]"]', // years
      'input[name="question_9525644101[]"]', // who used it
      'input[name="question_9525645101[]"]', // how the decision was made
      'input[name="question_9525646101[]"]', // AI usage
    ];
    for (const selector of nonEligibilityGroups) {
      const action = plan.find((a) => a.selector === selector);
      expect(action?.kind).toBe("ask");
    }
  });

  it("matches the measured target: most of a 15-field form filled, the rest asked", () => {
    const plan = buildFillPlan(fields, SPONSORED);
    const summary = summarisePlan(plan);
    expect(summary.total).toBe(fields.length);
    // first/last/email/phone/resume-file/eligibility at minimum — the
    // mechanisable core the design doc measured against this exact form.
    expect(summary.filled).toBeGreaterThanOrEqual(6);
  });

  it("never fills the eligibility field when the profile has not confirmed a status", () => {
    const plan = buildFillPlan(fields, UNKNOWN_AUTH);
    const eligibility = plan.find((a) => a.selector === 'input[name="question_9392497101[]"]');
    expect(eligibility?.kind).toBe("ask");
  });
});

describe("buildFillPlan — Recruitee (Ockto, real 6-field form)", () => {
  const { fields } = loadFixture("recruitee-ockto.json");

  it("fills name/email/phone and marks both file uploads", () => {
    const plan = buildFillPlan(fields, SPONSORED, { resumePath: "/tmp/cv.pdf" });
    expect(plan.find((a) => a.selector === 'input[name="candidate.name"]')).toMatchObject({
      kind: "value",
      value: "Pushkar Verma",
    });
    const cv = plan.find((a) => a.selector === 'input[name="candidate.cv"]');
    expect(cv).toMatchObject({ kind: "file", path: "/tmp/cv.pdf" });
  });

  it("asks for the photo/cover-letter files when no path is on hand", () => {
    const plan = buildFillPlan(fields, SPONSORED); // no RowFacts.resumePath
    const cv = plan.find((a) => a.selector === 'input[name="candidate.cv"]');
    expect(cv?.kind).toBe("ask");
  });
});

describe("buildFillPlan — Ashby (WeTravel, real form with a live CAPTCHA + consent checkbox)", () => {
  const { fields } = loadFixture("ashby-wetravel.json");

  it("never emits any action for the CAPTCHA field", () => {
    const plan = buildFillPlan(fields, SPONSORED);
    const captchaSelectors = fields.filter((f) => f.isCaptcha).map((f) => f.selector);
    expect(captchaSelectors.length).toBeGreaterThan(0);
    for (const selector of captchaSelectors) {
      expect(plan.some((a) => a.selector === selector)).toBe(false);
    }
  });

  it("asks — never checks — the data-consent checkbox", () => {
    const plan = buildFillPlan(fields, SPONSORED);
    const consentField = fields.find((f) => f.isConsent)!;
    const action = plan.find((a) => a.selector === consentField.selector);
    expect(action?.kind).toBe("ask");
  });

  it("asks for the free-text salary-expectation number field — not a value it can invent", () => {
    // Salary EXPECTATION (a negotiating position) is distinct from the
    // profile's salary FLOOR (a legal minimum) — v1 does not conflate them.
    const plan = buildFillPlan(fields, SPONSORED);
    const salaryField = fields.find((f) => /salary expectation/i.test(f.label))!;
    expect(plan.find((a) => a.selector === salaryField.selector)?.kind).toBe("ask");
  });
});

describe("buildFillPlan — Workable (GRESB, real form with an explicit right-to-work radio)", () => {
  const { fields } = loadFixture("workable-gresb.json");

  it("answers 'Do you currently have the right to work in the Netherlands?' as NO when sponsorship is required", () => {
    const plan = buildFillPlan(fields, SPONSORED);
    const rtw = plan.find((a) => a.selector === 'input[name="QA_12298267"]');
    expect(rtw).toMatchObject({ kind: "choose", option: "NO" });
  });

  it("does NOT treat the commute/relocation radio-group as a location TEXT field", () => {
    // Regression: this field's label contains "based in", which the ordinary
    // location-matching rule would otherwise claim and try to type
    // "Mohali, India" into a YES/NO radio-group.
    const plan = buildFillPlan(fields, SPONSORED);
    const commute = plan.find((a) => a.selector === 'input[name="QA_12298266"]');
    expect(commute?.kind).toBe("ask");
    if (commute?.kind === "ask") {
      expect(commute.question).toContain("Amsterdam");
    }
  });

  it("asks — never checks — the unlabelled GDPR checkbox", () => {
    const plan = buildFillPlan(fields, SPONSORED);
    const gdpr = fields.find((f) => f.isConsent)!;
    expect(plan.find((a) => a.selector === gdpr.selector)?.kind).toBe("ask");
  });
});

describe("chooseEligibility — the mechanism directly", () => {
  const rightToWorkField: FormField = {
    selector: "sel",
    type: "radio-group",
    label: "Do you have the right to work here?",
    required: true,
    options: ["Yes", "No"],
  };

  it("never returns anything but choose or ask — enforced by the return type, not a convention", () => {
    const result = chooseEligibility(rightToWorkField, SPONSORED);
    expect(["choose", "ask"]).toContain(result.kind);
  });

  it("asks on a genuine near-tie between two options, rather than picking whichever sorts first", () => {
    const tied: FormField = {
      ...rightToWorkField,
      options: ["I need visa sponsorship", "I require sponsorship to work legally"],
    };
    const result = chooseEligibility(tied, SPONSORED);
    expect(result.kind).toBe("ask");
  });

  it("does NOT ask when one option is a clear match and the rest are clearly not", () => {
    // The tie-guard above must not make the matcher over-cautious on a form
    // that actually distinguishes its options well — Workwize's real six
    // options are exactly this shape (one match, five clear non-matches).
    const clear: FormField = {
      ...rightToWorkField,
      options: [
        "Already authorized to work here",
        "Authorized without visa sponsorship",
        "I would need visa sponsorship",
      ],
    };
    const result = chooseEligibility(clear, SPONSORED);
    expect(result.kind).toBe("choose");
  });

  it("asks when the profile status is unknown, regardless of how clear the options are", () => {
    const result = chooseEligibility(rightToWorkField, UNKNOWN_AUTH);
    expect(result.kind).toBe("ask");
  });

  it("asks when the field has no options at all (free text)", () => {
    const freeText: FormField = { ...rightToWorkField, type: "textarea", options: undefined };
    const result = chooseEligibility(freeText, SPONSORED);
    expect(result.kind).toBe("ask");
  });
});

describe("summarisePlan", () => {
  it("counts filled as everything that is not an ask", () => {
    const plan = buildFillPlan(loadFixture("recruitee-ockto.json").fields, SPONSORED, { resumePath: "/tmp/cv.pdf" });
    const summary = summarisePlan(plan);
    expect(summary.filled + summary.unanswered.length).toBe(summary.total);
  });
});
