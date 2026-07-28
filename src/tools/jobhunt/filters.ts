/**
 * Application screening filters
 * =============================
 * Pure, deterministic gates applied before any model spend or human attention.
 *
 * The salary gate encodes a LEGAL constraint, not a preference: under the
 * under-30 highly skilled migrant band an employer cannot lawfully make the hire
 * below the criterion, so an application below it is not a long shot — it is void.
 *
 * The important subtlety is what happens when salary is NOT stated, which is the
 * majority of Dutch postings. Rejecting those would discard most of the reachable
 * market, so absent salary is a FLAG for human verification, never a rejection.
 */

import { normaliseCompanyName } from "./sponsor-match.js";

/**
 * €4,357/month gross excluding the 8% holiday allowance, verified at ind.nl for
 * calendar 2026. Applies to applicants under 30 — Pushkar turns 30 on 2028-06-03,
 * after which the criterion rises to €5,942/month (+36%).
 */
export const HSM_UNDER_30_MONTHLY_EUR = 4357;
export const HSM_UNDER_30_ANNUAL_BASE_EUR = HSM_UNDER_30_MONTHLY_EUR * 12;

/**
 * Below this, a figure is almost certainly a MONTHLY salary mislabelled as annual.
 * Treated as needing human confirmation rather than rejected, since misreading a
 * monthly figure as annual would reject a perfectly good role.
 */
const IMPLAUSIBLE_ANNUAL_CEILING_EUR = 15_000;

/** Days before a re-posted role may be applied to again. */
const REAPPLY_COOLDOWN_DAYS = 90;

export type ScreenStatus = "pass" | "flag" | "reject";

export interface ScreenResult {
  readonly status: ScreenStatus;
  readonly evidence: string;
}

export interface SalaryRange {
  /** Annual base salary in EUR, excluding holiday allowance. */
  readonly min?: number;
  readonly max?: number;
}

/**
 * Screen an advertised salary against the permit criterion.
 * The ceiling of the range is what matters — a range straddling the floor is
 * negotiable upward and stays in play.
 */
export function screenSalary(range: SalaryRange): ScreenResult {
  const { min, max } = range;
  const stated = max ?? min;

  if (stated === undefined) {
    return {
      status: "flag",
      evidence:
        "No salary stated — normal for Dutch postings. Confirm the employer can meet " +
        `€${HSM_UNDER_30_ANNUAL_BASE_EUR} base before investing in an application.`,
    };
  }

  if (stated < IMPLAUSIBLE_ANNUAL_CEILING_EUR) {
    return {
      status: "flag",
      evidence:
        `Stated figure (${stated}) looks like a MONTHLY salary, not annual. ` +
        `Verify the unit before screening — €${HSM_UNDER_30_MONTHLY_EUR}/month would qualify.`,
    };
  }

  if (stated < HSM_UNDER_30_ANNUAL_BASE_EUR) {
    return {
      status: "reject",
      evidence:
        `Ceiling €${stated} is below the €${HSM_UNDER_30_ANNUAL_BASE_EUR} annual base ` +
        `required by the under-30 highly skilled migrant criterion. The employer cannot ` +
        `lawfully make this hire, so applying is void.`,
    };
  }

  return {
    status: "pass",
    evidence: `Ceiling €${stated} clears the €${HSM_UNDER_30_ANNUAL_BASE_EUR} annual base.`,
  };
}

/** Softeners that turn a Dutch mention into a preference rather than a bar. */
const languageSoftener = /\b(nice to have|a plus|preferred|advantage|bonus|desirable|helpful)\b/i;
const languageHardRequirement = /\b(required|fluent|fluency|native|mandatory|must have|must be)\b/i;
const dutchMention = /\b(dutch|nederlands|nederlandse)\b/i;

/** Reject postings that genuinely require Dutch; keep the ones where it is a plus. */
export function screenLanguage(text: string): ScreenResult {
  if (!dutchMention.test(text)) {
    return { status: "pass", evidence: "No Dutch-language requirement mentioned." };
  }
  if (languageSoftener.test(text)) {
    return { status: "pass", evidence: "Dutch mentioned as a preference, not a requirement." };
  }
  if (languageHardRequirement.test(text)) {
    return {
      status: "reject",
      evidence: "Posting requires Dutch fluency — not attainable within the hiring window.",
    };
  }
  return { status: "pass", evidence: "Dutch mentioned without an explicit fluency requirement." };
}

/** Stable identity for a role, so the machine never applies to the same posting twice. */
export function dedupeKey(company: string, title: string): string {
  const role = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return `${normaliseCompanyName(company)}::${role}`;
}

/**
 * Whether enough time has passed to apply again to a genuinely re-posted role.
 * A never-applied role is always applicable.
 */
export function isStaleEnoughToReapply(lastAppliedAt: Date | null, now: Date): boolean {
  if (lastAppliedAt === null) return true;
  const days = (now.getTime() - lastAppliedAt.getTime()) / 86_400_000;
  return days >= REAPPLY_COOLDOWN_DAYS;
}
