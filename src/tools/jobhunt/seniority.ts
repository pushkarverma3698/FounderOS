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
