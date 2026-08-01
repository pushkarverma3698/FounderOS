/**
 * FounderOS — the stated-years gate
 * =================================
 * Founder direction, 2026-08-01: "no one will give a job to a 3 year or 4 year
 * of experience while applying for platform engineer" — reject postings that
 * demand more than four years.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not reject, flag, or otherwise act
 * on a title — not "Senior", "Staff", "Lead", "Principal", "Director", or "VP".
 * Those words mean different things at different companies, and a title is not a
 * year count: it is a guess about one, and the founder's instruction was to
 * screen on stated years, not on guesses (founder correction, 2026-08-02: an
 * earlier version of this gate flagged Director/VP titles with no stated years —
 * that was scope the founder never asked for, added unilaterally, and reverted).
 * The gate rejects on a NUMBER the employer wrote down, and on nothing else.
 *
 * THE CONSERVATIVE DIRECTION. A posting states several year figures — "3-5 years
 * backend", "5+ years with Kubernetes is a plus", "10 years serving the Dutch
 * market". The gate takes the MINIMUM across every figure it finds, because the
 * lowest stated number is the entry bar and everything above it is a wish list.
 * A posting is rejected only when EVERY stated figure is above the ceiling. That
 * is the direction where being wrong costs a wasted read rather than a lost job.
 *
 * The other half of the same discipline is the exclusion list: "we have over 20
 * years of experience" is a sentence about the COMPANY, and counting it as a
 * requirement would reject a graduate-friendly employer on the strength of its
 * own marketing.
 */

import type { ScreenStatus } from "./filters.js";
import type { Gate } from "./gates.js";
import { isEarlyCareerTitle } from "./seniority.js";

/**
 * The most years a posting may demand and still be worth an application.
 *
 * Four, not three: Pushkar has ~3.5 years shipped (Mar 2023 → today), and a
 * posting asking for four is one a strong candidate at 3.5 wins routinely. Five
 * is where the screen stops being optimistic and starts being a waste of a
 * cover letter.
 */
export const MAX_YEARS_DEMANDED = 4;

/**
 * Above this, the number is describing a company, a product, or a market — not a
 * candidate. Nobody advertises an engineering role requiring 26 years.
 */
const IMPLAUSIBLE_YEARS = 25;

/** English and Dutch. Dutch postings write "minimaal 5 jaar ervaring" verbatim. */
const EXPERIENCE_WORDS = /\b(?:experience|experienced|ervaring|werkervaring|exp\.)\b/i;

/**
 * Sentences that are about the EMPLOYER's history rather than the candidate's.
 *
 * Checked before any number in that sentence is counted. "With 15 years of
 * experience in payments, we…" is the single most common false positive, and
 * without this the gate would reject established companies for being established.
 */
const COMPANY_HISTORY = /\b(?:we(?:'ve| have| are)?|our (?:company|team|firm|agency)|founded|since|established|for over|in business|serving)\b/i;

/**
 * A years-of-experience figure, capturing the LOWEST number in the phrase.
 *
 * Handles "5 years", "5+ years", "5-8 years", "5 to 8 years", "5 jaar". The
 * capture is deliberately the first number: in "3-5 years" the bar is 3.
 */
const YEARS_RE = /(\d{1,2})\s*(?:\+|\s*(?:-|–|—|to|tot)\s*\d{1,2})?\s*(?:\+\s*)?(?:years?|yrs?|jaar|jr)\b/gi;

/** Split on sentence-ish boundaries: full stops, newlines, bullets, semicolons. */
function sentences(text: string): string[] {
  return text
    .split(/(?:[.!?;\n\r•·]|\s{2,})+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface ExperienceDemand {
  /** The lowest number of years the posting asks a CANDIDATE for. */
  readonly minYears: number | null;
  /** The sentence the figure came from, verbatim, so the verdict is checkable. */
  readonly evidence: string | null;
}

/**
 * Read the years-of-experience demand out of a posting body.
 *
 * Pure and unit-tested. Returns `minYears: null` when the posting never states a
 * figure, which is the common case and must never read as "0 years required" —
 * an unstated requirement is unknown, not absent, and the gate passes it through
 * rather than inventing a number to compare against.
 */
export function extractExperienceDemand(description: string): ExperienceDemand {
  let minYears: number | null = null;
  let evidence: string | null = null;

  for (const sentence of sentences(description)) {
    if (!EXPERIENCE_WORDS.test(sentence)) continue;
    if (COMPANY_HISTORY.test(sentence)) continue;

    // `lastIndex` is shared state on a /g regex — reset before every sentence or
    // the second sentence starts scanning from wherever the first one stopped.
    YEARS_RE.lastIndex = 0;
    for (let m = YEARS_RE.exec(sentence); m !== null; m = YEARS_RE.exec(sentence)) {
      const years = Number(m[1]);
      if (!Number.isFinite(years) || years <= 0 || years > IMPLAUSIBLE_YEARS) continue;
      if (minYears === null || years < minYears) {
        minYears = years;
        evidence = sentence.slice(0, 200);
      }
    }
  }

  return { minYears, evidence };
}

/**
 * The Experience gate — the level bar in BOTH directions.
 *
 * Four outcomes, all of them stated out loud in the brief:
 *   · an internship or graduate scheme → reject, named as such.
 *   · no figure stated  → pass, and SAY that no figure was stated. A silent pass
 *     and a verified match look identical, and the founder deserves to know
 *     which one he is reading.
 *   · at or under the ceiling → pass, with the number.
 *   · over the ceiling → reject, with the sentence that says so.
 *
 * Early-career postings used to be DROPPED before screening, so they never
 * reached the table and the founder could not audit what had been thrown away on
 * his behalf. They are a gate now (founder direction, 2026-08-01: "store all the
 * data we are collecting even if it is senior and of no use to us"). Rejecting
 * inside the pipeline costs one row and buys a reason on the record; dropping
 * outside it saved nothing and destroyed the evidence.
 */
export function experienceGate(description: string, title: string): Gate {
  if (isEarlyCareerTitle(title)) {
    return {
      gate: "Experience",
      status: "reject",
      evidence:
        `"${title}" is an internship, graduate scheme or working-student role — ` +
        `an entry programme, not a role for someone ~3.5 years in. Kept on record ` +
        `so the day's spend is auditable, but not worth an application.`,
    };
  }

  const demand = extractExperienceDemand(description);

  if (demand.minYears === null) {
    return {
      gate: "Experience",
      status: "pass",
      evidence:
        "The posting states no number of years. Nothing here rules you out — but " +
        "nothing confirms the level either, so read the responsibilities before applying.",
    };
  }

  const status: ScreenStatus = demand.minYears > MAX_YEARS_DEMANDED ? "reject" : "pass";

  if (status === "reject") {
    return {
      gate: "Experience",
      status,
      evidence:
        `Asks for ${demand.minYears} years minimum; you have ~3.5 shipped. ` +
        `Their words: "${demand.evidence}". Skipped so the day's applications go ` +
        `to roles that can actually shortlist you.`,
    };
  }

  return {
    gate: "Experience",
    status,
    evidence:
      `Asks for ${demand.minYears} year(s) — within reach of your ~3.5 shipped. ` +
      `Their words: "${demand.evidence}".` +
      (isSeniorTitle(title)
        ? ` The title says senior, but the stated bar is what counts here, not the label.`
        : ""),
  };
}

/**
 * Titles that LOOK senior. Used only to add a sentence to a passing gate, never
 * to reject or flag — see the module note on why a title is not evidence of a
 * year count.
 */
export function isSeniorTitle(title: string): boolean {
  return /\b(?:senior|sr\.?|staff|principal|lead|head of|director)\b/i.test(title);
}
