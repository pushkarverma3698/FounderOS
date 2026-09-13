/**
 * FounderOS — early-career title exclusion
 * ========================================
 * Drop internships, graduate schemes and working-student roles at the source.
 *
 * WHY THIS EXISTS (prod evidence, 2026-08-01). The entire live job table was
 * eight rows, and this is what the day's budget had been spent on:
 *
 *   IMC — Software Engineer Intern
 *   IMC — Graduate Software Engineer (2027)
 *   Deloitte Netherlands — Junior Data Engineer
 *   BUX — Junior Data Engineer
 *
 * The mechanism is that the feed's `titleSearch` is a SUBSTRING match, not the
 * prefix match the `:*` suffix suggests. So the deliberately broad phrase
 * "Software Engineer:*" also matches "Graduate Software Engineer (2027)" and
 * "Software Engineer Intern". A generic phrase acts as a vacuum, and with a
 * bounded daily budget those rows crowd out the specific AI and React roles the
 * campaign is actually for.
 *
 * Deliberately NOT done by dropping the "0-2" experience band: that band also
 * carries genuine two-year roles at strong employers, and Pushkar has three
 * years of production experience. The exclusion is on the TITLE, where the
 * signal is unambiguous, rather than on an inferred seniority number.
 *
 * Every drop is COUNTED and surfaced. A silent filter and a quiet market look
 * identical from the outside, and the pipeline has already been wrong in exactly
 * that direction once.
 */

/**
 * Whole-word markers of a role that is not open to a mid-level hire.
 *
 * Word-boundary matched, never substring: "internal" must not read as "intern",
 * and "Traineeship Coordinator" is a real job whereas "Trainee Engineer" is not
 * one he would take. `stage`/`stagiair` are the Dutch words for an internship
 * and appear untranslated in Dutch postings.
 */
const EARLY_CAREER_TERMS: readonly string[] = [
  "intern",
  "internship",
  "interns",
  "trainee",
  "traineeship",
  "apprentice",
  "apprenticeship",
  "graduate",
  "grad",
  "student",
  "werkstudent",
  "stagiair",
  "stagiaire",
  "stage",
  "starter",
  "placement",
  "praktikant",
  "praktikum",
  "werkstudentin",
];

const EARLY_CAREER_RE = new RegExp(`\\b(?:${EARLY_CAREER_TERMS.join("|")})\\b`, "i");

/**
 * The subset safe to send to the FEED as `titleExclusionSearch`.
 *
 * WHY A SUBSET AND NOT THE WHOLE LIST. The feed matches an exclusion term the
 * same way it matches a search term — as a SUBSTRING, with no word boundary. So
 * excluding "intern" at source would also discard "Internal Tools Engineer" and
 * every "International" role, and the loss would be invisible: an excluded
 * posting is never returned, never counted, and never appears in the drop
 * tally. That is precisely the silent-failure direction this pipeline exists to
 * avoid, and it would be worse than the problem it solves.
 *
 * So the split is by evidence, not by convenience. A term goes here only if no
 * ordinary engineering title contains it as a substring. Everything ambiguous —
 * "intern", "grad", "stage", "starter" — stays client-side ONLY, where
 * `EARLY_CAREER_RE` matches on a word boundary and every drop is counted.
 *
 * WHAT THIS BUYS. The feed charges per job returned ($0.012 as of 2026-08-01).
 * On 2026-08-01 two of eight live rows were an internship and a graduate
 * scheme — a quarter of the day's budget paid for, fetched, and then thrown
 * away by `excludeEarlyCareer`. Excluding them upstream means the money buys
 * roles he can actually take.
 *
 * `excludeEarlyCareer` still runs on everything that comes back. This list is an
 * optimisation, never the guarantee.
 */
export const SOURCE_EXCLUDED_TITLE_TERMS: readonly string[] = [
  "internship",
  "trainee",
  "apprentice",
  "graduate",
  "student",
  "stagiair",
  "praktikant",
  "praktikum",
  "placement",
];

/**
 * A graduation-year marker: "Graduate Software Engineer (2027)", "Class of 2027".
 * A future year in a title is a cohort programme, not a role starting now.
 */
const COHORT_YEAR_RE = /\b(?:20[2-9]\d)\b/;

/**
 * True when the title advertises an early-career programme rather than a role.
 *
 * Pure and case-insensitive. "Senior Engineer" and "Staff Engineer" are never
 * matched; "Graduate Programme 2027" and "Working Student — Backend" always are.
 */
export function isEarlyCareerTitle(title: string): boolean {
  const normalised = title.toLowerCase();
  if (EARLY_CAREER_RE.test(normalised)) return true;
  // A bare year only counts alongside a programme word, so "Engineer, Payments
  // 2026 Team" is not swept up by the date alone.
  return COHORT_YEAR_RE.test(normalised) && /\b(?:programme|program|cohort|class)\b/i.test(normalised);
}

export interface SeniorityFilterResult<T> {
  readonly kept: readonly T[];
  /** How many were dropped. Reported, never silent. */
  readonly dropped: number;
  /** Titles that were dropped, for the brief's own accounting. */
  readonly droppedTitles: readonly string[];
}

/** Split postings into the ones worth screening and a counted set of early-career drops. */
export function excludeEarlyCareer<T extends { readonly title: string }>(
  postings: readonly T[],
): SeniorityFilterResult<T> {
  const kept: T[] = [];
  const droppedTitles: string[] = [];

  for (const posting of postings) {
    if (isEarlyCareerTitle(posting.title)) {
      droppedTitles.push(posting.title);
      continue;
    }
    kept.push(posting);
  }

  return { kept, dropped: droppedTitles.length, droppedTitles };
}

// ── Over-senior title detection ───────────────────────────────────────────────

import type { JobSearchProfile } from "./profile-config.js";

/** Executive / department-leadership title markers across all domains. */
export const EXECUTIVE_SENIOR_PHRASES: readonly RegExp[] = [
  /\bvice\s+president\b/i,
  /\bvp\b/i,
  /\b[es]vp\b/i,
  /\bavp\b/i,
  /\bassistant\s+vice\s+president\b/i,
  /\bdirector\b/i,
  /\bmanaging\s+director\b/i,
  /\bassociate\s+director\b/i,
  /\bhead\s+of\b/i,
  /\bchief\b/i,
  /\b(?:cto|cfo|coo|cio|ciso|cro|cmo)\b/i,
  /\bdistinguished\b/i,
  /\bfellow\b/i,
  /\bprincipal\b/i,
];

/**
 * Management, controller, and supervision titles.
 *
 * In corporate functions (finance, accounting, operations), a Manager, Controller,
 * or Supervisor role is a people-manager / functional-owner position requiring
 * 5-10+ years. For early-career candidates (~2-3 years, e.g. Tashi at 2.4 years),
 * automated ATS parsing filters out resumes lacking management experience.
 */
export const MANAGEMENT_SENIOR_PHRASES: readonly RegExp[] = [
  /\bmanager\b/i,
  /\bsupervisor\b/i,
  /\b(?:group\s+|corporate\s+|plant\s+)?financial\s+controller\b/i,
  /\bcomptroller\b/i,
];

/** Leadership / team-lead titles (Lead, Team Lead). */
export const LEAD_SENIOR_PHRASES: readonly RegExp[] = [
  /\blead\b/i,
  /\bteam\s+lead\b/i,
];

/** Senior IC titles (Senior, Sr.). */
export const SENIOR_IC_PHRASES: readonly RegExp[] = [
  /\bsenior\b/i,
  /\bsr\.?\b/i,
];

/** Terms that negate over-seniority when present. */
export const OVER_SENIOR_EXCEPTIONS: readonly RegExp[] = [
  /\bdirector\s+of\s+(?:photography|film|video|content|marketing|sales)\b/i,
  /\bart\s+director\b/i,
  /\bcreative\s+director\b/i,
];

/**
 * Explains why a title is over-senior for a candidate, or null if reachable.
 *
 * Domain- and experience-aware:
 * - Executive/C-level/Director/Principal: over-senior across all profiles (< 7 yrs).
 * - Manager/Supervisor/Controller: over-senior for early-career and finance profiles.
 * - Lead/Team Lead: over-senior for early-career (< 3 yrs) or finance profiles.
 * - Senior/Sr.: over-senior for early-career (< 3 yrs, e.g. Tashi at 2.4 yrs)
 *   where resume screening automatically rejects candidates below 3-5 years.
 */
export function overSeniorReason(title: string, profile?: JobSearchProfile): string | null {
  const normalised = title.trim();
  if (OVER_SENIOR_EXCEPTIONS.some((re) => re.test(normalised))) return null;

  if (EXECUTIVE_SENIOR_PHRASES.some((re) => re.test(normalised))) {
    return "an executive/leadership title";
  }

  if (MANAGEMENT_SENIOR_PHRASES.some((re) => re.test(normalised))) {
    return "a management/controller title";
  }

  const isFinance = profile?.skillsDictionaryName === "finance";
  const isEarlyCareer = (profile?.experienceYears ?? 4) < 3;

  // Lead / Team Lead is over-senior for early-career or finance candidates
  if (isFinance || isEarlyCareer) {
    if (LEAD_SENIOR_PHRASES.some((re) => re.test(normalised))) {
      return "a team-leadership title";
    }
  }

  // Senior IC (Senior / Sr.) is over-senior for early-career candidates (< 3 years, like Tashi at 2.4 yrs)
  if (isEarlyCareer) {
    if (SENIOR_IC_PHRASES.some((re) => re.test(normalised))) {
      const yrs = profile?.experienceYears ?? "early-career";
      return `a senior-level title for candidate with ~${yrs} years shipped`;
    }
  }

  return null;
}

/**
 * True when the title signals a role that is almost certainly out of reach
 * for the candidate given their domain and shipped years of experience.
 */
export function isOverSeniorTitle(title: string, profile?: JobSearchProfile): boolean {
  return overSeniorReason(title, profile) !== null;
}
