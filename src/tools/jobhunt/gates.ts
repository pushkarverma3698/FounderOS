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
 * What each gate NAME means, in the words the founder would use.
 *
 * The brief used to print a bare gate label — "Sponsor" — followed by register
 * prose, and the founder's question was literally "what is this? sponsor?".
 * A label nobody defined is not information. These strings are the definition,
 * printed once per brief in the legend.
 */
export const GATE_GLOSSARY: Readonly<Record<string, string>> = {
  Sponsor:
    "Is this employer on the IND recognised-sponsor register? Only a recognised " +
    "sponsor can hire you on a highly skilled migrant permit.",
  Basis:
    "Which permit or contract makes this role lawful for you at all — sponsored " +
    "relocation, partner permit, or a remote contract from India.",
  Salary:
    "Does the pay clear the permit's legal floor (€4,357/month base, under-30 band)? " +
    "Below it the permit cannot be issued, however much they want you.",
  Rate: "Is the day rate or salary worth taking on a remote contract, where no permit floor applies.",
  Language: "Does the posting require Dutch. If it does, you cannot be shortlisted.",
  Experience: "How many years the posting explicitly demands, versus your ~3.5 years shipped.",
  Location:
    "Does the ad say where the work actually sits. Until it does, every permit "  +
    "basis below is an assumption rather than a finding.",
  Posting: "Whether we actually received enough of the job ad to judge it.",
};

/** The mark that precedes a gate line. Status is the ONLY input. */
export function gateMark(status: ScreenStatus): string {
  return status === "pass" ? "✅" : status === "flag" ? "❓" : "⛔";
}

/** "cleared" / "needs an answer" / "blocked" — the status in plain English. */
export function gateVerdictWord(status: ScreenStatus): string {
  return status === "pass" ? "cleared" : status === "flag" ? "needs an answer" : "blocked";
}
