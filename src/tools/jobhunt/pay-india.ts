/**
 * FounderOS — Indian pay: reading it, and screening it
 * ====================================================
 * A separate reader from `extractSalary`, and the separation is not tidiness.
 *
 * The European parser exists to resolve one specific ambiguity: "55.000" and
 * "55,000" are both fifty-five thousand in their own conventions, while "4,50"
 * is four-fifty, and Dutch postings written in English mix both. Indian postings
 * share none of that syntax. They group by LAKH — `15,00,000` is one and a half
 * million — and quote units the EUR parser has never seen: LPA, lakh, crore.
 * Running a rupee figure through the euro path does not yield a slightly wrong
 * number. It yields a confident EURO claim about a RUPEE salary, which is how a
 * ₹12,00,000 role would have read as comfortably above a €52,284 permit floor.
 *
 * THE LINE IS ₹15 LPA AND IT FLAGS, NEVER REJECTS (founder's decision,
 * 2026-08-01, chosen from stated options). There is no legal floor in this market
 * — he lives in India and needs no permit — so a figure below the line is a fact
 * about the offer, not grounds to void it. The role still appears, with its
 * number printed, in the section that asks a question. Screening criteria are
 * never added here without being asked for; this one was.
 *
 * Pure: no I/O, no model, no network.
 */

import type { ScreenResult } from "./filters.js";

/** One lakh. Indian pay is quoted in these, not in thousands. */
const LAKH = 100_000;
const CRORE = 100 * LAKH;
const MONTHS_PER_YEAR = 12;

/**
 * The founder's line between "fine" and "worth a deliberate look", in lakhs.
 *
 * Chosen by him on 2026-08-01 from a set of stated options, over ₹20L and ₹25L.
 * It is a PREFERENCE, and the code must never present it as anything else: there
 * is no Indian equivalent of the IND salary criterion, and dressing a preference
 * up as a legal bar is what makes a screener trustworthy right up until it is
 * catastrophically wrong.
 */
export const INDIA_PAY_REFERENCE_LPA = 15;
export const INDIA_PAY_REFERENCE_INR = INDIA_PAY_REFERENCE_LPA * LAKH;

/**
 * Above this max/min ratio, a quoted range is not a band — it is an unfilled form.
 *
 * Four is deliberately generous. Real Indian bands do run wide (₹12–₹24 LPA is
 * ordinary at this level, a 2× spread), so a tighter threshold would flag honest
 * ads and bury real roles behind a question. What it catches is the shape live
 * production produced on 2026-08-01: "₹50,000.00 - ₹500,000.00 a month", a 10×
 * spread on a role open to freshers.
 */
const IMPLAUSIBLE_RANGE_RATIO = 4;

export interface IndianPayFacts {
  /** Annualised rupees. Both ends present only when the ad quoted a range. */
  readonly minAnnual?: number;
  readonly maxAnnual?: number;
  /** True when the period was guessed from magnitude rather than stated. */
  readonly unitInferred: boolean;
  /** The matched substring, so evidence can quote the posting rather than assert. */
  readonly raw?: string;
}

/**
 * Plausible annual rupee pay for a software role.
 *
 * Used only to tell an unlabelled ANNUAL figure from an unlabelled MONTHLY one.
 * Below the annual floor a bare number is far more likely to be a month's pay —
 * nobody advertises a ₹90,000/year engineering role.
 */
const PLAUSIBLE_ANNUAL_MIN = 2 * LAKH;

/** A rupee marker must be present. Bare numbers are not money. */
const CURRENCY = String.raw`(?:₹|Rs\.?|INR)`;
/** `15,00,000` · `1500000` · `1.2` — Indian grouping never uses a comma decimal. */
const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|to|and)\s*`;

const LAKH_UNIT = String.raw`(?:lpa|lakhs?|lacs?|l\b)`;
const CRORE_UNIT = String.raw`(?:crores?|cr\b)`;
const MONTHLY_UNIT = String.raw`(?:per\s*month|p\.?\s*m\.?|monthly|\/\s*month|a\s*month)`;
const ANNUAL_UNIT = String.raw`(?:per\s*annum|p\.?\s*a\.?|annually|annual|per\s*year|\/\s*year|a\s*year|yearly)`;
/** Either scale unit, for the range patterns below. */
const SCALE_UNIT = `(?:${LAKH_UNIT}|${CRORE_UNIT})`;

/**
 * Parse one Indian money token.
 *
 * Commas are always thousands/lakh grouping in this convention, never a decimal
 * mark, so stripping them is safe here in a way it explicitly is not for EUR.
 */
export function parseRupees(token: string): number | null {
  const cleaned = token.replace(/[₹\s]/g, "").replace(/,/g, "");
  if (cleaned.length === 0 || !/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Scale a bare figure by whatever unit sat next to it in the ad. */
function applyUnit(value: number, context: string): { annual: number; inferred: boolean } | null {
  if (new RegExp(CRORE_UNIT, "i").test(context)) return { annual: value * CRORE, inferred: false };
  if (new RegExp(LAKH_UNIT, "i").test(context)) return { annual: value * LAKH, inferred: false };
  if (new RegExp(MONTHLY_UNIT, "i").test(context)) {
    return { annual: value * MONTHS_PER_YEAR, inferred: false };
  }
  if (new RegExp(ANNUAL_UNIT, "i").test(context)) return { annual: value, inferred: false };

  // Nothing stated. A figure large enough to be a year's pay is read as one; a
  // smaller one is read as a month's and annualised. Both are marked inferred so
  // the evidence line says the period was guessed rather than quoted.
  if (value >= PLAUSIBLE_ANNUAL_MIN) return { annual: value, inferred: true };
  if (value >= 10_000) return { annual: value * MONTHS_PER_YEAR, inferred: true };
  return null;
}

/** How far past a match to look for the unit that qualifies it. */
const UNIT_WINDOW = 24;

/**
 * Pull an annualised rupee figure out of the posting.
 *
 * Requires either a currency marker (₹ / Rs / INR) or an Indian unit (LPA, lakh,
 * crore). A bare "70,000" is NOT read as rupees — on a Dutch posting that is a
 * euro salary, and misreading it as a sub-line Indian one would flag a strong
 * role for the wrong reason.
 */
export function extractIndianPay(text: string): IndianPayFacts {
  const withUnit = String.raw`(?:${CURRENCY}\s*)?(${NUMBER})\s*${SCALE_UNIT}`;
  const withCurrency = String.raw`${CURRENCY}\s*(${NUMBER})`;

  // Ranges first: "18 - 24 LPA" and "₹15,00,000 to ₹20,00,000". Reading the
  // single-value pattern first would take the FLOOR of every range as the whole
  // answer and understate half the market.
  //
  // The unit is OPTIONAL on the first number and required on the second, because
  // that is how ranges are actually written: "18 - 24 LPA", not "18 LPA - 24 LPA".
  // Requiring it on both matched neither, and the ceiling silently vanished.
  const rangePatterns = [
    String.raw`(?:${CURRENCY}\s*)?(${NUMBER})\s*${SCALE_UNIT}?${RANGE_SEP}(?:${CURRENCY}\s*)?(${NUMBER})\s*${SCALE_UNIT}`,
    String.raw`${CURRENCY}\s*(${NUMBER})${RANGE_SEP}(?:${CURRENCY}\s*)?(${NUMBER})`,
  ];

  for (const pattern of rangePatterns) {
    const rangeRe = new RegExp(pattern, "i");
    const range = rangeRe.exec(text);
    if (range) {
      const context = text.slice(range.index, range.index + range[0].length + UNIT_WINDOW);
      const lo = parseRupees(range[1] ?? "");
      const hi = parseRupees(range[2] ?? "");
      if (lo !== null && hi !== null && lo <= hi) {
        const min = applyUnit(lo, context);
        const max = applyUnit(hi, context);
        if (min && max) {
          return {
            minAnnual: min.annual,
            maxAnnual: max.annual,
            unitInferred: max.inferred,
            raw: range[0].trim(),
          };
        }
      }
    }
  }

  for (const pattern of [withUnit, withCurrency]) {
    const single = new RegExp(pattern, "i").exec(text);
    if (single) {
      const context = text.slice(single.index, single.index + single[0].length + UNIT_WINDOW);
      const value = parseRupees(single[1] ?? "");
      if (value !== null) {
        const scaled = applyUnit(value, context);
        if (scaled) {
          return {
            maxAnnual: scaled.annual,
            unitInferred: scaled.inferred,
            raw: single[0].trim(),
          };
        }
      }
    }
  }

  return { unitInferred: false };
}

/** Rupees as the founder reads them: "₹18.5 LPA", not "1850000". */
export function formatLpa(rupees: number): string {
  const lakhs = rupees / LAKH;
  const rounded = Math.round(lakhs * 10) / 10;
  return `₹${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} LPA`;
}

/**
 * Screen Indian pay against the founder's line.
 *
 * Three outcomes and no fourth: above the line passes, below it flags, and an
 * unstated figure passes with the question named. It CANNOT reject — there is no
 * legal bar in this market to reject against, and inventing one would silently
 * discard reachable roles, which is the failure direction this codebase treats
 * as the expensive one.
 */
export function screenIndianPay(
  facts: IndianPayFacts,
  referenceInr: number = INDIA_PAY_REFERENCE_INR,
): ScreenResult {
  const stated = facts.maxAnnual ?? facts.minAnnual;

  // A range this wide is not a salary band, it is an unfilled form.
  //
  // Live prod, 2026-08-01: a "Full Stack Web Developer, 2–5 years, freshers with
  // exceptional portfolios welcome" advertised "₹50,000.00 - ₹500,000.00 a
  // month". Taking the ceiling — which is right for the Dutch permit floor,
  // where a band straddling it is negotiable upward — annualised to ₹60 LPA and
  // PASSED, so the brief told the founder a ₹50k-a-month role paid sixty lakh.
  // Indeed's salary field is free text and ranges like this are common in it.
  //
  // The honest answer is the one `screenSalaryFacts` already gives for readings
  // that disagree: show both ends and ask. Flag, never reject — the role is
  // real, only the number is not.
  if (facts.minAnnual !== undefined && facts.maxAnnual !== undefined && facts.minAnnual > 0) {
    const spread = facts.maxAnnual / facts.minAnnual;
    if (spread >= IMPLAUSIBLE_RANGE_RATIO) {
      return {
        status: "flag",
        evidence:
          `The ad quotes ${formatLpa(facts.minAnnual)} to ${formatLpa(facts.maxAnnual)} — a ` +
          `${Math.round(spread)}× spread, which is a form nobody filled in rather than a real ` +
          `band. Neither end can be trusted; ask what the role actually pays.` +
          (facts.raw ? ` Read from: "${facts.raw}".` : ""),
      };
    }
  }

  if (stated === undefined) {
    return {
      status: "pass",
      evidence:
        "No pay stated, which is normal for Indian postings and is not a bar. " +
        "Pay is unconfirmed — ask at first contact before investing time in the process.",
    };
  }

  const quoted = facts.raw ? ` Read from: "${facts.raw}".` : "";
  const guessed = facts.unitInferred
    ? " The period was inferred from the size of the figure, not stated in the ad."
    : "";
  const shown = formatLpa(stated);

  if (stated >= referenceInr) {
    return {
      status: "pass",
      evidence: `${shown} — at or above your ${formatLpa(referenceInr)} line.${quoted}${guessed}`,
    };
  }

  return {
    status: "flag",
    evidence:
      `${shown} is below your ${formatLpa(referenceInr)} line. Nothing here bars the role — ` +
      `it is lawful and you can apply — but it is worth a deliberate look before ` +
      `spending an application on it.${quoted}${guessed}`,
  };
}
