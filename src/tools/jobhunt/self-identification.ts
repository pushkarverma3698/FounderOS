/**
 * FounderOS — Voluntary self-identification (EEO) fields
 * ======================================================
 * Gender, Hispanic/Latino, race/ethnicity, veteran, disability and sexual-orientation questions are
 * voluntary. The fill picks the form's own decline option unless the candidate's profile sets
 * `answers.self_identification.<category>`. A learned `question_bank` answer does not count: QA runs
 * recorded some of those, and an answer stored once is not a choice to disclose it on every form.
 *
 * PURE (`STANDARDS.md` §2): no DOM, no file I/O.
 */

import type { ApplyProfile } from "./apply-profile.js";
import type { FormFillAction, ScrapedField } from "./form-brain.js";

export type SelfIdCategory = "gender" | "hispanic_latino" | "race" | "veteran" | "disability" | "sexual_orientation";

/** Checked in order: "Are you Hispanic/Latino?" is its own question, not a race question. */
const CATEGORY_PATTERNS: ReadonlyArray<readonly [SelfIdCategory, RegExp]> = [
  ["hispanic_latino", /\b(?:hispanic|latin[aox])\b/],
  ["race", /\b(?:race|racial|ethnicity|ethnic)\b/],
  ["veteran", /\bveteran\b/],
  ["disability", /\b(?:disability|disabled)\b/],
  ["sexual_orientation", /\b(?:sexual orientation|sexuality)\b/],
  ["gender", /\b(?:gender|sex|transgender)\b/],
];

const DECLINE =
  /\b(?:decline|prefer not|rather not|choose not|not wish|don t wish|do not want|don t want|not to (?:answer|disclose|say|specify|state|self identify|identify)|liever niet)\b/;

const CHOICE_TYPES: ReadonlySet<ScrapedField["type"]> = new Set(["select", "radio-group", "checkbox-group"]);

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function selfIdCategoryOf(label: string): SelfIdCategory | null {
  const n = norm(label);
  return CATEGORY_PATTERNS.find(([, re]) => re.test(n))?.[0] ?? null;
}

/** "Decline To Self Identify", "I don't wish to answer", "Prefer not to say" … */
export function isDeclineAnswer(text: string): boolean {
  return DECLINE.test(norm(text));
}

/** The fill for a self-identification choice field, or null when `field` is not one (the normal fill runs). */
export function chooseSelfIdentification(field: ScrapedField, profile: ApplyProfile): FormFillAction | null {
  const category = CHOICE_TYPES.has(field.type) ? selfIdCategoryOf(field.label) : null;
  const options = field.options ?? [];
  if (!category || options.length === 0) return null;

  const setting = `answers.self_identification.${category}`;
  const choose = (option: string, why: string): FormFillAction => ({
    selector: field.selector, label: field.label, kind: "choose", fieldType: field.type, option, confidence: 1, why,
  });
  const ask = (why: string): FormFillAction => ({
    selector: field.selector, label: field.label, kind: "ask", question: field.label,
    required: field.required, fieldType: field.type, options, why,
  });
  const decline = options.find(isDeclineAnswer);
  const stated = profile.answers?.self_identification?.[category]?.trim();

  if (stated && isDeclineAnswer(stated)) {
    return decline ? choose(decline, `${setting} declines`) : ask(`${setting} declines and this form offers no decline option`);
  }
  if (stated) {
    const match = options.find((o) => norm(o) === norm(stated));
    return match ? choose(match, `${setting} in the candidate profile`) : ask(`${setting} matches none of these options`);
  }
  return decline ? choose(decline, `voluntary self-identification (${category}) declined: no ${setting} in the profile`) : null;
}
