/**
 * Zero-pass streak policy: WHEN the funnel alert fires and what it says.
 *
 * Pure. Split out of sweep-heartbeat.ts, which is at the file-size limit.
 *
 * Weekends are quiet. Measured: weekday volume is 58-86 new roles a day, weekend
 * 12-38. On 2026-11-15 (Sunday) six sweeps in a row screened 0 with every board
 * fetched, no failures and ~80k postings seen, and the alert said the funnel
 * "may be restricted or closed". The next two sweeps passed 1 and 2.
 *
 * The weekend rule RAISES the threshold, it never suppresses. A suppressed alert
 * is a deleted alert (see afterQuietSweep: the guard fires once per streak), and
 * a real fault on a Saturday must still reach the founder.
 */

import type { FreeFunnel } from "./free-ingest.js";

/** Consecutive 0-pass sweeps (30 min each) before the alert on a weekday. */
export const ZERO_PASS_STREAK_THRESHOLD = 6;
/** Same, on Saturday/Sunday Amsterdam time: 18 sweeps = 9 h. */
export const WEEKEND_ZERO_PASS_STREAK_THRESHOLD = ZERO_PASS_STREAK_THRESHOLD * 3;

/** Closing stages that mean a bug, not a quiet market. */
const STRUCTURAL_STAGES = new Set(["no body description", "undated publication"]);

export function isWeekendInAmsterdam(now: Date): boolean {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", weekday: "short" }).format(now);
  return day === "Sat" || day === "Sun";
}

/** Boards fetched cleanly: known only when the sweep reported a failure count. */
export function boardsHealthy(funnel: FreeFunnel | null | undefined, closingReason?: string): boolean {
  return funnel?.boardFailures === 0 && funnel.seen > 0 && !(closingReason && STRUCTURAL_STAGES.has(closingReason));
}

/** A real fault: failure count unknown (older snapshot), a board failed, nothing was seen, or the last gate is structural. */
export function sweepShowsFault(funnel: FreeFunnel | null | undefined, closingReason: string | undefined): boolean {
  if (!funnel) return true; // unknown is never read as healthy
  if (funnel.boardFailures === undefined || funnel.boardFailures > 0 || funnel.seen === 0) return true;
  return closingReason !== undefined && STRUCTURAL_STAGES.has(closingReason);
}

export function zeroPassThreshold(now: Date, funnel: FreeFunnel | null | undefined, closingReason?: string): number {
  return isWeekendInAmsterdam(now) && !sweepShowsFault(funnel, closingReason)
    ? WEEKEND_ZERO_PASS_STREAK_THRESHOLD
    : ZERO_PASS_STREAK_THRESHOLD;
}

/** The alert line. Healthy boards read as a quiet period, never as "restricted or closed". */
export function formatZeroPassAlert(
  streak: number,
  funnel: FreeFunnel | null | undefined,
  top: { reason: string; count: number } | null,
  who: string,
): string {
  if (boardsHealthy(funnel, top?.reason)) {
    const hours = streak / 2;
    return `ℹ️ <b>Quiet${who}</b>: 0 new roles passed in the last ${streak} sweeps (${hours}h). Boards are fine.`;
  }
  const dropClause = top ? ` (the last ${top.count} died at: ${top.reason})` : "";
  // A dedup-only streak does not support "restricted or closed", but is not proof
  // of health either: a frozen board cache looks the same. The alert still fires.
  const diagnosis =
    top?.reason === "already known in tracker"
      ? "No NEW postings reached screening — either the market is flat or board fetches are serving stale data."
      : "The funnel may be restricted or closed.";
  return (
    `⚠ <b>Job lane funnel alert${who}</b> — 0 candidates passed for ${streak} consecutive sweeps` +
    `${dropClause}. ${diagnosis}`
  );
}
