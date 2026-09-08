/**
 * FounderOS — the gate record
 * ===========================
 * A screening verdict is three or four separate CHECKS, each with its own
 * outcome. Until 2026-08-01 only the combined status survived the boundary:
 *
 *     const reasons = gates.map((g) => `${g.gate}: ${g.evidence}`);
 *
 * `g.status` was dropped on that line, and everything downstream — the daily
 * brief, `/ask`, the founder — saw a flat pipe-joined string with no way to tell
 * a check that PASSED from the one that failed. The brief printed reason #1 as
 * the row's headline, so a row flagged on salary was labelled with its PASSING
 * sponsor line, and `/ask` handed the model all three gates under the heading
 * "What is unresolved". The founder's reaction to the first real brief was that
 * he could not tell why any company was on the list. He was right, and this
 * module is the reason it could not be told: the information had already been
 * thrown away before anything tried to display it.
 *
 * So the gates are now carried whole — status included — from `screenPosting` to
 * the database (`gate_json`) to the renderer. Nothing downstream re-derives a
 * status from prose, because a regex over evidence text is exactly the
 * guess-shaped mechanism that produced the original bug.
 */

import type { ScreenStatus } from "./filters.js";
import type { JobSearchProfile } from "./profile-config.js";
import { criterionOn } from "./criteria.js";
import { gateProfile, isKnownPermitBasis, type PermitBasis } from "./permit-routes.js";

/** One check, its outcome, and the evidence that produced it. */
export interface Gate {
  readonly gate: string;
  readonly status: ScreenStatus;
  readonly evidence: string;
}

export interface ScreenVerdict {
  readonly status: ScreenStatus;
  /** Every gate, in the order applied, with its own status intact. */
  readonly gates: readonly Gate[];
  /** One line per gate. Retained for the plain-text `screen_job` reply. */
  readonly reasons: readonly string[];
}

/**
 * Combine individual gate results into one verdict.
 *
 * `reject` is absorbing — one legally impossible gate makes the posting void
 * regardless of how well it scores elsewhere. `gates` is carried through
 * unchanged; that is the entire point of this function existing separately.
 */
export function combineVerdict(gates: readonly Gate[]): ScreenVerdict {
  const reasons = gates.map((g) => `${g.gate}: ${g.evidence}`);
  const status: ScreenStatus = gates.some((g) => g.status === "reject")
    ? "reject"
    : gates.some((g) => g.status === "flag")
      ? "flag"
      : "pass";
  return { status, gates, reasons };
}

/**
 * The gates that are the REASON this row is not a yes.
 *
 * On a reject, the rejecting gates. On a flag, the flagged ones. On a pass,
 * none — and an empty array is the honest answer there, not a fallback to
 * "gate #1". Deriving a headline from position rather than status is the
 * original defect.
 */
export function blockingGates(verdict: {
  readonly status: ScreenStatus;
  readonly gates: readonly Gate[];
}): readonly Gate[] {
  if (verdict.status === "pass") return [];
  return verdict.gates.filter((g) => g.status === verdict.status);
}

// ── Persistence ───────────────────────────────────────────────────────────────

/** Bound the stored gate record. Evidence strings are prose and can run long. */
const EVIDENCE_MAX = 600;

/** Serialise for the `gate_json` column. */
export function serialiseGates(gates: readonly Gate[]): string {
  return JSON.stringify(
    gates.map((g) => ({
      gate: g.gate,
      status: g.status,
      evidence: g.evidence.slice(0, EVIDENCE_MAX),
    })),
  );
}

const STATUSES: readonly string[] = ["pass", "flag", "reject"];

function isGate(value: unknown): value is Gate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["gate"] === "string" &&
    typeof v["evidence"] === "string" &&
    typeof v["status"] === "string" &&
    STATUSES.includes(v["status"])
  );
}

/**
 * Read the gates back off a row, tolerating everything already in the table.
 *
 * Rows screened before `gate_json` existed carry only `salary_evidence`, and
 * every row in production on 2026-08-01 is one of those. They still have to
 * render, so the legacy string is split back into gate/evidence pairs — but the
 * status is genuinely UNKNOWN for those, and it is reported as `flag` (needs a
 * look) rather than invented. Guessing `pass` would put a legacy row into APPLY
 * TODAY on no evidence at all; guessing `reject` would bury a real opportunity.
 * "We don't know, go and look" is the only claim the stored data supports.
 */
export function parseGates(row: {
  readonly gate_json?: unknown;
  readonly salary_evidence?: string | null;
}): { gates: readonly Gate[]; legacy: boolean } {
  const raw = row.gate_json;
  const parsed: unknown =
    typeof raw === "string" ? safeJsonParse(raw) : raw;

  if (Array.isArray(parsed)) {
    const gates = parsed.filter(isGate);
    if (gates.length > 0) return { gates, legacy: false };
  }

  const legacyGates = (row.salary_evidence ?? "")
    .split(" | ")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece): Gate => {
      const colon = piece.indexOf(": ");
      return colon > 0
        ? { gate: piece.slice(0, colon), status: "flag", evidence: piece.slice(colon + 2) }
        : { gate: "Check", status: "flag", evidence: piece };
    });

  return { gates: legacyGates, legacy: true };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Presentation vocabulary ───────────────────────────────────────────────────

/**
 * What each gate NAME means, in the words the founder would use — FOR THE
 * CANDIDATE WHOSE BRIEF THIS IS.
 *
 * The brief used to print a bare gate label — "Sponsor" — followed by register
 * prose, and the founder's question was literally "what is this? sponsor?".
 * A label nobody defined is not information. These strings are the definition,
 * printed once per brief in the legend.
 *
 * IT WAS A CONSTANT UNTIL 2026-09-08, and every number in it was the founder's.
 * Rendered against the second candidate's real gate set that day, four of five
 * lines were false about her: "your ~3.5 years shipped" (she has 2.4),
 * "€4,357/month, under-30 band" (her rows are screened against the €3,122
 * reduced criterion), "only a recognised sponsor can hire you" (her leading
 * basis needs none), and a Location line naming a market she did not target.
 *
 * A legend defined with another person's CV and another person's permit is worse
 * than an undefined label: it is confidently wrong, on the one block of the brief
 * whose whole job is to explain the rest. So every figure here is now READ from
 * the profile and from the criterion actually in force, never written down twice.
 */
export function gateGlossary(
  profile: JobSearchProfile,
  now: Date = new Date(),
): Readonly<Record<string, string>> {
  const criterion = criterionOn(now, profile.dob, profile.permitBases.includes("zoekjaar"));
  // Stated rather than asserted when the table has lapsed — `screenSalaryFacts`
  // flags in exactly that case, so the legend must not claim a floor it cannot
  // name (criteria.ts covers one calendar year at a time, by design).
  const floor = criterion
    ? `€${criterion.monthly.toLocaleString("en-US")}/month base, ${criterion.band} band`
    : "no verified criterion for today's date — every salary check is currently a flag";

  const markets = profile.targetCountries.map((c) => countryLabel(c)).join(" nor ");

  // Bases this candidate holds that need NO recognised sponsor. Naming them is
  // what stops the Sponsor line reading as a bar on a permit that has none.
  const sponsorFree = profile.permitBases
    .filter((b) => isKnownPermitBasis(b) && !gateProfile(b).sponsorRequired)
    .map((b) => gateProfile(b as PermitBasis).label);
  const sponsorClause =
    sponsorFree.length > 0
      ? ` It does not apply on every basis you hold — ${listOf(sponsorFree)} ` +
        `${sponsorFree.length === 1 ? "needs" : "need"} no sponsor at all, and each row's own ` +
        `route says which basis carried it.`
      : "";

  const payLine =
    profile.minInrLpaFloor === undefined
      ? "Indian roles only. No personal pay line is set for you, so the ad's figure is " +
        "printed and nothing is flagged on it. Ask for one to be set if you want roles " +
        "below a number to get a second look."
      : `Indian roles only. Does the pay reach your ₹${profile.minInrLpaFloor} LPA line — YOUR ` +
        "preference, not a legal bar. Below it the role is still lawful and still applicable; " +
        "it just gets a second look before you spend an application on it.";

  return {
    Sponsor:
      "Is this employer on the IND recognised-sponsor register? Only a recognised " +
      `sponsor can hire you on a highly skilled migrant permit.${sponsorClause}`,
    Basis:
      "Which permit or contract makes this role lawful for you at all — " +
      `${listOf(profile.permitBases.filter(isKnownPermitBasis).map((b) => gateProfile(b).label))}.`,
    Salary:
      `Does the pay clear the permit's legal floor (${floor})? ` +
      "Below it the permit cannot be issued, however much they want you.",
    Rate: "Is the day rate or salary worth taking on a remote contract, where no permit floor applies.",
    Pay: payLine,
    Language: "Does the posting require Dutch. If it does, you cannot be shortlisted.",
    Experience: `How many years the posting explicitly demands, versus your ~${profile.experienceYears} years shipped.`,
    Location:
      "Where the job actually is — taken from the feed, not guessed from the ad. Only " +
      `appears when the answer is ${markets.length > 0 ? `neither ${markets}` : "outside your markets"}, or when nobody ` +
      "recorded one, because then every basis below is an assumption rather than a finding.",
    Posting: "Whether we actually received enough of the job ad to judge it.",
  };
}

/** "the Netherlands" reads as a place in a sentence; the raw config key does not. */
function countryLabel(country: { readonly code: string; readonly names: readonly string[] }): string {
  const first = country.names[0] ?? country.code;
  const titled = first.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return titled === "Netherlands" ? "the Netherlands" : titled;
}

/** "a", "a nor b", "a, b nor c" — Oxford-free, matching the legend's register. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The mark that precedes a gate line. Status is the ONLY input. */
export function gateMark(status: ScreenStatus): string {
  return status === "pass" ? "✅" : status === "flag" ? "❓" : "⛔";
}

/** "cleared" / "needs an answer" / "blocked" — the status in plain English. */
export function gateVerdictWord(status: ScreenStatus): string {
  return status === "pass" ? "cleared" : status === "flag" ? "needs an answer" : "blocked";
}
