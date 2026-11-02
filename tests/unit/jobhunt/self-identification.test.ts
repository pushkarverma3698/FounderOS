/**
 * Voluntary self-identification (EEO) fields pick the decline option
 * ==================================================================
 * The 2026-10-17 real-Submit QA run (Greenhouse, Ashby, Lever) found Gender, Hispanic/Latino and
 * Veteran Status prefilled from learned question_bank answers. These questions are voluntary, so the
 * fill now picks the form's decline option unless the profile sets
 * `answers.self_identification.<category>`. A learned question_bank answer is not that setting.
 */

import { describe, expect, it } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { buildFormFillPlan, type FormFillAction, type ScrapedField } from "../../../src/tools/jobhunt/form-brain.js";
import { isDeclineAnswer, selfIdCategoryOf } from "../../../src/tools/jobhunt/self-identification.js";

const BASE: ApplyProfile = {
  first_name: "Fixture",
  last_name: "Person",
  email: "fixture@example.com",
  phone: "+31 6 00000000",
  answers: { work_authorization: "authorized-no-sponsorship" },
};

const select = (selector: string, label: string, options: string[], type: ScrapedField["type"] = "select"): ScrapedField => ({
  selector, type, label, required: false, options,
});

const GREENHOUSE_EEO: ScrapedField[] = [
  select("#gender", "Gender", ["Male", "Female", "Decline To Self Identify"]),
  select("#hispanic", "Are you Hispanic/Latino?", ["Yes", "No", "Decline To Self Identify"]),
  select("#race", "Please identify your race", ["White", "Asian", "Two or More Races", "Decline To Self Identify"]),
  select("#veteran", "Veteran Status", [
    "I am not a protected veteran",
    "I identify as one or more of the classifications of protected veteran",
    "I don't wish to answer",
  ]),
  select("#disability", "Disability Status", [
    "Yes, I have a disability, or have had one in the past",
    "No, I do not have a disability and have not had one in the past",
    "I do not want to answer",
  ]),
];

const DECLINES: Record<string, string> = {
  "#gender": "Decline To Self Identify",
  "#hispanic": "Decline To Self Identify",
  "#race": "Decline To Self Identify",
  "#veteran": "I don't wish to answer",
  "#disability": "I do not want to answer",
};

function chosen(actions: readonly FormFillAction[], selector: string): string | undefined {
  const a = actions.find((x) => x.selector === selector);
  return a?.kind === "choose" ? a.option : undefined;
}

describe("self-identification fields", () => {
  it("declines every EEO field even when question_bank holds an answer for it", () => {
    const profile: ApplyProfile = {
      ...BASE,
      question_bank: { Gender: "Male", "Are you Hispanic/Latino?": "No", "Veteran Status": "I am not a protected veteran" },
    };
    const plan = buildFormFillPlan(GREENHOUSE_EEO, profile);
    for (const [selector, decline] of Object.entries(DECLINES)) {
      expect(chosen(plan, selector), selector).toBe(decline);
    }
    expect(plan.every((a) => a.kind === "choose" && a.confidence === 1)).toBe(true);
  });

  it("declines a race checkbox group (Ashby) and a radio group (Lever)", () => {
    const fields = [
      select("#race", "Race / Ethnicity", ["Asian", "White", "I prefer not to answer"], "checkbox-group"),
      select("#gender", "Gender identity", ["Woman", "Man", "Non-binary", "Decline to self-identify"], "radio-group"),
    ];
    const plan = buildFormFillPlan(fields, BASE);
    expect(chosen(plan, "#race")).toBe("I prefer not to answer");
    expect(chosen(plan, "#gender")).toBe("Decline to self-identify");
  });

  it("uses answers.self_identification when the profile sets a value", () => {
    const profile = { ...BASE, answers: { ...BASE.answers, self_identification: { gender: "Female" } } } as ApplyProfile;
    const plan = buildFormFillPlan(GREENHOUSE_EEO, profile);
    expect(chosen(plan, "#gender")).toBe("Female");
    expect(plan.find((a) => a.selector === "#gender")?.why).toContain("answers.self_identification.gender");
    expect(chosen(plan, "#veteran")).toBe("I don't wish to answer");
  });

  it("maps a stated decline to the form's own decline wording", () => {
    const profile = { ...BASE, answers: { ...BASE.answers, self_identification: { veteran: "Prefer not to say" } } } as ApplyProfile;
    expect(chosen(buildFormFillPlan(GREENHOUSE_EEO, profile), "#veteran")).toBe("I don't wish to answer");
  });

  it("asks when the stated value matches none of the options", () => {
    const profile = { ...BASE, answers: { ...BASE.answers, self_identification: { gender: "Female" } } } as ApplyProfile;
    const fields = [select("#gender", "Gender", ["Woman", "Man", "Decline to self-identify"])];
    const [action] = buildFormFillPlan(fields, profile);
    expect(action?.kind).toBe("ask");
    expect(action?.why).toContain("answers.self_identification.gender");
  });

  it("asks rather than disclose when the profile declines and the form offers no decline option", () => {
    const profile = {
      ...BASE,
      answers: { ...BASE.answers, self_identification: { gender: "Decline to self-identify" } },
      question_bank: { Gender: "Male" },
    } as ApplyProfile;
    const [action] = buildFormFillPlan([select("#gender", "Gender", ["Male", "Female"])], profile);
    expect(action?.kind).toBe("ask");
  });

  it("keeps the existing fill when the form offers no decline option and the profile sets nothing", () => {
    const profile: ApplyProfile = { ...BASE, question_bank: { Gender: "Male" } };
    expect(chosen(buildFormFillPlan([select("#gender", "Gender", ["Male", "Female"])], profile), "#gender")).toBe("Male");
  });

  it("leaves non-EEO choice fields alone", () => {
    const profile: ApplyProfile = { ...BASE, question_bank: { "Do you prefer remote work?": "No" } };
    const fields = [select("#remote", "Do you prefer remote work?", ["Yes", "No", "I prefer not to answer"])];
    expect(chosen(buildFormFillPlan(fields, profile), "#remote")).toBe("No");
  });
});

describe("selfIdCategoryOf", () => {
  it.each([
    ["Gender", "gender"],
    ["What is your sex?", "gender"],
    ["Are you Hispanic/Latino?", "hispanic_latino"],
    ["Please identify your race", "race"],
    ["Ethnicity", "race"],
    ["Veteran Status", "veteran"],
    ["Voluntary Self-Identification of Disability", "disability"],
    ["Sexual orientation", "sexual_orientation"],
    ["What is your sexuality?", "sexual_orientation"],
  ])("%s → %s", (label, category) => {
    expect(selfIdCategoryOf(label)).toBe(category);
  });

  it.each(["City", "Country of residence", "Are you based in The Netherlands or Ireland?", "Do you embrace change?"])(
    "%s is not a self-identification field",
    (label) => {
      expect(selfIdCategoryOf(label)).toBeNull();
    },
  );
});

describe("isDeclineAnswer", () => {
  it.each(["Decline To Self Identify", "I don't wish to answer", "I do not want to answer", "I prefer not to say", "Prefer not to disclose", "I choose not to disclose"])(
    "%s declines",
    (text) => {
      expect(isDeclineAnswer(text)).toBe(true);
    },
  );

  it.each(["No", "I am not a protected veteran", "No, I do not have a disability and have not had one in the past", "Female"])(
    "%s does not decline",
    (text) => {
      expect(isDeclineAnswer(text)).toBe(false);
    },
  );
});
