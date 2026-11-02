/**
 * An answer that names the company it was typed for is not a reusable answer.
 * "Mollie's Career Site" under "How did you hear about us?" is right for Mollie's form and wrong for every
 * other one, so it is used for this form only and never written to the question bank. Pure.
 */

import type { ApplyProfile } from "./apply-profile.js";
import { normalizeQuestionKey } from "./candidate-dossier.js";

const MIN_COMPANY_CHARS = 3;

/** True when `answer` contains the company's name (case-insensitive). Names under 3 characters never match. */
export function namesCompany(answer: string, company: string): boolean {
  const name = company.trim().toLowerCase();
  return name.length >= MIN_COMPANY_CHARS && answer.toLowerCase().includes(name);
}

/**
 * The profile for one prepare run, with the answers that name `company` laid over its question bank. They are
 * not on disk (see above), so without this the re-fill would ask the same question again. Same-question
 * entries already in the bank are dropped so the overlay is the one the lookup finds.
 */
export function withFormOnlyAnswers(
  profile: ApplyProfile,
  answered: ReadonlyArray<{ readonly label: string; readonly answer: string }>,
  company: string,
): ApplyProfile {
  const formOnly = answered.filter((a) => namesCompany(a.answer, company));
  if (formOnly.length === 0) return profile;
  const taken = new Set(formOnly.map((a) => normalizeQuestionKey(a.label)));
  const bank = Object.fromEntries(Object.entries(profile.question_bank ?? {}).filter(([k]) => !taken.has(normalizeQuestionKey(k))));
  for (const a of formOnly) bank[a.label] = a.answer;
  return { ...profile, question_bank: bank };
}
