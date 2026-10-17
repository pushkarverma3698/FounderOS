/**
 * Filled answers: what the bot typed, with its value, for the hosted apply page
 * =============================================================================
 * 1. summariseFormPlan returns `filledAnswers` next to `filledLabels`: the value typed, the option
 *    chosen, or the file's NAME (never its path), with the field type, the options and whether the
 *    page may offer it for editing.
 * 2. The round trip behind the page's Save button: an answer recorded under a field's label beats
 *    the profile on the next re-fill (#1185 put explicitAnswerFor before the standard mapping).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProfilePathFor, parseApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import { readCandidateDossier, recordLearnedAnswer } from "../../../src/tools/jobhunt/candidate-dossier.js";
import {
  buildFormFillPlan,
  summariseFormPlan,
  type ScrapedField,
} from "../../../src/tools/jobhunt/form-brain.js";

const PROFILE_ID = "fixture-profile";
const CITY = "Location (City)*";

const BASE_PROFILE = {
  first_name: "Fixture",
  last_name: "Person",
  email: "fixture@example.com",
  phone: "+31 6 00000000",
  answers: { location_city: "Amsterdam", location_country: "Netherlands", auto_consent: true },
};

const FIELDS: ScrapedField[] = [
  { selector: "#name", type: "text", label: "Full name *", required: true },
  { selector: "#city", type: "text", label: CITY, required: true },
  { selector: "#cv", type: "file", label: "Resume/CV *", required: true },
  {
    selector: "#src",
    type: "select",
    label: "How did you hear about us?",
    required: false,
    options: ["Please select", "LinkedIn", "Referral"],
  },
  { selector: "#gdpr", type: "checkbox", label: "I agree to the privacy policy", required: true, isConsent: true },
  { selector: "#letter", type: "textarea", label: "Cover letter", required: false },
  { selector: "#unknown", type: "text", label: "Favourite colour", required: false },
];

function plan(over: { resumePath?: string; bank?: Record<string, string> } = {}) {
  const profile = parseProfile({ ...BASE_PROFILE, question_bank: over.bank ?? { "How did you hear about us?": "LinkedIn" } });
  return buildFormFillPlan(
    FIELDS,
    profile,
    { resumePath: over.resumePath ?? "/Users/someone/private-dir/cv-fixture.pdf", coverLetterText: "Line one\nLine two" },
  );
}

function parseProfile(raw: Record<string, unknown>) {
  const read = parseApplyProfile(JSON.stringify(raw));
  if (!read.ok) throw new Error(read.reason);
  return read.profile;
}

describe("summariseFormPlan filledAnswers", () => {
  it("returns the value, option or file name for every filled field, next to filledLabels", () => {
    const summary = summariseFormPlan(plan(), FIELDS);
    expect(summary.filledAnswers).toEqual([
      { label: "Full name *", value: "Fixture Person", fieldType: "text", editable: true },
      { label: CITY, value: "Amsterdam, Netherlands", fieldType: "text", editable: true },
      { label: "Resume/CV *", value: "cv-fixture.pdf", fieldType: "file", editable: false },
      {
        label: "How did you hear about us?",
        value: "LinkedIn",
        fieldType: "select",
        options: ["Please select", "LinkedIn", "Referral"],
        editable: true,
      },
      { label: "I agree to the privacy policy", value: "Yes", fieldType: "checkbox", editable: false },
      { label: "Cover letter", value: "Line one\nLine two", fieldType: "textarea", editable: false },
    ]);
    expect(summary.filledLabels).toEqual(summary.filledAnswers.map((f) => f.label));
    expect(summary.unanswered.map((u) => u.label)).toEqual(["Favourite colour"]);
  });

  it("keeps only the file name of an attachment, from a posix or a windows path", () => {
    const posix = summariseFormPlan(plan({ resumePath: "/Users/someone/private-dir/cv-fixture.pdf" }), FIELDS);
    const win = summariseFormPlan(plan({ resumePath: "C:\\Users\\someone\\private-dir\\cv-win.pdf" }), FIELDS);
    expect(posix.filledAnswers.find((f) => f.fieldType === "file")?.value).toBe("cv-fixture.pdf");
    expect(win.filledAnswers.find((f) => f.fieldType === "file")?.value).toBe("cv-win.pdf");
    expect(JSON.stringify(posix.filledAnswers)).not.toContain("private-dir");
    expect(JSON.stringify(win.filledAnswers)).not.toContain("private-dir");
  });

  it("leaves out a field the page did not verify, in step with filledLabels", () => {
    const summary = summariseFormPlan(plan(), FIELDS, new Set(["#name", "#city"]));
    expect(summary.filledAnswers.map((f) => f.label)).toEqual(["Full name *", CITY]);
    expect(summary.filledLabels).toEqual(["Full name *", CITY]);
    expect(summary.filled).toBe(2);
  });

  it("does not offer a value with a line break, one over 2000 characters, or an unlabeled field for editing", () => {
    const fields: ScrapedField[] = [
      { selector: "#long", type: "textarea", label: "About you", required: false },
      { selector: "#blank", type: "text", label: "", required: false },
    ];
    const long = "x".repeat(2001);
    const summary = summariseFormPlan(
      [
        { selector: "#long", label: "About you", kind: "value", value: long, confidence: 1, why: "test" },
        { selector: "#blank", label: "matched email field", kind: "value", value: "fixture@example.com", confidence: 1, why: "test" },
      ],
      fields,
    );
    expect(summary.filledAnswers.map((f) => f.editable)).toEqual([false, false]);
  });
});

describe("a recorded answer wins on the next re-fill", () => {
  let dir: string;
  let prevPath: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-filled-"));
    prevPath = process.env["APPLY_PROFILE_PATH"];
    process.env["APPLY_PROFILE_PATH"] = path.join(dir, "apply-profile.json");
  });

  afterEach(async () => {
    if (prevPath === undefined) delete process.env["APPLY_PROFILE_PATH"];
    else process.env["APPLY_PROFILE_PATH"] = prevPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seed(questionBank?: Record<string, string>): Promise<void> {
    const raw = { ...BASE_PROFILE, ...(questionBank ? { question_bank: questionBank } : {}) };
    await fs.writeFile(applyProfilePathFor(PROFILE_ID), JSON.stringify(raw, null, 2));
  }

  async function refill(): Promise<ReturnType<typeof buildFormFillPlan>> {
    const text = await fs.readFile(applyProfilePathFor(PROFILE_ID), "utf8");
    const dossier = (await readCandidateDossier(PROFILE_ID)) ?? undefined;
    return buildFormFillPlan(FIELDS, parseProfile(JSON.parse(text) as Record<string, unknown>), {}, dossier);
  }

  const valueOf = (actions: ReturnType<typeof buildFormFillPlan>, selector: string): string | undefined => {
    const a = actions.find((x) => x.selector === selector);
    return a?.kind === "value" ? a.value : a?.kind === "choose" ? a.option : undefined;
  };

  it("fills a text field from the profile until the founder edits it, then from the edit", async () => {
    await seed();
    expect(valueOf(await refill(), "#city")).toBe("Amsterdam, Netherlands");

    await recordLearnedAnswer(PROFILE_ID, CITY, "Utrecht");
    expect(valueOf(await refill(), "#city")).toBe("Utrecht");
  });

  it("uses the second edit after a first one", async () => {
    await seed();
    await recordLearnedAnswer(PROFILE_ID, CITY, "Utrecht");
    await recordLearnedAnswer(PROFILE_ID, CITY, "Rotterdam");
    expect(valueOf(await refill(), "#city")).toBe("Rotterdam");
  });

  it("applies an edited choice on a select", async () => {
    await seed({ "How did you hear about us?": "LinkedIn" });
    expect(valueOf(await refill(), "#src")).toBe("LinkedIn");

    await recordLearnedAnswer(PROFILE_ID, "How did you hear about us?", "Referral");
    expect(valueOf(await refill(), "#src")).toBe("Referral");
  });

  it("uses the edit even when an older entry for the same question has different punctuation", async () => {
    await seed({ "Location (City)": "Old Town" });
    expect(valueOf(await refill(), "#city")).toBe("Old Town");

    await recordLearnedAnswer(PROFILE_ID, CITY, "Utrecht");
    expect(valueOf(await refill(), "#city")).toBe("Utrecht");
  });
});
