/**
 * FounderOS — the fact sheet: one-time answers the form filler trusts
 * ====================================================================
 * The 11-22 audit of 137 unanswered required questions fell into a few categories every form repeats
 * (years per skill, sponsorship, how did you hear, address, EEO, languages, notice, salary, legal name, current
 * job, nationality). The founder fills each once in the Mini App editor. Values live ONLY in the profile's
 * answers (data dir), never in code: the new categories under answers.fact_sheet, the rest in the fields the
 * profile already had (work_authorization, salary_floor_eur_year, ...).
 *
 * A fact-sheet value is the founder's own, so its fills carry `why` "fact sheet (<key>)" and auto-send trusts
 * them (answer-source.ts), even on a sensitive label. A blank category never fills: the field stays an ask.
 *
 * PURE (STANDARDS.md section 2).
 */

import type { ApplyProfile } from "./apply-profile.js";
import { matchChoiceOption, NOTICE_PHRASES, normalizeQuestionKey } from "./candidate-dossier.js";
import type { FormFillAction, ScrapedField } from "./form-brain.js";
import { bucketOption } from "./form-answer-synonyms.js";

type Answers = NonNullable<ApplyProfile["answers"]>;
export const SKILL_PREFIX = "skill_years.";
export const SKILL_KEY = /^skill_years\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** "Are you ..." / "Do you ..." questions want Yes or No, never a place name. */
const YES_NO_START = /^(?:are|do|does|did|have|has|is|can|could|will|would|should)\b/;

export interface FactCategory {
  readonly key: string;
  readonly label: string;
  /** Where the editor shows the value: a fact_sheet key, or an existing answers field (edited under Core answers). */
  readonly home: "fact_sheet" | "answers";
  /** Question wordings (normalised, see normalizeQuestionKey) that ask for this fact. */
  readonly test: RegExp;
  readonly exclude?: RegExp;
  readonly hint?: string;
  readonly filled: (a: Answers) => boolean;
}

const set = (v: unknown): boolean => (typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null);
const fact = (key: string) => (a: Answers): boolean => set(a.fact_sheet?.[key]);
const EXPERIENCE = /\b(?:experience|years?|yrs|ervaring)\b/;

/** Order matters: the first category whose test matches wins (skills before the total, yes/no experience before both). */
export const FACT_CATEGORIES: readonly FactCategory[] = [
  {
    key: "skill_years", label: "Years per skill", home: "fact_sheet", hint: "Add each skill forms ask about, with whole years. 0 answers No to yes/no questions.",
    test: /^(?:do|have|did|are) you .*\b(?:experience|worked|familiar|proficient)\b|\bexperience (?:with|in|using|as|on)\b|\b(?:years?|yrs)\b.*\b(?:with|using)\b/,
    exclude: /\b(?:in total|total|overall)\b/,
    filled: (a) => Object.keys(a.fact_sheet ?? {}).some((k) => k.startsWith(SKILL_PREFIX)),
  },
  {
    key: "experience_years", label: "Total years of experience", home: "answers",
    test: /\byears? of (?:\w+ )?experience\b|\bhow many years\b|\byears experience\b|\btotal experience\b|\bjaren ervaring\b/,
    filled: (a) => a.years_experience !== undefined,
  },
  {
    key: "work_authorization", label: "Right to work and sponsorship", home: "answers",
    test: /\bsponsor|\bvisa\b|\bwork (?:authori[sz]ation|permit)\b|\bright to work\b|\bauthori[sz]ed to work\b|\blegally (?:eligible|authori[sz]ed)\b|werkvergunning/,
    filled: (a) => a.work_authorization !== undefined && a.work_authorization !== "unknown",
  },
  { key: "referral_source", label: "How did you hear about us", home: "answers", test: /\b(?:how|where) did you (?:hear|find|learn)\b|\bhow you heard\b|\breferral source\b|\bhoe heb je ons gevonden\b/, exclude: /\bopen source\b/, filled: (a) => set(a.referral_source) },
  { key: "salary", label: "Salary expectation", home: "answers", test: /\b(?:salary|salaris|compensation|remuneration|pay expectation|expected pay|ctc)\b/, exclude: /\b(?:current|last|previous|present)\b/, filled: (a) => a.salary_floor_eur_year !== undefined },
  { key: "notice", label: "Notice period", home: "answers", test: new RegExp(`(?:^| )(?:${NOTICE_PHRASES.join("|")})`), filled: (a) => a.notice_period_days !== undefined || set(a.notice_period_detail) },
  { key: "current_title", label: "Current job title", home: "answers", test: /\b(?:current|present|most recent|huidige) (?:job )?(?:title|role|functie|position)\b|\bjob title\b/, filled: (a) => set(a.current_title) },
  { key: "current_company", label: "Current employer", home: "answers", test: /\b(?:current|present|most recent|huidige) (?:company|employer|werkgever)\b/, filled: (a) => set(a.current_company) },
  {
    key: "eeo", label: "EEO and self-identification", home: "answers",
    test: /\b(?:gender|ethnic\w*|race|veteran|disabilit\w*|hispanic|latino|sexual orientation|lgbt\w*|pronouns?)\b/,
    filled: (a) => Object.values(a.self_identification ?? {}).some(set),
  },
  { key: "legal_name", label: "Legal name (as on ID)", home: "fact_sheet", test: /\b(?:full )?legal name\b|\bname (?:as|exactly as) (?:it )?(?:appears|shown|written)\b|\bname on (?:your )?(?:passport|id)\b/, filled: fact("legal_name") },
  { key: "nationality", label: "Nationality", home: "fact_sheet", test: /\b(?:nationality|nationaliteit|citizenship|country of citizenship)\b/, exclude: /\bwork\b/, filled: fact("nationality") },
  { key: "languages", label: "Languages spoken", home: "fact_sheet", test: /^languages?\b|\blanguages? (?:you speak|spoken|proficiency|skills?)\b|\bspoken languages?\b|\bwhich languages\b|\bwelke talen\b/, filled: fact("languages") },
  { key: "address_line", label: "Street address", home: "fact_sheet", test: /^(?:home |street |mailing |current |residential )?address(?: line)?(?: 1| one)?$|\bstreet address\b|\baddress line\b|\bstraat\b|\bhome address\b/, exclude: /\b(?:e ?mail|ip|web|website|url|linkedin)\b/, filled: fact("address_line") },
  { key: "address_state", label: "State or province", home: "fact_sheet", test: /\b(?:state|province|provincie|region)\b/, exclude: /\b(?:united states|statement|state (?:of|that|why|your)|real estate|estate)\b/, filled: fact("address_state") },
  { key: "postal_code", label: "Postal code", home: "fact_sheet", test: /\b(?:postal code|post code|postcode|zip ?code|zip|postcode)\b/, filled: fact("postal_code") },
];

/** Keys of the fixed fact_sheet categories the editor offers as plain fields. */
export const FACT_FIELD_KEYS: readonly string[] = FACT_CATEGORIES.filter((c) => c.home === "fact_sheet" && c.key !== "skill_years").map((c) => c.key);

/** The category a question asks for, or null. Pure wording check; it says nothing about whether a value is stored. */
export function factCategoryOf(question: string): FactCategory | null {
  const n = normalizeQuestionKey(question);
  if (!n) return null;
  return FACT_CATEGORIES.find((c) => c.test.test(n) && !(c.exclude?.test(n) ?? false)) ?? null;
}

/** One row per category for the editor: the marker is just "is a value stored". Values are not returned here. */
export function factSheetStatus(profile: Pick<ApplyProfile, "answers">): ReadonlyArray<{ readonly key: string; readonly label: string; readonly home: string; readonly filled: boolean; readonly hint?: string }> {
  const a = profile.answers ?? {};
  return FACT_CATEGORIES.map((c) => ({ key: c.key, label: c.label, home: c.home, filled: c.filled(a), ...(c.hint ? { hint: c.hint } : {}) }));
}

/** The skills stored with their years, as [name, years text]. */
export function skillYears(a: Answers | undefined): ReadonlyArray<readonly [string, string]> {
  return Object.entries(a?.fact_sheet ?? {})
    .filter(([k, v]) => k.startsWith(SKILL_PREFIX) && v.trim() !== "")
    .map(([k, v]) => [k.slice(SKILL_PREFIX.length).replace(/-/g, " "), v.trim()] as const);
}

const valueFill = (f: ScrapedField, value: string, key: string): FormFillAction =>
  ({ selector: f.selector, label: f.label, kind: "value", value, confidence: 1, why: `fact sheet (${key})` });
const chooseFill = (f: ScrapedField, option: string, key: string): FormFillAction =>
  ({ selector: f.selector, label: f.label, kind: "choose", fieldType: f.type, option, confidence: 0.95, why: `fact sheet (${key})` });

/** Fill from a stored text value: a closed list needs one clear option, a number input needs a number. */
function fillText(f: ScrapedField, value: string, key: string): FormFillAction | null {
  if (f.options && f.options.length > 0) {
    const pick = matchChoiceOption(value, f.options);
    return pick ? chooseFill(f, pick, key) : null;
  }
  if (f.type === "number" && !/^-?\d+(?:\.\d+)?$/.test(value)) return null;
  return valueFill(f, value, key);
}

/** The one stored skill this question names, with its years; null when none or several are named. */
function skillFor(n: string, a: Answers | undefined): { readonly skill: string; readonly years: number; readonly key: string } | null {
  const hits = skillYears(a).filter(([skill]) => ` ${n} `.includes(` ${skill} `) && /^\d+(?:\.\d+)?$/.test(a?.fact_sheet?.[SKILL_PREFIX + skill.replace(/ /g, "-")] ?? ""));
  if (hits.length !== 1) return null;
  const [skill, years] = hits[0]!;
  return { skill, years: Number(years), key: SKILL_PREFIX + skill.replace(/ /g, "-") };
}

function skillAction(f: ScrapedField, n: string, a: Answers | undefined): FormFillAction | null {
  if (!EXPERIENCE.test(n)) return null;
  const hit = skillFor(n, a);
  if (!hit) return null;
  const yesNo = hit.years > 0 ? "Yes" : "No";
  if (f.options && f.options.length > 0) {
    const yn = matchChoiceOption(yesNo, f.options);
    const asksYesNo = YES_NO_START.test(n);
    const pick = asksYesNo && yn ? yn : bucketOption(hit.years, f.options) ?? (yn && f.options.length <= 3 ? yn : null);
    return pick ? chooseFill(f, pick, hit.key) : null;
  }
  const value = YES_NO_START.test(n) && !/\bhow (?:many|long)\b/.test(n) ? yesNo : String(hit.years);
  return f.type === "number" && value === yesNo ? null : valueFill(f, value, hit.key);
}

/**
 * The fill the fact sheet gives this field, or null when no category matches or its value is blank (the form
 * brain then goes on exactly as before). Only the new fact_sheet categories and skill years fill here: the
 * categories that live in existing answers fields keep their own rules (work authorisation, notice, salary,
 * referral source, current job, EEO), which already answer from the same editor values.
 */
export function factSheetAction(field: ScrapedField, profile: ApplyProfile): FormFillAction | null {
  const n = normalizeQuestionKey(field.label);
  if (!n || field.type === "file" || field.type === "captcha") return null;
  const a = profile.answers;
  const skill = skillAction(field, n, a);
  if (skill) return skill;
  const cat = factCategoryOf(field.label);
  if (!cat || cat.home !== "fact_sheet" || cat.key === "skill_years") return null;
  if (YES_NO_START.test(n) && !(field.options && field.options.length > 0)) return null;
  const value = a?.fact_sheet?.[cat.key]?.trim();
  return value ? fillText(field, value, cat.key) : null;
}
