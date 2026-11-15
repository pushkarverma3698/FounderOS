/**
 * FounderOS — stored answers the form labels do not name literally
 * ================================================================
 * "How soon can you join (In days) ?" asks for apply-profile.json answers.notice_period_days, and "Years of
 * experience" with a closed list asks for the bucket that holds answers.years_experience. Nothing here invents a
 * value: when nothing usable is stored the field stays an ask. Eligibility, visa and self-identification never come
 * through here (form-brain handles them first).
 *
 * PURE (STANDARDS.md section 2).
 */

import type { ApplyProfile } from "./apply-profile.js";
import { NOTICE_PHRASES, normalizeQuestionKey } from "./candidate-dossier.js";
import type { FormFillAction, ScrapedField } from "./form-brain.js";

const hasPhrase = (key: string, phrase: string): boolean => ` ${key}`.includes(` ${phrase}`);

export const isNoticeQuestion = (label: string): boolean => {
  const key = normalizeQuestionKey(label);
  return NOTICE_PHRASES.some((p) => hasPhrase(key, p));
};

const valueAction = (f: ScrapedField, value: string, why: string): FormFillAction =>
  ({ selector: f.selector, label: f.label, kind: "value", value, confidence: 1, why });

const askAction = (f: ScrapedField, why: string): FormFillAction => ({
  selector: f.selector, label: f.label, kind: "ask", question: f.label, required: f.required,
  fieldType: f.type, options: f.options, why,
});

/** Inclusive [low, high] a bucket option such as "3-5 years", "10+", "Less than 1 year" or "30 days" covers. */
export function optionRange(option: string, unitDays = false): readonly [number, number] | null {
  const o = option.toLowerCase().replace(/[–—]/g, "-");
  if (/\b(?:immediate|asap)/.test(o)) return [0, 0];
  const n = (re: RegExp): number | null => {
    const m = re.exec(o);
    return m ? Number(m[1]) : null;
  };
  const scale = unitDays ? (/week/.test(o) ? 7 : /month/.test(o) ? 30 : 1) : 1;
  const span = /(\d+)\s*(?:-|to)\s*(\d+)/.exec(o);
  const less = n(/(?:less than|under|below|fewer than)\s*(\d+)/);
  const upTo = n(/(?:up to|max(?:imum)?)\s*(\d+)/);
  const more = n(/(?:more than|over|above|greater than)\s*(\d+)/);
  const atLeast = n(/(?:at least\s*)?(\d+)\s*(?:\+|or more|and above|or above|plus)/) ?? n(/at least\s*(\d+)/);
  const exact = n(/^\D*(\d+)\D*$/);
  const range: readonly [number, number] | null = span ? [Number(span[1]) * scale, Number(span[2]) * scale]
    : less !== null ? [0, (less - 1) * scale]
    : upTo !== null ? [0, upTo * scale]
    : more !== null ? [(more + 1) * scale, Infinity]
    : atLeast !== null ? [atLeast * scale, Infinity]
    : exact !== null ? [exact * scale, exact * scale]
    : null;
  return range;
}

/** The single option whose range holds `n` (whole units), or null when none or several do. */
export function bucketOption(n: number, options: readonly string[], unitDays = false): string | null {
  const whole = Math.floor(n);
  const hits = options.filter((o) => {
    const r = optionRange(o, unitDays);
    return r !== null && whole >= r[0] && whole <= r[1];
  });
  return hits.length === 1 ? hits[0]! : null;
}

const wantsDays = (f: ScrapedField): boolean =>
  f.type === "number" || /\bdays\b/.test(normalizeQuestionKey(f.label));

/** Days for a days field. Detail words that give no number ("One month after offer") veto the count: the dossier's own wording wins. */
const daysFrom = (a: NonNullable<ApplyProfile["answers"]>): string | undefined => {
  const detail = a.notice_period_detail ?? "";
  const fromDetail = /^\s*(\d+)/.exec(detail)?.[1] ?? (/immediate|asap/i.test(detail) ? "0" : undefined);
  if (detail.trim() && fromDetail === undefined) return undefined;
  return a.notice_period_days === undefined ? fromDetail : String(a.notice_period_days);
};

/** Notice-period answer for a start-date question, or null when the label is something else. */
export function noticePeriodAction(field: ScrapedField, profile: ApplyProfile): FormFillAction | null {
  if (!isNoticeQuestion(field.label)) return null;
  const a = profile.answers ?? {};
  const days = daysFrom(a);
  const why = "profile notice period";
  if (field.options && field.options.length > 0) {
    const pick = days === undefined ? null : bucketOption(Number(days), field.options, true);
    return pick
      ? { selector: field.selector, label: field.label, kind: "choose", fieldType: field.type, option: pick, confidence: 0.95, why }
      : null;
  }
  if (wantsDays(field)) {
    return days === undefined ? askAction(field, "field asks for days and no notice_period_days is stored") : valueAction(field, days, why);
  }
  const detail = a.notice_period_detail?.trim();
  const text = detail || (a.notice_period_days === undefined ? undefined : a.notice_period_days === 0 ? "Immediately" : `${a.notice_period_days} days`);
  return text ? valueAction(field, text, why) : null;
}

/** "Years of experience" skills questions ("with Python") are about one skill, not the total, so they stay asks. */
const SKILL_SCOPED = /\b(?:with|using|experience (?:in|as|on))\b/;

/** Years-of-experience bucket for a closed list, or null. */
export function experienceBucketAction(field: ScrapedField, profile: ApplyProfile, isYearsLabel: boolean): FormFillAction | null {
  const years = profile.answers?.years_experience;
  const key = normalizeQuestionKey(field.label);
  if (!isYearsLabel || years === undefined || !field.options?.length || SKILL_SCOPED.test(key)) return null;
  const pick = bucketOption(years, field.options);
  return pick
    ? { selector: field.selector, label: field.label, kind: "choose", fieldType: field.type, option: pick, confidence: 0.95, why: "profile years of experience" }
    : null;
}
