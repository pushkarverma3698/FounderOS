/**
 * The one-sitting answer bank: which unanswered form questions block the most roles. Pure.
 * Sources are the questions shadow apply could not fill (the lane reason and the prepared-form snapshot).
 * Near-duplicates cluster on the normalised key with company names stripped. A question the profile or dossier
 * already answers is dropped. A question naming its own company is a template, shown once and never saved
 * globally (company-answer.ts rule). Eligibility, visa and self-identification keep their closed-set flows and
 * are listed apart as "answer in /profile".
 */

import { normalizeQuestionKey } from "./candidate-dossier.js";
import { namesCompany } from "./company-answer.js";
import { isEligibilityField } from "./form-brain.js";
import { selfIdCategoryOf } from "./self-identification.js";

export interface QuestionSource {
  readonly rowId: string;
  readonly company: string;
  readonly label: string;
  readonly fieldType?: string;
  readonly options?: readonly string[];
}

export interface OpenQuestion {
  /** Most common wording in the cluster, with the company shown as [company] on templates. */
  readonly label: string;
  readonly key: string;
  /** How many distinct roles this question blocks. */
  readonly roles: number;
  /** True when the question names its company: answered per form, never saved globally. */
  readonly template: boolean;
}

export interface OpenQuestions {
  readonly questions: readonly OpenQuestion[];
  /** Eligibility, visa and self-identification: answered in /profile, never as free text. */
  readonly profileFields: readonly OpenQuestion[];
  /** Distinct roles blocked by any listed question. */
  readonly blockedRoles: number;
}

export const COMPANY_PLACEHOLDER = "[company]";
const MAX_LABEL_CHARS = 300;
const CLOSED_SET = new Set(["file", "checkbox", "captcha"]);
const LETTER = /cover letter|motivation|motivatie|sollicitatiebrief/i;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `label` with every occurrence of `company` replaced by the placeholder (case-insensitive). */
function maskCompany(label: string, company: string): string {
  return company.trim().length === 0 ? label : label.replace(new RegExp(escapeRe(company.trim()), "gi"), COMPANY_PLACEHOLDER);
}

function isProfileField(s: QuestionSource): boolean {
  const field = { selector: "", type: "text" as const, label: s.label, required: true, ...(s.options ? { options: s.options } : {}) };
  return selfIdCategoryOf(s.label) !== null || isEligibilityField(field);
}

interface Cluster {
  readonly key: string;
  readonly rows: Set<string>;
  readonly wordings: Map<string, number>;
  readonly template: boolean;
}

function top(wordings: ReadonlyMap<string, number>): string {
  let best = "";
  let n = 0;
  for (const [w, c] of wordings) if (c > n || (c === n && w < best)) [best, n] = [w, c];
  return best;
}

function rank(clusters: Iterable<Cluster>): OpenQuestion[] {
  return [...clusters]
    .map((c) => ({ label: top(c.wordings), key: c.key, roles: c.rows.size, template: c.template }))
    .sort((a, b) => b.roles - a.roles || Number(a.template) - Number(b.template) || a.label.localeCompare(b.label));
}

/** `isAnswered(label, options)`: true when the profile or dossier already holds an answer (lookupLearnedAnswer). */
export function collectOpenQuestions(
  sources: readonly QuestionSource[],
  isAnswered: (label: string, options: readonly string[] | undefined) => boolean,
): OpenQuestions {
  const free = new Map<string, Cluster>();
  const fixed = new Map<string, Cluster>();
  for (const s of sources) {
    const label = s.label.trim().slice(0, MAX_LABEL_CHARS);
    if (!label || LETTER.test(label) || CLOSED_SET.has(s.fieldType ?? "")) continue;
    const template = namesCompany(label, s.company);
    const shown = template ? maskCompany(label, s.company) : label;
    const key = normalizeQuestionKey(shown);
    if (!key) continue;
    const profileField = isProfileField(s);
    if (!template && !profileField && isAnswered(label, s.options)) continue;
    const into = profileField ? fixed : free;
    const id = `${template ? "t:" : ""}${key}`;
    const c = into.get(id) ?? { key, rows: new Set<string>(), wordings: new Map<string, number>(), template };
    c.rows.add(s.rowId);
    c.wordings.set(shown, (c.wordings.get(shown) ?? 0) + 1);
    into.set(id, c);
  }
  const questions = rank(free.values());
  const profileFields = rank(fixed.values());
  const blocked = new Set<string>();
  for (const c of free.values()) for (const r of c.rows) blocked.add(r);
  return { questions, profileFields, blockedRoles: blocked.size };
}

/** "N questions block M roles" (singular forms handled). */
export function summaryLine(q: OpenQuestions): string {
  const n = q.questions.length;
  return `${n} ${n === 1 ? "question blocks" : "questions block"} ${q.blockedRoles} ${q.blockedRoles === 1 ? "role" : "roles"}`;
}
