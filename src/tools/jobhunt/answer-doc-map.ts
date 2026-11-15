/**
 * FounderOS — where each answer in the question document goes
 * ===========================================================
 * Structured fields where the apply profile has a key (name, email, phone, city, notice period, ...), and
 * everything else as dossier Q&A pairs that the form-brain learned-answer lookup finds by question text.
 *
 * Right-to-work, visa and self-identification answers go ONLY to their closed-set fields, and only from a plain
 * yes/no (or her own words, for the voluntary diversity questions), copied as written. No model reads or rewrites
 * them, and a loose answer such as "yes, on a dependent permit" is held for her to settle instead of being turned
 * into a choice. "skip" and blank write nothing: skip means ask on every form, blank means unknown.
 *
 * PURE (`STANDARDS.md` §2).
 */

import { ANSWER_DOC_QUESTIONS, type AnswerTarget } from "./answer-doc-questions.js";
import type { ParsedAnswer } from "./answer-doc-parse.js";

export type TopField = "first_name" | "last_name" | "email" | "phone" | "linkedin";
export type AnswerField =
  | "location_city" | "location_country" | "work_authorization" | "work_authorization_detail"
  | "salary_floor_eur_year" | "salary_floor_basis" | "years_experience" | "notice_period_days"
  | "notice_period_detail" | "willing_to_relocate" | "current_company" | "current_title"
  | "highest_degree" | "referral_source";
export type SelfIdCategory = "gender" | "disability" | "race";

/** One thing the import will write. `value: null` on an answers field removes a stale value that would outrank the new one. */
export type FieldWrite =
  | { readonly kind: "top"; readonly field: TopField; readonly value: string; readonly number: number; readonly label: string }
  | { readonly kind: "answer"; readonly field: AnswerField; readonly value: string | number | boolean | null; readonly number: number; readonly label: string }
  | { readonly kind: "selfid"; readonly category: SelfIdCategory; readonly value: string; readonly number: number; readonly label: string }
  | { readonly kind: "qa"; readonly question: string; readonly value: string; readonly number: number; readonly label: string };

export interface HeldAnswer {
  readonly number: number;
  readonly label: string;
  readonly reason: string;
}

export interface AnswerPatch {
  readonly writes: readonly FieldWrite[];
  /** Nothing written for these: skipped (ask each form), blank (unknown) or not usable as written. */
  readonly held: readonly HeldAnswer[];
}

const YES_NO = /^(yes|y|no|n)[.!]?$/i;
const yesNo = (s: string): boolean | null => (YES_NO.test(s.trim()) ? /^y/i.test(s.trim()) : null);

/** "65,000", "65.000", "65k", "5.500 per month" to a yearly euro figure, or null when it is not clearly one. */
export function parseYearlyEuro(text: string): number | null {
  const t = text.toLowerCase();
  if (/(?:inr|₹|\brs\b|rupee|usd|\$|£|gbp|chf)/.test(t)) return null;
  const nums = [...t.matchAll(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k)?/g)];
  if (nums.length !== 1) return null;
  const raw = nums[0]![1]!;
  const grouped = /^\d{1,3}([.,]\d{3})+$/.test(raw);
  let value = Number(grouped ? raw.replace(/[.,]/g, "") : raw.replace(",", "."));
  if (nums[0]![2]) value *= 1000;
  if (!Number.isFinite(value) || value <= 0) return null;
  if (/per month|\/\s*month|monthly|a month|p\.?m\b/.test(t)) return Math.round(value * 12);
  if (/year|yr|annum|annual|p\.?a\b/.test(t) || value >= 20000) return Math.round(value);
  return null;
}

const parseYears = (s: string): number | null => {
  const m = /^(\d+(?:[.,]\d+)?)\s*\+?\s*(?:years?|yrs?|y)?\.?$/i.exec(s.trim());
  return m ? Number(m[1]!.replace(",", ".")) : null;
};

function parseNoticeDays(s: string): number | null {
  const t = s.trim();
  if (/^(?:immediate(?:ly)?|none|no notice|nil)\.?$/i.test(t)) return 0;
  const m = /^(\d+)\s*(?:days?|d)?\.?$/i.exec(t);
  return m ? Number(m[1]) : null;
}

export function mapAnswersToProfile(parsed: readonly ParsedAnswer[]): AnswerPatch {
  const writes: FieldWrite[] = [];
  const held: HeldAnswer[] = [];
  const text = new Map<number, string>();

  for (const p of parsed) {
    const doc = p.recognised ? ANSWER_DOC_QUESTIONS.find((d) => d.n === p.number) : undefined;
    const label = doc?.key ?? p.question;
    if (p.answer === "skip") { held.push({ number: p.number, label, reason: "skipped: asked on each form" }); continue; }
    if (p.answer === null) { if (doc) held.push({ number: p.number, label, reason: "blank: unknown" }); continue; }
    if (doc) text.set(doc.n, p.answer);
    const target: AnswerTarget = doc?.target ?? "qa";
    const n = p.number;
    const top = (field: TopField, value: string): void => void writes.push({ kind: "top", field, value, number: n, label });
    const ans = (field: AnswerField, value: string | number | boolean | null, lbl = label): void => void writes.push({ kind: "answer", field, value, number: n, label: lbl });
    const qa = (): void => void writes.push({ kind: "qa", question: label, value: p.answer as string, number: n, label });
    const hold = (reason: string): void => void held.push({ number: n, label, reason });
    const a = p.answer;

    switch (target) {
      case "name": {
        const parts = a.split(/\s+/);
        if (parts.length < 2) { hold("needs first and last name"); break; }
        top("first_name", parts[0]!);
        top("last_name", parts.slice(1).join(" "));
        break;
      }
      case "email": /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) ? top("email", a) : hold("not an email address"); break;
      case "phone": /^\+?[\d\s().-]{7,}$/.test(a) ? top("phone", a) : hold("not a phone number"); break;
      case "linkedin": /linkedin\./i.test(a) ? top("linkedin", a) : hold("not a LinkedIn link"); break;
      case "location": {
        const parts = a.split(",").map((s) => s.trim()).filter(Boolean);
        if (parts.length < 2) { hold("write it as city, country"); qa(); break; }
        ans("location_city", parts[0]!, "City");
        ans("location_country", parts[parts.length - 1]!, "Country");
        break;
      }
      case "nl-allowed": case "nl-sponsor": case "in-allowed":
        if (yesNo(a) === null) hold("not a plain yes or no: set it yourself with /profile");
        break; // folded into work_authorization / detail after the loop
      case "nl-permit": break;
      case "notice": {
        const days = parseNoticeDays(a);
        ans("notice_period_days", days, "Notice period (days)");
        ans("notice_period_detail", days === null ? a : null, "Notice period (detail)");
        break;
      }
      case "relocate": {
        const yn = yesNo(a);
        if (yn !== null) ans("willing_to_relocate", yn, "Willing to relocate");
        else qa();
        break;
      }
      case "salary-nl": {
        const yearly = parseYearlyEuro(a);
        if (yearly === null) { hold("not clearly euros per year: kept as Q&A"); qa(); break; }
        ans("salary_floor_eur_year", yearly, "Salary expectation (EUR/year)");
        ans("salary_floor_basis", "Netherlands expectation, gross per year", "Salary basis");
        break;
      }
      case "years-total": {
        const years = parseYears(a);
        years === null ? (hold("not a plain number: kept as Q&A"), qa()) : ans("years_experience", years, "Years of experience");
        break;
      }
      case "title-employer": {
        const m = /^(.+?)\s+(?:at|@)\s+(.+)$/i.exec(a);
        if (m) { ans("current_title", m[1]!.trim(), "Current title"); ans("current_company", m[2]!.trim(), "Current company"); }
        else qa();
        break;
      }
      case "degree": ans("highest_degree", a, "Highest degree"); break;
      case "referral": ans("referral_source", a, "Referral source"); qa(); break;
      case "self-gender": writes.push({ kind: "selfid", category: "gender", value: a, number: n, label }); break;
      case "self-disability": writes.push({ kind: "selfid", category: "disability", value: a, number: n, label }); break;
      case "self-race": writes.push({ kind: "selfid", category: "race", value: a, number: n, label }); break;
      case "qa": qa(); break;
    }
  }

  const allowed = text.has(8) ? yesNo(text.get(8)!) : null;
  const sponsor = text.has(9) ? yesNo(text.get(9)!) : null;
  const pair = ANSWER_DOC_QUESTIONS.find((d) => d.n === 9)!;
  if (sponsor === true) writes.push({ kind: "answer", field: "work_authorization", value: "requires-sponsorship", number: 9, label: "Right to work" });
  else if (sponsor === false && allowed === true) writes.push({ kind: "answer", field: "work_authorization", value: "authorized-no-sponsorship", number: 9, label: "Right to work" });
  else if (allowed !== null || sponsor !== null) held.push({ number: 9, label: pair.key, reason: "right to work needs a clear yes from Q8 and a no from Q9, or a yes to Q9; left unchanged" });

  const permit = text.get(10);
  const india = text.has(11) ? yesNo(text.get(11)!) : null;
  const detail = [permit ? `Netherlands permit: ${permit}` : "", india === null ? "" : `India right to work: ${india ? "yes" : "no"}`].filter(Boolean).join("; ");
  if (detail) writes.push({ kind: "answer", field: "work_authorization_detail", value: detail, number: 10, label: "Right to work (detail, shown to you only)" });

  return { writes, held };
}
