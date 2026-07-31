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
import { criterionOn, FULL_TIME_HOURS_PER_YEAR, type SalaryCriterion } from "./criteria.js";
import { extractLanguage, type SalaryFacts } from "./extract.js";
import { gateProfile, type PermitBasis } from "./permit-routes.js";

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
export function screenSalary(range: SalaryRange, floor = HSM_UNDER_30_ANNUAL_BASE_EUR): ScreenResult {
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

  if (stated < floor) {
    return {
      status: "reject",
      evidence:
        `Ceiling €${Math.round(stated)} is below the €${floor} annual base ` +
        `required by the highly skilled migrant criterion. The employer cannot ` +
        `lawfully make this hire, so applying is void.`,
    };
  }

  return {
    status: "pass",
    evidence: `Ceiling €${Math.round(stated)} clears the €${floor} annual base.`,
  };
}

/**
 * Reject postings that genuinely require Dutch; keep the ones where it is a plus.
 *
 * Delegates to the bilingual, sentence-scoped extractor. The predecessor matched
 * only English requirement words, so "Nederlands is vereist" — the way most Dutch
 * postings say it — passed straight through the gate.
 */
export function screenLanguage(text: string): ScreenResult {
  const { dutchRequired, evidence } = extractLanguage(text);
  if (dutchRequired === "yes") return { status: "reject", evidence };
  if (dutchRequired === "unstated") return { status: "flag", evidence };
  return { status: "pass", evidence };
}

/**
 * Which permit basis a screen is being run under.
 *
 * Aliased to `PermitBasis` so there is exactly one definition of the set. Two
 * would drift, and the drift would show up as a route the screener silently
 * declines to handle.
 */
export type ScreenRoute = PermitBasis;

const HOLIDAY_ALLOWANCE_MULTIPLIER = 1.08;

/** Convert one stated figure to an annual base, given its unit. */
function toAnnual(value: number, unit: SalaryFacts["unit"]): number | null {
  if (unit === "annual") return value;
  if (unit === "monthly") return value * 12;
  if (unit === "hourly") return value * FULL_TIME_HOURS_PER_YEAR;
  return null;
}

/**
 * Every annual-base figure the posting could plausibly mean.
 *
 * This is the mechanism behind the rule that governs queue volume: enumerate what
 * is genuinely still open, screen each reading, and only involve a human when the
 * readings DISAGREE. An unstated holiday basis on an €80k role is not worth
 * anyone's attention — it clears the floor either way.
 */
export function candidateAnnualBases(facts: SalaryFacts): number[] {
  const stated = facts.max ?? facts.min;
  if (stated === undefined) return [];

  const annual = toAnnual(stated, facts.unit);
  if (annual === null) return [];

  const byHoliday =
    facts.holidayBasis === "included"
      ? [annual / HOLIDAY_ALLOWANCE_MULTIPLIER]
      : facts.holidayBasis === "excluded"
        ? [annual]
        : [annual, annual / HOLIDAY_ALLOWANCE_MULTIPLIER];

  // A part-time posting may quote the full-time equivalent or the actual pay, and
  // the wording rarely settles which. Both are live readings.
  const fte = facts.fteFactor;
  return fte === undefined ? byHoliday : byHoliday.flatMap((v) => [v, v * fte]);
}

/** Describe the unresolved ambiguities, for a flag's evidence. */
function ambiguityNotes(facts: SalaryFacts): string[] {
  const notes: string[] = [];
  if (facts.holidayBasis === "unstated") {
    notes.push("whether the figure includes the 8% holiday allowance");
  }
  if (facts.fteFactor !== undefined) {
    notes.push(`whether the figure is full-time-equivalent (posting is ${Math.round(facts.fteFactor * 40)}h/week)`);
  }
  if (facts.unitInferred && facts.unit !== "none") {
    notes.push(`whether the figure is ${facts.unit} (inferred from its size, not stated)`);
  }
  return notes;
}

/**
 * Screen extracted salary facts against the criterion in force.
 *
 * Returns `flag` — never a verdict — when the criterion for the date is not one
 * this codebase has verified. Asserting a legal threshold from a stale constant
 * is the failure this guards against.
 */
export function screenSalaryFacts(
  facts: SalaryFacts,
  opts: { route?: ScreenRoute; now?: Date } = {},
): ScreenResult {
  const now = opts.now ?? new Date();
  const floorApplies = gateProfile(opts.route ?? "hsm").salaryFloorApplies;
  const criterion: SalaryCriterion | null = criterionOn(now);

  // An unverified criterion only matters where the criterion is a legal condition.
  // On a partner permit or a remote contract there is no floor to be stale about,
  // so flagging here would manufacture doubt about a basis that has no such rule.
  if (!criterion) {
    return floorApplies
      ? {
          status: "flag",
          evidence:
            `No verified IND salary criterion for ${now.toISOString().slice(0, 10)} — the table in ` +
            `criteria.ts covers 2026 only and IND revises every 1 January. Re-check ind.nl and add ` +
            `the new window before trusting any salary verdict.`,
        }
      : {
          status: "pass",
          evidence: "No IND salary criterion applies on this basis.",
        };
  }

  const candidates = candidateAnnualBases(facts);
  if (candidates.length === 0) {
    if (!floorApplies) {
      return {
        status: "flag",
        evidence:
          "No salary stated — normal for Dutch postings. No criterion applies on this basis, so " +
          "this is not a bar; ask at first contact before investing effort in an application.",
      };
    }
    const floorNote =
      opts.route === "remote-contract"
        ? `€${criterion.hourly}/hour (the ${criterion.annualBase} annual floor at full-time hours)`
        : `€${criterion.annualBase} base`;
    return {
      status: "flag",
      evidence: `No salary stated — normal for Dutch postings. Confirm the employer can meet ${floorNote} before investing in an application.`,
    };
  }

  const results = candidates.map((v) => screenSalary({ max: v }, criterion.annualBase));
  const statuses = new Set(results.map((r) => r.status));

  // Where no legal floor applies, a low figure is a fact about the offer, not
  // grounds to void it — so this never rejects. But it must not silently PASS
  // either: "this role pays €40,000" stays decision-relevant even when it is
  // perfectly lawful, and swallowing it would trade a wrong rejection for a
  // wrong acceptance. Below the HSM figure it flags for a look; at or above it
  // passes clean. The HSM number is used only as a familiar reference point here,
  // never as a legal claim.
  if (!floorApplies) {
    const best = Math.round(Math.max(...candidates));
    const quoted = facts.raw ? ` Read from: "${facts.raw}".` : "";
    return best >= criterion.annualBase
      ? {
          status: "pass",
          evidence: `€${best} — comfortably above the €${criterion.annualBase} HSM reference, and no criterion applies on this basis anyway.${quoted}`,
        }
      : {
          status: "flag",
          evidence:
            `€${best} is below the €${criterion.annualBase} HSM reference. On this basis that is NOT a legal bar — ` +
            `the role is lawful — but it is worth a deliberate look before applying.${quoted}`,
        };
  }

  if (statuses.size === 1) {
    const only = results[0]!;
    const quoted = facts.raw ? ` Read from: "${facts.raw}".` : "";
    return { status: only.status, evidence: `${only.evidence}${quoted} (${criterion.basis}.)` };
  }

  const range = [Math.min(...candidates), Math.max(...candidates)].map((v) => `€${Math.round(v)}`);
  return {
    status: "flag",
    evidence:
      `Verdict depends on ${ambiguityNotes(facts).join(" and ")}. Readings span ${range[0]}–${range[1]} ` +
      `against a €${criterion.annualBase} floor, so this genuinely needs a human. ` +
      `Read from: "${facts.raw ?? "(no figure matched)"}".`,
  };
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
 * Cosmetic tokens that carry no role identity — gender markers, employment type,
 * and the decorations recruiters append to otherwise identical titles.
 */
const TITLE_NOISE = new Set([
  "m", "f", "v", "d", "w", "x", "mfd", "mvd", "mv",
  "fulltime", "full", "parttime", "part", "time", "fte",
  "remote", "hybrid", "onsite", "freelance", "contract", "permanent",
  "new", "urgent", "hiring", "role", "position", "vacancy", "job",
]);

/**
 * A weaker identity than `dedupeKey`: same company, same title WORDS, any order,
 * noise removed. "Senior AI Engineer", "AI Engineer (Senior)" and
 * "Senior AI Engineer (m/f/d)" all collapse to one value.
 *
 * Deliberately NOT used to block. Sorting tokens can merge genuinely distinct
 * roles ("engineering manager" vs "manager, engineering" are the same; "data
 * engineer lead" vs "lead data engineer" are too, but the technique is not sound
 * enough to bet an opportunity on). So this raises a warning for a human while
 * `dedupeKey` remains the thing that actually prevents a double application.
 */
export function softDedupeKey(company: string, title: string): string {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TITLE_NOISE.has(t));
  const unique = [...new Set(tokens)].sort();
  return `${normaliseCompanyName(company)}::${unique.join(" ")}`;
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
