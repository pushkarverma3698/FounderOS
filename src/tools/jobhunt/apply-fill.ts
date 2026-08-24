/**
 * FounderOS — the apply-form fill plan
 * =====================================
 * The brain behind `apply_headless`: given the fields a real application form
 * exposes, decide what to type, what to choose, what to attach, and what to
 * leave for the founder — and decide it the same way regardless of which of the
 * five supported ATS platforms rendered the form.
 *
 * PURE. No DOM, no Playwright, no network, no model. `FormField[]` is whatever
 * the driver scraped from a live page; every property below is testable against
 * a JSON fixture, which is what `tests/fixtures/apply-forms/*.json` are — real
 * field lists captured 2026-08-24 from live postings (Workwize/Greenhouse,
 * Ockto/Recruitee, WeTravel/Ashby, GRESB/Workable), plus Lever reconstructed
 * from `mac-client/mac_client/adapters.py`'s own live-verified selectors.
 *
 * TWO CLASSES OF FIELD ARE NEVER FILLED, REGARDLESS OF CONFIDENCE:
 *
 *   1. CAPTCHA. `jobs.ashbyhq.com/wetravel` carries a live reCAPTCHA on its
 *      application form. The user's global safety rules prohibit bypassing or
 *      completing a CAPTCHA outright — there is no confidence threshold at
 *      which that becomes acceptable.
 *   2. CONSENT / TERMS CHECKBOXES. `apply.workable.com/gresb` carries an
 *      unlabelled GDPR checkbox; Ashby's form carries a data-consent
 *      acknowledgement. "Accepting terms, agreements, or consent ... banners"
 *      requires the founder's own tap in every one of these tools' governing
 *      rules — a form-fill tool is not the exception.
 *
 * THE ELIGIBILITY RULE IS A MECHANISM, NOT A GUIDANCE COMMENT. A question is
 * answered from `profile.answers.work_authorization` ONLY when the question's
 * own options can be scored against that closed set with no ambiguity — see
 * `matchEligibilityOption`. Everything else — an open-text "describe your visa
 * status", a checkbox list where two options plausibly apply, a profile still
 * at `unknown` — emits `ask` and touches nothing. A wrong answer here is not a
 * typo caught on review; it is a false legal statement made in the founder's
 * name to an employer, which is why this is enforced by TYPE
 * (`chooseEligibility` can only return `choose` or `ask`, never a guess) rather
 * than by a comment asking the next person to be careful.
 */

import type { ApplyProfile } from "./apply-profile.js";

export type FieldKind =
  | "text"
  | "email"
  | "tel"
  | "number"
  | "textarea"
  | "file"
  | "checkbox"
  | "checkbox-group"
  | "radio-group"
  | "select"
  | "captcha";

/** One field on a live application form, as the driver scraped it. */
export interface FormField {
  readonly selector: string;
  readonly type: FieldKind;
  /** The question or label text. Empty string for an unlabelled field — real forms have them. */
  readonly label: string;
  readonly required: boolean;
  /** Choices, for checkbox-group / radio-group / select. */
  readonly options?: readonly string[];
  /** True for a "I agree" / GDPR / data-consent checkbox — never auto-checked. */
  readonly isConsent?: boolean;
  /** True for a CAPTCHA widget — never touched, regardless of type. */
  readonly isCaptcha?: boolean;
  /** True when the field's own label already names it a right-to-work question. */
  readonly isEligibility?: boolean;
}

export type FillAction =
  | { readonly selector: string; readonly kind: "value"; readonly value: string; readonly confidence: number; readonly why: string }
  | { readonly selector: string; readonly kind: "choose"; readonly option: string; readonly confidence: number; readonly why: string }
  | { readonly selector: string; readonly kind: "file"; readonly path: string; readonly confidence: number; readonly why: string }
  | { readonly selector: string; readonly kind: "ask"; readonly question: string; readonly why: string };

/** Facts about the specific posting, distinct from the founder's static profile. */
export interface RowFacts {
  /** Absolute path to the CV that should be uploaded — tailored if one exists, else the track default. */
  readonly resumePath?: string;
  readonly coverLetterText?: string;
}

const LABEL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  firstName: ["first name"],
  lastName: ["last name", "surname"],
  fullName: ["full name", "name"],
  email: ["email"],
  phone: ["phone", "mobile", "telephone"],
  linkedin: ["linkedin"],
  website: ["website", "portfolio", "github"],
  coverLetter: ["cover letter"],
  resume: ["resume", "cv", "curriculum vitae"],
  salary: ["salary", "compensation", "pay expectation"],
  yearsExperience: ["years of experience", "years experience"],
  noticePeriod: ["notice period", "availability", "start date", "when can you start"],
  location: ["location", "based in", "city", "where are you based"],
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function labelMatches(label: string, group: keyof typeof LABEL_GROUPS): boolean {
  const n = norm(label);
  return LABEL_GROUPS[group]!.some((phrase) => n.includes(phrase));
}

/** Phrases that mark a field as a right-to-work / visa question, even without `isEligibility` set. */
const ELIGIBILITY_PHRASES = [
  "right to work",
  "authorized to work",
  "authorised to work",
  "work authorization",
  "work authorisation",
  "visa sponsorship",
  "require sponsorship",
  "need sponsorship",
  "legally eligible",
  "work permit",
];

/**
 * Whether this field is asking about the right to work — checked against the
 * LABEL and, separately, against the OPTIONS.
 *
 * THE OPTIONS CHECK IS NOT REDUNDANT WITH THE LABEL CHECK. Measured live,
 * 2026-08-24: Workwize's own group label for this exact question is "Where
 * will you be based? *" — no eligibility phrase anywhere in it. The question
 * is unmistakably about the right to work only once you read the six answers
 * ("already authorized to work here" … "I would need visa sponsorship"). A
 * detector that trusted the label alone would miss this field entirely on a
 * form captured from production, which is the whole reason this function
 * scans both.
 */
function looksLikeEligibilityQuestion(field: FormField): boolean {
  if (field.isEligibility) return true;
  if (ELIGIBILITY_PHRASES.some((p) => norm(field.label).includes(p))) return true;
  return (field.options ?? []).some((opt) => ELIGIBILITY_PHRASES.some((p) => norm(opt).includes(p)));
}

/**
 * Score one option's text against the founder's stated authorisation status.
 *
 * Returns a confidence in [0, 1]. ANYTHING BELOW `ELIGIBILITY_CONFIDENCE_FLOOR`
 * is treated by the caller as no match at all — there is no "probably right"
 * tier for a legal statement.
 */
function scoreEligibilityOption(option: string, status: ApplyProfile["answers"] extends infer A
  ? A extends { work_authorization?: infer W } ? W : never : never): number {
  const o = norm(option);

  if (status === "requires-sponsorship") {
    if (/\bsponsorship\b/.test(o) && !/\bno\b|\bwithout\b|\bnot\b|\bdo not\b/.test(o)) return 0.95;
    if (/^no$/.test(o.trim())) return 0.9; // "Do you have the right to work?" → NO
    if (/\bwithout\s+(visa\s+)?sponsorship\b/.test(o) || /\bauthorized\b|\bauthorised\b/.test(o)) return 0; // wrong direction
    return 0;
  }
  if (status === "authorized-no-sponsorship") {
    if (/\bwithout\s+(visa\s+)?sponsorship\b/.test(o) || /\balready\s+authorized\b|\balready\s+authorised\b/.test(o)) return 0.95;
    if (/^yes$/.test(o.trim())) return 0.85;
    if (/\bsponsorship\b/.test(o) && !/\bwithout\b/.test(o)) return 0; // needs-sponsorship option
    return 0;
  }
  return 0; // status === "unknown" or undefined — never guess
}

/** Below this, "the best-scoring option" is not the same thing as "the right one." */
export const ELIGIBILITY_CONFIDENCE_FLOOR = 0.8;

/**
 * Decide a single eligibility field: `choose` on a confident, unambiguous
 * match, `ask` otherwise. THE RETURN TYPE IS THE ENFORCEMENT — there is no
 * third branch that returns a low-confidence guess.
 */
export function chooseEligibility(
  field: FormField,
  profile: ApplyProfile,
): Extract<FillAction, { kind: "choose" | "ask" }> {
  const status = profile.answers?.work_authorization;
  const askFallback = (why: string): Extract<FillAction, { kind: "ask" }> => ({
    selector: field.selector,
    kind: "ask",
    question: field.label || "This form asks about work authorisation.",
    why,
  });

  if (!status || status === "unknown") {
    return askFallback("apply-profile.json has no confirmed work_authorization — never guessed");
  }
  if (!field.options || field.options.length === 0) {
    return askFallback("no options to score — likely free text, and a legal statement is never typed automatically");
  }

  const scored = field.options
    .map((option) => ({ option, score: scoreEligibilityOption(option, status) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const second = scored[1];
  // A near-tie between the top two options means the phrasing is ambiguous for
  // THIS form, even if one option scores above the floor in isolation.
  const isAmbiguous = second !== undefined && best.score - second.score < 0.2;

  if (best.score < ELIGIBILITY_CONFIDENCE_FLOOR || isAmbiguous) {
    return askFallback(
      `best option "${best.option}" scored ${best.score.toFixed(2)} against work_authorization=${status} — below the ${ELIGIBILITY_CONFIDENCE_FLOOR} floor`,
    );
  }

  return {
    selector: field.selector,
    kind: "choose",
    option: best.option,
    confidence: best.score,
    why: `work_authorization=${status} matched "${best.option}"`,
  };
}

function textActionFor(field: FormField, value: string | undefined, why: string): FillAction | null {
  if (!value) return null;
  return { selector: field.selector, kind: "value", value, confidence: 1, why };
}

/**
 * Build the fill plan for one form.
 *
 * ORDER OF DECISION per field: captcha → consent → eligibility → the ordinary
 * profile/row lookups → ask. Each of the first three is a hard stop — a field
 * that is a CAPTCHA is never re-evaluated as an ordinary text field just
 * because it also happens to have a label.
 */
export function buildFillPlan(
  fields: readonly FormField[],
  profile: ApplyProfile,
  row: RowFacts = {},
): FillAction[] {
  const actions: FillAction[] = [];

  for (const field of fields) {
    if (field.isCaptcha || field.type === "captcha") {
      // Never touched, never counted as an `ask` either — there is nothing to
      // ask the founder to decide, the form itself demands a human solve it.
      continue;
    }

    if (field.isConsent) {
      actions.push({
        selector: field.selector,
        kind: "ask",
        question: field.label || "This form has a consent/terms checkbox.",
        why: "consent and terms checkboxes require the founder's own tap — never auto-checked",
      });
      continue;
    }

    if (looksLikeEligibilityQuestion(field)) {
      actions.push(chooseEligibility(field, profile));
      continue;
    }

    // CHOICE-TYPE FIELDS THAT AREN'T ELIGIBILITY FALL STRAIGHT TO `ask`. The
    // free-text rules below produce a `value` action, which means "type this
    // string into the field" — nonsensical for a radio-group or select, and a
    // real form proves the danger of skipping this gate: Workable's "Are you
    // willing to commute daily to Amsterdam, without relocation support?" is a
    // YES/NO radio-group whose label contains "based in", which the location
    // rule below would otherwise match and try to type "Mohali, India" into a
    // choice field. v1 has no generic chooser for an arbitrary multi-choice
    // question beyond eligibility, so the safe and correct answer is `ask`.
    const isChoiceType = field.type === "checkbox-group" || field.type === "radio-group" || field.type === "select";
    if (isChoiceType) {
      actions.push({
        selector: field.selector,
        kind: "ask",
        question: field.label || `Unrecognised ${field.type} field`,
        why: "a multi-choice question outside the eligibility check has no automatic answer in v1",
      });
      continue;
    }

    if (field.type === "file") {
      if (labelMatches(field.label, "resume") || field.label === "") {
        if (row.resumePath) {
          actions.push({
            selector: field.selector,
            kind: "file",
            path: row.resumePath,
            confidence: 1,
            why: "resume/CV upload field",
          });
          continue;
        }
      }
      actions.push({
        selector: field.selector,
        kind: "ask",
        question: field.label || "This form asks for a file upload.",
        why: "no matching file on hand for this field",
      });
      continue;
    }

    if (labelMatches(field.label, "firstName")) {
      const a = textActionFor(field, profile.first_name, "matched first-name field");
      if (a) { actions.push(a); continue; }
    }
    if (labelMatches(field.label, "lastName")) {
      const a = textActionFor(field, profile.last_name, "matched last-name field");
      if (a) { actions.push(a); continue; }
    }
    if (labelMatches(field.label, "fullName") && !labelMatches(field.label, "firstName") && !labelMatches(field.label, "lastName")) {
      const full = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
      const a = textActionFor(field, full || undefined, "matched full-name field");
      if (a) { actions.push(a); continue; }
    }
    if (labelMatches(field.label, "email")) {
      const a = textActionFor(field, profile.email, "matched email field");
      if (a) { actions.push(a); continue; }
    }
    if (labelMatches(field.label, "phone")) {
      const a = textActionFor(field, profile.phone, "matched phone field");
      if (a) { actions.push(a); continue; }
    }
    if (labelMatches(field.label, "linkedin")) {
      const a = textActionFor(field, profile.linkedin, "matched LinkedIn field");
      if (a) { actions.push(a); continue; }
    }
    if (labelMatches(field.label, "website")) {
      const a = textActionFor(field, profile.website, "matched website/portfolio field");
      if (a) { actions.push(a); continue; }
    }
    if (labelMatches(field.label, "location")) {
      const loc = [profile.answers?.location_city, profile.answers?.location_country].filter(Boolean).join(", ");
      const a = textActionFor(field, loc || undefined, "matched location field");
      if (a) { actions.push(a); continue; }
    }
    // field.type cannot be "file" here — that branch already `continue`d above.
    if (labelMatches(field.label, "coverLetter")) {
      const a = textActionFor(field, row.coverLetterText, "matched cover-letter text field");
      if (a) { actions.push(a); continue; }
    }
    if (labelMatches(field.label, "yearsExperience") && (field.type === "text" || field.type === "number")) {
      const years = profile.answers?.years_experience;
      const a = textActionFor(field, years === undefined ? undefined : String(years), "matched years-of-experience field");
      if (a) { actions.push(a); continue; }
    }

    // Reached the end with no rule claiming this field. Silence here is the
    // failure this module exists to avoid — every field gets a disposition.
    actions.push({
      selector: field.selector,
      kind: "ask",
      question: field.label || `Unrecognised ${field.type} field`,
      why: "no rule in buildFillPlan matched this field's label",
    });
  }

  return actions;
}

/** Quick counts for the summary the founder reads before approving a submit. */
export interface FillPlanSummary {
  readonly filled: number;
  readonly total: number;
  readonly unanswered: readonly string[];
}

export function summarisePlan(actions: readonly FillAction[]): FillPlanSummary {
  const unanswered = actions.filter((a) => a.kind === "ask").map((a) => a.question);
  return { filled: actions.length - unanswered.length, total: actions.length, unanswered };
}
