/**
 * FounderOS — what the job Sheet actually says
 * ============================================
 * Pure row building. No network, no auth, no Sheets client — so the only thing
 * that decides what the founder reads is unit-testable without a credential.
 *
 * THE SHEET REPLACED THE TELEGRAM BRIEF (2026-08-06, founder decision). That
 * raises the bar on these columns rather than lowering it: the brief could
 * explain itself in prose, and a spreadsheet cell cannot. Every column here has
 * to be legible to someone who has never read the code — no internal verdict
 * vocabulary, no bare enum values, no column whose meaning depends on knowing
 * how the gates work.
 *
 * The `#` column is the row's PINNED brief rank, not its position in this
 * sheet. `/draft 3` resolves against `brief_rank`, so if the sheet numbered its
 * own rows the two would disagree the moment a row was applied to and left the
 * queue — and the founder would draft for the wrong job.
 */

import type { JobApplication } from "../../db/schema.js";
import { parseGates } from "./gates.js";
import { routeLabel } from "./permit-routes.js";

/** Queue tab header. Order is the reading order: who, what, then why to trust it. */
export const QUEUE_HEADER = [
  "#",
  "Company",
  "Role",
  "Track",
  "Where",
  // ADDED 2026-08-21. The queue said where a role was and whether the employer
  // was a recognised sponsor, but never which permit basis was actually carrying
  // the row — and that stopped being a detail the day the partner permit became
  // "applied for, awaiting decision". A Dutch row carried only by a pending
  // permit and one carried by an HSM sponsorship are different bets, and the
  // file gave the founder no way to tell them apart.
  "Permit basis",
  "Posted",
  "Still open?",
  "Sponsor",
  "Pay",
  "Years asked",
  "Why it's here",
  "Link",
] as const;

/** Log tab header — the audit trail, rejects included. */
export const LOG_HEADER = [
  "Screened",
  "Company",
  "Role",
  "Verdict",
  "Where",
  "Why",
  "Applied",
  "Link",
] as const;

/** A spreadsheet cell. Sheets takes strings and numbers; everything else is stringified. */
export type Cell = string | number;

/**
 * Plain-English liveness.
 *
 * `unverifiable` becomes "couldn't check" rather than anything resembling
 * "closed". Reading a network failure as a dead posting removes a real
 * opportunity and emits no signal that it did — the asymmetry liveness.ts is
 * built around, carried through to the words the founder reads.
 */
export function livenessCell(liveness: string | null): string {
  switch (liveness) {
    case "live":
      return "yes — checked";
    case "expired":
      return "no — gone";
    case "unverifiable":
      return "couldn't check";
    default:
      return "not checked";
  }
}

/** Plain-English sponsor verdict. "uncertain" must not read as a yes. */
export function sponsorCell(verdict: string | null): string {
  switch (verdict) {
    case "sponsor":
      return "yes — on the IND register";
    case "uncertain":
      return "unclear — verify before applying";
    case "not-sponsor":
      return "not on the register";
    default:
      return "not checked";
  }
}

/** Whole days between a posting date and now, or "" when the date was never known. */
export function postedCell(postedAt: Date | null, now: Date): string {
  if (postedAt === null) return "date unknown";
  const days = Math.floor((now.getTime() - postedAt.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * The one-line reason, derived from the row's section and its gates.
 *
 * Mirrors `whyLine` in brief-row.ts deliberately rather than importing it: that
 * function emits Telegram HTML (`<b>`, escaped entities), which in a
 * spreadsheet cell would print the tags as literal text. Same decision table,
 * different medium.
 */
export function whyCell(row: JobApplication): string {
  const { gates, legacy } = parseGates(row);
  if (legacy) return "screened before we recorded per-check results — re-screen to be sure";
  if (row.brief_section === "stretch") {
    return "only the years are in the way — everything else cleared";
  }
  const blocking = gates.filter((g) => g.status !== "pass");
  if (blocking.length === 0) return "every check passed";
  return `${blocking.map((g) => g.gate).join(", ")} unresolved`;
}

/** The years-demanded figure, read from the Experience gate's own evidence. */
export function yearsCell(row: JobApplication): string {
  const { gates } = parseGates(row);
  const experience = gates.find((g) => g.gate.toLowerCase().startsWith("experience"));
  if (!experience) return "";
  const match = /(\d+)\s*(?:\+|or more)?\s*year/i.exec(experience.evidence ?? "");
  return match ? `${match[1]}+` : "";
}

/**
 * One Queue row.
 *
 * `brief_rank` is printed verbatim and never renumbered — see the header.
 */
export function queueRow(row: JobApplication, now: Date): Cell[] {
  return [
    row.brief_rank ?? "",
    row.company,
    row.title,
    row.track,
    row.location ?? row.country ?? "",
    // Live, not stored — see `routeLabel`. A permit basis is a fact about the
    // founder and it changes; a row screened last week must not keep asserting a
    // right to work that is now pending.
    routeLabel(row.route),
    postedCell(row.posted_at, now),
    livenessCell(row.liveness),
    sponsorCell(row.sponsor_verdict),
    row.salary_status === "pass" ? "meets the bar" : (row.salary_evidence ?? "not stated"),
    yearsCell(row),
    whyCell(row),
    row.url ?? "",
  ];
}

/** One Log row. Carries rejects — that is the point of the tab. */
export function logRow(row: JobApplication, now: Date): Cell[] {
  return [
    row.created_at ? postedCell(row.created_at, now) : "",
    row.company,
    row.title,
    row.brief_section ?? "not shortlisted",
    row.location ?? row.country ?? "",
    whyCell(row),
    row.applied_at ? "applied" : row.skipped_at ? "skipped" : "",
    row.url ?? "",
  ];
}

/** Full Queue tab payload, header included. */
export function buildQueueTab(rows: readonly JobApplication[], now: Date): Cell[][] {
  return [[...QUEUE_HEADER], ...rows.map((r) => queueRow(r, now))];
}

/** Full Log tab payload, header included. */
export function buildLogTab(rows: readonly JobApplication[], now: Date): Cell[][] {
  return [[...LOG_HEADER], ...rows.map((r) => logRow(r, now))];
}
