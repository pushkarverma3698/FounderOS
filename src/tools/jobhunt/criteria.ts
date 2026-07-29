/**
 * IND salary criteria, by date
 * ============================
 * The permit salary criterion is revised by the IND **every 1 January**. The
 * previous implementation was a bare `4357` literal, which means it silently
 * becomes a wrong legal floor on 2027-01-01 — computing confident verdicts from
 * a number nobody checked.
 *
 * So this table carries explicit validity windows and the lookup returns null
 * outside them. A null is not a failure mode to paper over: the caller flags for
 * a human rather than asserting. Refusing to answer is the correct behaviour for
 * a legal threshold whose current value has not been verified.
 *
 * Figures are gross per month EXCLUDING the 8% holiday allowance, as published.
 */

/** Founder DOB — decides which age band applies (campaign doc, 2026-07-29). */
export const FOUNDER_DOB = new Date("1998-06-03T00:00:00Z");

/** Hours per year used to convert an annual floor to an hourly contract rate. */
export const FULL_TIME_HOURS_PER_YEAR = 2080;

export type HsmBand = "under-30" | "over-30";

interface CriterionWindow {
  readonly from: string;
  readonly to: string;
  readonly under30Monthly: number;
  readonly over30Monthly: number;
}

/**
 * Verified against ind.nl for calendar 2026 (campaign doc §Constraints).
 * ADD A NEW ROW each January rather than editing one — an edited row silently
 * rewrites the history of every verdict already recorded.
 */
const CRITERIA: readonly CriterionWindow[] = [
  { from: "2026-01-01", to: "2026-12-31", under30Monthly: 4357, over30Monthly: 5942 },
];

export interface SalaryCriterion {
  readonly band: HsmBand;
  readonly monthly: number;
  readonly annualBase: number;
  readonly hourly: number;
  /** Human-readable source of the figure, for evidence strings. */
  readonly basis: string;
}

/** Whether the applicant is still inside the under-30 band on a given date. */
export function bandOn(date: Date, dob: Date = FOUNDER_DOB): HsmBand {
  const thirtieth = new Date(dob);
  thirtieth.setUTCFullYear(thirtieth.getUTCFullYear() + 30);
  return date < thirtieth ? "under-30" : "over-30";
}

/**
 * The criterion in force on a date, or null when that date falls outside every
 * verified window. Null means "unknown", never "zero" — a zero floor would pass
 * every posting.
 */
export function criterionOn(date: Date, dob: Date = FOUNDER_DOB): SalaryCriterion | null {
  const iso = date.toISOString().slice(0, 10);
  const window = CRITERIA.find((w) => iso >= w.from && iso <= w.to);
  if (!window) return null;

  const band = bandOn(date, dob);
  const monthly = band === "under-30" ? window.under30Monthly : window.over30Monthly;
  const annualBase = monthly * 12;

  return {
    band,
    monthly,
    annualBase,
    hourly: Math.round((annualBase / FULL_TIME_HOURS_PER_YEAR) * 100) / 100,
    basis: `IND ${window.from.slice(0, 4)} ${band} criterion, €${monthly}/month excl. holiday allowance`,
  };
}

/** The date the under-30 band lapses — after this an employer needs 36% more budget. */
export function bandExpiryDate(dob: Date = FOUNDER_DOB): Date {
  const d = new Date(dob);
  d.setUTCFullYear(d.getUTCFullYear() + 30);
  return d;
}
