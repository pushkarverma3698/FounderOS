/**
 * FounderOS — one row of the brief
 * ================================
 * WHY THIS FILE EXISTS, in the founder's own words on 2026-08-01:
 *
 *   "I am still unable to get what is the brief in every company written? what is
 *    this not checked? sponsor? partially overlaps? are you a fool? I need each
 *    and every info why this is choosen, need everything in bullet points"
 *
 * He was right, and the cause was not terseness. The row printed ONE evidence
 * line, chosen by POSITION rather than by status (`reasons[0]`), so a role
 * flagged on salary was labelled with its PASSING sponsor line. The single most
 * prominent sentence on each row was, routinely, a check that had succeeded —
 * presented as the reason the role needed a decision. On top of that the labels
 * were internal vocabulary nobody had defined: "Sponsor", "partially overlaps",
 * "not checked", "9/21 skills".
 *
 * So the row is now built on three rules:
 *
 *   1. EVERY CHECK GETS A BULLET, with its own ✅ / ❓ / ⛔ mark. Nothing is
 *      summarised away, because summarising is what hid the failing gate.
 *   2. THE VERDICT LINE NAMES THE BLOCKING GATE — derived from status, never
 *      from position.
 *   3. NO UNDEFINED VOCABULARY. Every term the row uses is defined in the legend
 *      printed once at the end of the brief.
 *
 * Pure formatting: no DB, no network, no model. Every input is passed in.
 */

import { formatOverlap, type OverlapResult } from "./overlap.js";
import { countryName, type PostingCountry } from "./country.js";
import { cmd, esc, link } from "./telegram-format.js";
import { GATE_GLOSSARY, gateMark, type Gate } from "./gates.js";
import type { Liveness } from "./liveness.js";
import { routeLabel } from "./permit-routes.js";

/**
 * Which actionable section a row is being printed under.
 *
 * PASSED DOWN, NEVER DERIVED HERE. `isStretchRow` lives in brief-select.ts, and
 * importing it would close a runtime cycle — brief-row → brief-select →
 * brief-sections → brief-row — while re-deciding membership locally would
 * recreate the second notion of membership that brief-select.ts exists to
 * prevent. The caller already holds the answer: `formatDailyBrief` renders the
 * output of `selectStretch`, so it knows. This is the same shape as the
 * `command` parameter, which has been threaded down for the same reason since
 * the sections existed.
 *
 * Values match the vocabulary `persistBriefRanks` writes to `brief_section`,
 * so the printed reason and the stored row describe themselves the same way.
 */
export type BriefSection = "do_today" | "stretch" | "ask" | "standing";

export interface BriefRow {
  readonly id: string;
  readonly company: string;
  readonly title: string;
  readonly track: string;
  readonly verdict: string;
  readonly route: string;
  /** NL | IN | other | unknown — which market block this row belongs in. */
  readonly country: PostingCountry;
  /** The feed's location string, when it gave one. Printed so the market is checkable. */
  readonly location?: string | null;
  readonly url: string | null;
  readonly overlap: OverlapResult;
  readonly liveness: Liveness;
  /** Every check with its own status — the reason this row reads as it does. */
  readonly gates: readonly Gate[];
  /** True when the gates were reconstructed from a pre-gate_json row. */
  readonly legacyGates: boolean;
  /** Days since it was screened and left untouched. */
  readonly ageDays: number;
  /**
   * Days since the still-open check last ran, or null when it never has.
   *
   * Carried separately from `liveness` because the VALUE and its AGE are
   * different claims. A stored "live" from four days ago is not "we checked
   * today", and the first version of this row said exactly that about rows the
   * run had skipped entirely.
   */
  readonly livenessAgeDays?: number | null;
}

/** Longest single evidence line before it is trimmed at a sentence boundary. */
const EVIDENCE_MAX = 240;

/**
 * Trim to the last COMPLETE sentence that fits, falling back to a word boundary.
 *
 * A hard character cut ends a decision line mid-word ("…They c"), which reads as
 * a rendering bug and drops whatever the gate was about to qualify. Ending early
 * but cleanly costs a clause and keeps the line credible.
 */
export function trimToSentence(text: string, max: number = EVIDENCE_MAX): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const lastStop = window.lastIndexOf(". ");
  if (lastStop > max / 2) return window.slice(0, lastStop + 1);
  const lastSpace = window.lastIndexOf(" ");
  return `${(lastSpace > 0 ? window.slice(0, lastSpace) : window).trimEnd()}…`;
}

/**
 * The liveness line, in words rather than a status token.
 *
 * Exhaustive on purpose. An `else` here once turned every UNCHECKED row into
 * "✕ closed" — a confident claim that a job had shut, made about a posting
 * nobody had looked at. Anything not positively verified says so as an absence
 * of knowledge, and says what to do about it.
 */
export function livenessLine(liveness: Liveness, ageDays?: number | null): string {
  if (liveness === "expired") return "⛔ Closed — the posting is gone from the employer's site.";
  if (liveness !== "live") {
    return (
      "❓ Still open? — not checked. We could not reach the posting to confirm it. " +
      "Open the link before you spend an hour on this one."
    );
  }

  // The age is stated because a four-day-old "live" is a different fact from a
  // check that ran this morning, and only one of them is worth trusting before
  // spending an hour on a cover letter.
  const when =
    ageDays === null || ageDays === undefined
      ? "when we last checked"
      : ageDays === 0
        ? "as of this morning's check"
        : `as of ${ageDays === 1 ? "yesterday's" : `${ageDays}-day-old`} check`;
  return `✅ Confirmed still open — ${when}.`;
}

/**
 * The one-line answer to "why is this company here?".
 *
 * Derived from STATUS. The old headline took `reasons[0]` and was therefore
 * wrong whenever gate #1 happened to pass, which was most of the time.
 *
 * AND FROM THE SECTION, since 2026-08-06. Status alone was not enough: a
 * stretch row is a `flag` like an ASK row is, so it inherited ASK's sentence —
 * "Experience — everything else cleared. One answer settles it." — and printed
 * it two lines under a header that says "Nothing here needs a question first".
 * The message contradicted itself, and the half the founder would have acted on
 * was the half telling him to send the one question that invites a pre-emptive
 * rejection on the years bar. Two rows with identical gates belong to different
 * sections and owe the founder different sentences; only the caller knows
 * which, so only the caller can say.
 */
export function whyLine(row: BriefRow, section: BriefSection): string {
  if (row.legacyGates) {
    return (
      "⚠️ <b>Why it's here:</b> screened before we started recording per-check " +
      "results, so we cannot say which check passed. Treat every line below as " +
      "unconfirmed."
    );
  }

  const blocking = row.gates.filter((g) => g.status === row.verdict);

  if (row.verdict === "pass") {
    return section === "standing"
      ? `✅ <b>Why it's here:</b> every check cleared, same bar as APPLY TODAY — this one is older ` +
        `than today's fresh window, but we checked again and it is still accepting applications.`
      : `✅ <b>Why it's here:</b> every check below cleared. Nothing is blocking an application.`;
  }
  if (blocking.length === 0) {
    return `❓ <b>Why it's here:</b> the verdict is "${esc(row.verdict)}" but no check explains it — that is our bug, not the employer's.`;
  }

  // AFTER the three branches above, deliberately. A stretch row that predates
  // the gate record still owes the founder its "we cannot say which check
  // passed" warning, and one whose verdict no check explains still owes him
  // that admission. The section changes the wording of a KNOWN reason; it never
  // suppresses a doubt.
  //
  // The years figure is not read back out of the gate evidence. Deriving
  // anything from prose is the defect gates.ts was written to close, and the
  // number is already printed verbatim on the Experience bullet directly below
  // — so this line states the shape and points at it.
  if (section === "stretch") {
    return (
      "🪜 <b>Why it's here:</b> the years are the only thing in the way — they " +
      "ask for more than your ~3.5 shipped, and every other check cleared. " +
      "Worth applying to anyway; the Experience line below has their exact words."
    );
  }

  const names = blocking.map((g) => g.gate).join(" and ");
  return row.verdict === "reject"
    ? `⛔ <b>Why it's here:</b> ${esc(names)} is blocking. Nothing you write changes it.`
    : `❓ <b>Why it's here:</b> ${esc(names)} — everything else cleared. One answer settles it.`;
}

/** Every check as its own bullet, mark first, so the failing one is unmissable. */
export function gateLines(gates: readonly Gate[]): string {
  if (gates.length === 0) {
    return "    • <i>No checks recorded for this row — do not trust the verdict.</i>";
  }
  return gates
    .map((g) => `    ${gateMark(g.status)} <b>${esc(g.gate)}:</b> ${esc(trimToSentence(g.evidence))}`)
    .join("\n");
}

/** The CV-overlap line, spelled out rather than left as "9/21 skills". */
export function skillsLine(overlap: OverlapResult): string {
  if (overlap.asked === 0) {
    return (
      "    📄 <b>Your CV vs this ad:</b> the ad names no recognisable technology, " +
      "so there was nothing to compare. Read it yourself before deciding."
    );
  }
  const have =
    overlap.matched.length > 0
      ? `You already have: ${esc(overlap.matched.slice(0, 6).join(", "))}.`
      : "None of them are on your CV.";
  const lack =
    overlap.missing.length > 0
      ? ` Not on your CV: ${esc(overlap.missing.slice(0, 5).join(", "))}.`
      : " Nothing they asked for is missing.";
  return (
    `    📄 <b>Your CV vs this ad:</b> ${esc(formatOverlap(overlap))} of the ` +
    `technologies they name. ${have}${lack}`
  );
}

/**
 * One row, in the order a person actually decides in.
 *
 * WHO it is with · WHY it is on the list · WHAT each check said · HOW the CV
 * compares · WHETHER it is still open · WHAT to do. The command is last because
 * it is what the eye should stop on, and the brief's whole purpose is to end in
 * an action.
 */
export function renderRow(
  row: BriefRow,
  index: number,
  command: string | null,
  section: BriefSection,
): string {
  const heading = `<b>${index}. ${esc(row.company)}</b> — ${link(row.title, row.url)}`;
  // The place comes first because it is what decides whether any of the rest
  // applies. The feed's own string is quoted where there is one, so the market
  // this row was filed under is checkable rather than asserted.
  const where = row.location?.trim() ? row.location.trim() : countryName(row.country);
  // `routeLabel`, not the raw stored `route`: a permit basis is a fact about the
  // founder and it changes (the partner permit is applied for and pending as of
  // 2026-08-21). Rendering it live corrects the whole queue the moment the fact
  // changes, instead of leaving already-screened rows asserting a settled right
  // to work for the 24 hours it takes them to age out.
  const meta =
    `    <i>${esc(where)} · ${esc(row.track)} track · basis: ${esc(routeLabel(row.route))} · ` +
    `seen ${row.ageDays === 0 ? "today" : `${row.ageDays}d ago`}</i>`;
  // /applied shares do_today/stretch/standing's numbering (handleApplied
  // resolves against the same sections `/draft` does) — printing it next to an
  // ASK row would show a command that resolves a DIFFERENT row under the same
  // number, since ASK numbers its own section independently.
  const action = command
    ? `\n    ▸ ${cmd(`${command} ${index}`)}` +
      (section === "do_today" || section === "stretch" || section === "standing"
        ? ` · ${cmd(`/applied ${index}`)}`
        : "")
    : "";

  return (
    `${heading}\n` +
    `${meta}\n` +
    `    ${whyLine(row, section)}\n` +
    `${gateLines(row.gates)}\n` +
    `${skillsLine(row.overlap)}\n` +
    `    ${livenessLine(row.liveness, row.livenessAgeDays)}${action}`
  );
}

/**
 * The legend, printed once per brief.
 *
 * Only for gates that actually appear in today's rows: a definition of "Rate"
 * on a day with no contract roles is noise, and a legend nobody reads defines
 * nothing. The founder's question was "what is this? sponsor?" — that question
 * has an answer, and it belongs in the message that raised it.
 */
export function renderLegend(rows: readonly BriefRow[]): string {
  const present = new Set(rows.flatMap((r) => r.gates.map((g) => g.gate)));
  const defined = Object.entries(GATE_GLOSSARY).filter(([gate]) => present.has(gate));
  if (defined.length === 0) return "";

  return (
    `<b>📖 WHAT THE CHECKS MEAN</b>\n` +
    defined.map(([gate, meaning]) => `• <b>${esc(gate)}</b> — ${esc(meaning)}`).join("\n") +
    `\n\n<i>✅ cleared · ❓ needs an answer · ⛔ blocked. ` +
    `A company that "partially overlaps the register" has a name resembling one or more ` +
    `recognised sponsors without matching any exactly — a wrong guess there wastes a ` +
    `whole application, so it asks you instead of choosing.</i>`
  );
}
