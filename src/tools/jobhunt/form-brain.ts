/**
 * FounderOS — Pure Form Brain (Multi-ATS, Multi-Candidate)
 * ========================================================
 * Given the fields scraped from a live application page, the candidate's
 * `ApplyProfile`, and their `CandidateDossier`, decide what to type, choose,
 * attach, or ask the candidate on Telegram.
 *
 * PURE (`STANDARDS.md` §2): No DOM, no Playwright, no network, no LLM.
 */

import type { ApplyProfile, WorkAuthorization } from "./apply-profile.js";
import {
  lookupLearnedAnswer,
  matchChoiceOption,
  normalizeQuestionKey,
  type CandidateDossier,
} from "./candidate-dossier.js";

/** Minimum confidence score required to select a work-authorization option automatically. */
export const ELIGIBILITY_CONFIDENCE_FLOOR = 0.7;

export type ScrapedFieldKind =
  | "text" | "email" | "tel" | "number" | "textarea"
  | "file" | "checkbox" | "checkbox-group" | "radio-group" | "select" | "captcha";

export interface ScrapedField {
  readonly selector: string;
  readonly type: ScrapedFieldKind;
  readonly label: string;
  readonly required: boolean;
  readonly options?: readonly string[];
  readonly isConsent?: boolean;
  readonly isCaptcha?: boolean;
  readonly isEligibility?: boolean;
}

export type FormFillAction =
  | { readonly selector: string; readonly label: string; readonly kind: "value"; readonly value: string; readonly confidence: number; readonly why: string }
  | { readonly selector: string; readonly label: string; readonly kind: "choose"; readonly fieldType: ScrapedFieldKind; readonly option: string; readonly confidence: number; readonly why: string }
  | { readonly selector: string; readonly label: string; readonly kind: "file"; readonly path: string; readonly confidence: number; readonly why: string }
  | { readonly selector: string; readonly label: string; readonly kind: "ask"; readonly question: string; readonly required: boolean; readonly fieldType: ScrapedFieldKind; readonly options?: readonly string[]; readonly why: string };

export interface RowApplicationFacts {
  readonly resumePath?: string;
  readonly coverLetterText?: string;
  readonly coverLetterPath?: string;
}

const LABEL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  firstName: ["first name", "voornaam", "given name"],
  lastName: ["last name", "surname", "family name", "achternaam", "familienaam"],
  fullName: ["full name", "your name", "candidate name", "volledige naam", "uw naam", "je naam", "name"],
  email: ["email", "e mail", "mailadres"],
  phone: ["phone", "mobile", "telephone", "telefoon", "mobiel"],
  linkedin: ["linkedin"],
  website: ["website", "portfolio", "personal site"],
  coverLetter: ["cover letter", "motivation letter", "motivational letter", "motivatiebrief", "sollicitatiebrief"],
  resume: ["resume", "cv", "curriculum vitae"],
  location: ["location", "based in", "where are you based", "current location", "address", "adres"],
  country: ["country", "land"],
  currentCompany: ["current company", "current employer", "employer", "company name", "huidige werkgever", "bedrijf"],
  yearsExperience: ["years of experience", "years experience", "jaren ervaring"],
};

function labelMatches(label: string, group: keyof typeof LABEL_GROUPS): boolean {
  const n = normalizeQuestionKey(label);
  if (!n) return false;
  if (group === "fullName") {
    return n === "name" || LABEL_GROUPS.fullName!.some((phrase) => phrase !== "name" && n.includes(phrase));
  }
  return LABEL_GROUPS[group]!.some((phrase) => n.includes(phrase));
}

const ELIGIBILITY_PHRASES: readonly string[] = [
  "right to work", "authorized to work", "authorised to work", "work authorization",
  "work authorisation", "visa sponsorship", "require sponsorship", "need sponsorship",
  "legally eligible", "legally authorized", "work permit", "werkvergunning", "tewerkstellingsvergunning",
];

export function isEligibilityField(field: ScrapedField): boolean {
  if (field.isEligibility) return true;
  const n = normalizeQuestionKey(field.label);
  if (ELIGIBILITY_PHRASES.some((p) => n.includes(p))) return true;
  return (field.options ?? []).some((opt) => {
    const normOpt = normalizeQuestionKey(opt);
    return ELIGIBILITY_PHRASES.some((p) => normOpt.includes(p));
  });
}

/** Score one option of a right-to-work question against the candidate's declared `WorkAuthorization`. */
export function scoreEligibilityOption(
  optionText: string,
  status: Exclude<WorkAuthorization, "unknown">,
  questionLabel: string = "",
): number {
  const o = normalizeQuestionKey(optionText);
  const q = normalizeQuestionKey(questionLabel);
  if (!o) return 0;

  const asksIfSponsorshipNeeded =
    q.includes("require sponsorship") || q.includes("need sponsorship") ||
    q.includes("require visa") || q.includes("need a visa") || q.includes("sponsorship required");
  const asksIfAuthorized =
    q.includes("authorized to work") || q.includes("authorised to work") ||
    q.includes("right to work") || q.includes("legally eligible") || q.includes("valid work permit");

  const optionSaysNeedsSponsor =
    /need.*sponsor|require.*sponsor|require.*visa|not authorized|no.*work permit|yes.*require.*sponsor/i.test(o);
  const optionSaysAuthorizedNoSponsor =
    /already authorized|authorized.*without.*sponsor|do not require.*sponsor|no sponsorship|eu citizen|valid.*permit/i.test(o);

  if (status === "requires-sponsorship") {
    if (optionSaysNeedsSponsor && !optionSaysAuthorizedNoSponsor) return 0.95;
    if (optionSaysAuthorizedNoSponsor) return 0.05;
    if (/^(?:yes|ja)$/.test(o)) return asksIfSponsorshipNeeded ? 0.9 : asksIfAuthorized ? 0.1 : 0.3;
    if (/^(?:no|nee)$/.test(o)) return asksIfAuthorized ? 0.9 : asksIfSponsorshipNeeded ? 0.1 : 0.3;
  } else {
    if (optionSaysAuthorizedNoSponsor && !optionSaysNeedsSponsor) return 0.95;
    if (optionSaysNeedsSponsor) return 0.05;
    if (/^(?:yes|ja)$/.test(o)) return asksIfAuthorized ? 0.9 : asksIfSponsorshipNeeded ? 0.1 : 0.3;
    if (/^(?:no|nee)$/.test(o)) return asksIfSponsorshipNeeded ? 0.9 : asksIfAuthorized ? 0.1 : 0.3;
  }
  return 0.2;
}

export function chooseEligibility(
  field: ScrapedField,
  profile: ApplyProfile,
  dossier?: CandidateDossier,
): Extract<FormFillAction, { kind: "choose" | "ask" | "value" }> {
  const label = field.label || "Work authorization question";
  const askFallback = (why: string): Extract<FormFillAction, { kind: "ask" }> => ({
    selector: field.selector, label, kind: "ask", question: label,
    required: field.required, fieldType: field.type, options: field.options, why,
  });

  const normQ = normalizeQuestionKey(label);
  const explicitBankAnswer =
    (profile.question_bank
      ? Object.entries(profile.question_bank).find(([k]) => normalizeQuestionKey(k) === normQ)?.[1]
      : undefined) ?? dossier?.qaPairs[normQ];

  if (explicitBankAnswer && field.options && field.options.length > 0) {
    const matched = matchChoiceOption(explicitBankAnswer, field.options);
    if (matched) {
      return {
        selector: field.selector, label, kind: "choose", fieldType: field.type,
        option: matched, confidence: 1, why: `explicitly answered in candidate question bank ("${matched}")`,
      };
    }
  }

  const status = profile.answers?.work_authorization;
  if (!status || status === "unknown") {
    return askFallback("apply-profile.json has no confirmed work_authorization — never guessed");
  }
  if (!field.options || field.options.length === 0) {
    const q = normalizeQuestionKey(label);
    if (q.includes("require sponsorship") || q.includes("need sponsorship") || q.includes("require visa") || q.includes("need a visa") || q.includes("sponsorship")) {
      const ans = status === "requires-sponsorship" ? "Yes" : "No";
      return {
        selector: field.selector, label, kind: "value", value: ans, confidence: 0.95,
        why: `work_authorization=${status} answered "${ans}" to sponsorship question`,
      };
    }
    return askFallback("no options to score — free-text legal statement is never typed automatically without an explicit question_bank entry");
  }

  const scored = field.options
    .map((option) => ({ option, score: scoreEligibilityOption(option, status, label) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  const second = scored[1];
  const isAmbiguous = second !== undefined && best.score - second.score < 0.2;
  if (best.score < ELIGIBILITY_CONFIDENCE_FLOOR || isAmbiguous) {
    return askFallback(`best option "${best.option}" scored ${best.score.toFixed(2)} against work_authorization=${status}`);
  }

  return {
    selector: field.selector, label, kind: "choose", fieldType: field.type,
    option: best.option, confidence: best.score, why: `work_authorization=${status} matched "${best.option}"`,
  };
}

function textActionFor(field: ScrapedField, value: string | undefined, why: string): FormFillAction | null {
  const clean = value?.trim();
  if (!clean) return null;
  return { selector: field.selector, label: field.label || why, kind: "value", value: clean, confidence: 1, why };
}

function matchStandardTextField(
  field: ScrapedField,
  profile: ApplyProfile,
  row: RowApplicationFacts,
): FormFillAction | null {
  if (labelMatches(field.label, "firstName")) return textActionFor(field, profile.first_name, "matched first-name field");
  if (labelMatches(field.label, "lastName")) return textActionFor(field, profile.last_name, "matched last-name field");
  if (labelMatches(field.label, "fullName") && !labelMatches(field.label, "firstName") && !labelMatches(field.label, "lastName")) {
    const full = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
    return textActionFor(field, full || undefined, "matched full-name field");
  }
  if (labelMatches(field.label, "email")) return textActionFor(field, profile.email, "matched email field");
  if (labelMatches(field.label, "phone")) return textActionFor(field, profile.phone, "matched phone field");
  if (labelMatches(field.label, "linkedin")) return textActionFor(field, profile.linkedin, "matched LinkedIn field");
  if (labelMatches(field.label, "website")) return textActionFor(field, profile.website ?? profile.answers?.github, "matched website/portfolio field");
  if (labelMatches(field.label, "country")) {
    const country = profile.answers?.location_country ?? "India";
    return textActionFor(field, country, "matched country field");
  }
  if (labelMatches(field.label, "location")) {
    const loc = [profile.answers?.location_city, profile.answers?.location_country].filter(Boolean).join(", ");
    return textActionFor(field, loc || undefined, "matched location field");
  }
  if (labelMatches(field.label, "currentCompany")) {
    const company = (profile.answers as Record<string, unknown> | undefined)?.["current_company"] as string | undefined ?? "FounderOS / Turicks";
    return textActionFor(field, company, "matched current company field");
  }
  if (labelMatches(field.label, "coverLetter")) return textActionFor(field, row.coverLetterText, "matched cover-letter text field");
  if (labelMatches(field.label, "yearsExperience") && (field.type === "text" || field.type === "number")) {
    const years = profile.answers?.years_experience;
    return textActionFor(field, years === undefined ? undefined : String(years), "matched years-of-experience field");
  }
  return null;
}

/** Build the complete deterministic fill plan for one scraped form. */
export function buildFormFillPlan(
  fields: readonly ScrapedField[],
  profile: ApplyProfile,
  row: RowApplicationFacts = {},
  dossier?: CandidateDossier,
): FormFillAction[] {
  const actions: FormFillAction[] = [];

  for (const field of fields) {
    if (field.isCaptcha || field.type === "captcha") continue;

    if (field.isConsent) {
      if (profile.answers?.auto_consent === true) {
        actions.push({
          selector: field.selector, label: field.label || "Privacy / consent", kind: "choose",
          fieldType: field.type, option: field.options?.[0] ?? "Yes", confidence: 1,
          why: "auto_consent enabled in candidate profile",
        });
      } else {
        actions.push({
          selector: field.selector, label: field.label || "Consent checkbox", kind: "ask",
          question: field.label || "Accept privacy / data-processing terms?", required: field.required,
          fieldType: field.type, options: field.options && field.options.length > 0 ? field.options : ["Yes, accept"],
          why: "consent and terms checkboxes require confirmation unless auto_consent is true",
        });
      }
      continue;
    }

    if (isEligibilityField(field)) {
      const normQ = normalizeQuestionKey(field.label);
      const explicitTextAnswer =
        field.type === "text" || field.type === "textarea"
          ? (profile.question_bank
              ? Object.entries(profile.question_bank).find(([k]) => normalizeQuestionKey(k) === normQ)?.[1]
              : undefined) ?? dossier?.qaPairs[normQ]
          : undefined;
      if (explicitTextAnswer?.trim()) {
        actions.push({
          selector: field.selector, label: field.label || "Work authorization", kind: "value",
          value: explicitTextAnswer.trim(), confidence: 1, why: "explicitly answered in candidate question bank",
        });
      } else {
        actions.push(chooseEligibility(field, profile, dossier));
      }
      continue;
    }

    if (field.type === "file") {
      const isCoverOnly = labelMatches(field.label, "coverLetter") && !labelMatches(field.label, "resume");
      if (isCoverOnly && row.coverLetterPath) {
        actions.push({
          selector: field.selector, label: field.label || "Cover letter upload", kind: "file",
          path: row.coverLetterPath, confidence: 1, why: "cover-letter file upload field",
        });
        continue;
      }
      if ((labelMatches(field.label, "resume") || field.label === "") && !isCoverOnly && row.resumePath) {
        actions.push({
          selector: field.selector, label: field.label || "Resume/CV", kind: "file",
          path: row.resumePath, confidence: 1, why: "resume/CV upload field",
        });
        continue;
      }
      actions.push({
        selector: field.selector, label: field.label || "File upload", kind: "ask",
        question: field.label || "This form asks for an additional file upload.", required: field.required,
        fieldType: field.type, why: "no matching file on hand for this upload field",
      });
      continue;
    }

    const isChoiceType = field.type === "checkbox-group" || field.type === "radio-group" || field.type === "select";
    if (!isChoiceType) {
      const standard = matchStandardTextField(field, profile, row);
      if (standard) {
        actions.push(standard);
        continue;
      }
    }

    const learned = lookupLearnedAnswer(field.label, isChoiceType ? field.options : undefined, profile, dossier);
    if (learned) {
      actions.push(
        learned.kind === "choose"
          ? { selector: field.selector, label: field.label, kind: "choose", fieldType: field.type, option: learned.value, confidence: 0.95, why: learned.source }
          : { selector: field.selector, label: field.label, kind: "value", value: learned.value, confidence: 0.95, why: learned.source },
      );
      continue;
    }

    actions.push({
      selector: field.selector,
      label: field.label || `Unrecognised ${field.type} field`,
      kind: "ask",
      question: field.label || `Unrecognised ${field.type} field`,
      required: field.required,
      fieldType: field.type,
      options: field.options,
      why: "not yet in candidate dossier or question bank",
    });
  }

  return actions;
}

export type UnansweredQuestion = Extract<FormFillAction, { kind: "ask" }>;

export interface FormPlanSummary {
  readonly filled: number;
  readonly total: number;
  readonly filledLabels: readonly string[];
  readonly unanswered: readonly UnansweredQuestion[];
  readonly requiredUnanswered: readonly UnansweredQuestion[];
  readonly hasCaptcha: boolean;
  readonly readyToSubmit: boolean;
}

export function summariseFormPlan(
  actions: readonly FormFillAction[],
  fields: readonly ScrapedField[] = [],
  verifiedSelectors?: ReadonlySet<string>,
): FormPlanSummary {
  const hasCaptcha = fields.some((f) => f.isCaptcha || f.type === "captcha");
  const unanswered: UnansweredQuestion[] = [];
  const filledLabels: string[] = [];

  for (const a of actions) {
    if (a.kind === "ask") {
      unanswered.push(a);
    } else if (!verifiedSelectors || verifiedSelectors.has(a.selector)) {
      filledLabels.push(a.label);
    } else {
      unanswered.push({
        selector: a.selector, label: a.label, kind: "ask", question: a.label,
        required: true, fieldType: a.kind === "choose" ? a.fieldType : a.kind === "file" ? "file" : "text",
        why: "fill attempted on page but did not verify in DOM",
      });
    }
  }

  const requiredUnanswered = unanswered.filter((u) => u.required);
  const optionalUnanswered = unanswered.filter((u) => !u.required);
  const orderedUnanswered = [...requiredUnanswered, ...optionalUnanswered];

  return {
    filled: filledLabels.length,
    total: actions.length,
    filledLabels,
    unanswered: orderedUnanswered,
    requiredUnanswered,
    hasCaptcha,
    readyToSubmit: requiredUnanswered.length === 0 && !hasCaptcha,
  };
}
