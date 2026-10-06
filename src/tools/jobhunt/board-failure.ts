/**
 * FounderOS — which board failures mean "this board is gone"
 * ==========================================================
 * The pure half of retiring dead boards. `board-health.ts` keeps the streaks and the file;
 * this module decides what an answer says, and words it for the log and for the founder.
 *
 * WHY IT IS NOT JUST "404" ANY MORE. Prod 2026-10-04/05: every free sweep of 3,195 boards had
 * five or six failures that never went away. BambooHR x3 answered HTML where JSON was asked for
 * (a tenant that no longer exists is redirected to a marketing page), Workday answered 422 and
 * 403, and one Greenhouse 404 and one Teamtailor 400 came and went. The record counted 404 alone,
 * so none of those was ever retired and each was asked, and reported, 48 times a day.
 *
 * PERMANENT-LOOKING: any 4xx the host means as "no" (400, 401, 403, 404, 410, 422 ...) and a 200
 * that is not JSON. NOT: 408/425/429 (the host says "later"), any 5xx, a timeout or a socket reset,
 * and our own mapper throwing. None of those says the board is gone, and retiring a live employer
 * is the failure direction nobody sees (STANDARDS.md section 4).
 *
 * THE OUTAGE GUARD. A platform that fails permanently for most of its polled boards in ONE sweep
 * is a blocked IP, a changed API or a bot wall, not a graveyard. Counting it would retire hundreds
 * of live boards in five hours and silence them for a week, which is why it is checked here and
 * those failures are not counted. Below OUTAGE_MIN_BOARDS a majority is just a few dead boards.
 */

// Types only: board-health.ts imports this module for its values, and a value import back would be a cycle.
import type { BoardHealth, BoardOutcome, BoardRef } from "./board-health.js";

/** A 4xx that asks us to come back later rather than saying the board is gone. */
export const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/** Polled boards a platform needs in one sweep before a majority of failures can read as an outage. */
export const OUTAGE_MIN_BOARDS = 20;

/** Above this share of a platform's polled boards failing permanently, the platform is the problem. */
export const OUTAGE_FAIL_SHARE = 0.5;

/** The reason a pre-2026-10-05 record entry has: those entries were written for 404s only. */
export const LEGACY_REASON = "HTTP 404";

/** The reason printed for a body that was not JSON. */
export const NOT_JSON_REASON = "HTML instead of JSON";

/** What a failed poll came back with. `kind` is set when the body was not JSON; `status` when the host answered. */
export interface FailureFacts {
  readonly status?: number;
  readonly kind?: "not-json";
}

/** One board and the plain-words reason it failed or was retired. */
export interface BoardReason {
  /** "<ats>/<token>", the form the sweep's failure strings already use. */
  readonly board: string;
  readonly reason: string;
}

/** Whether this failure says the board is gone, as opposed to the host having a bad moment. */
export function isPermanentFailure(f: FailureFacts): boolean {
  if (f.kind === "not-json") return true;
  const s = f.status;
  return s !== undefined && s >= 400 && s < 500 && !TRANSIENT_CLIENT_STATUSES.has(s);
}

/** The reason in words, or undefined when the failure is not permanent-looking. */
export function failureReason(f: FailureFacts): string | undefined {
  if (!isPermanentFailure(f)) return undefined;
  return f.kind === "not-json" ? NOT_JSON_REASON : `HTTP ${f.status}`;
}

/** Platforms where most polled boards failed permanently this sweep: an outage, so none of it counts. */
export function platformsInOutage(outcomes: readonly BoardOutcome[]): Set<string> {
  const polled = new Map<string, number>();
  const permanent = new Map<string, number>();
  for (const o of outcomes) {
    polled.set(o.board.ats, (polled.get(o.board.ats) ?? 0) + 1);
    if (!o.ok && isPermanentFailure(o)) permanent.set(o.board.ats, (permanent.get(o.board.ats) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [ats, n] of polled) {
    if (n >= OUTAGE_MIN_BOARDS && (permanent.get(ats) ?? 0) / n > OUTAGE_FAIL_SHARE) out.add(ats);
  }
  return out;
}

/** Registry boards currently retired (streak at `threshold` or past it), each with why. */
export function retiredBoards(boards: readonly BoardRef[], health: BoardHealth, threshold: number): BoardReason[] {
  const out: BoardReason[] = [];
  for (const b of boards) {
    const entry = health[`${b.ats}:${b.token}`];
    if (entry && entry.streak >= threshold) {
      out.push({ board: `${b.ats}/${b.token}`, reason: entry.reason ?? LEGACY_REASON });
    }
  }
  return out;
}

/** Every failed board with its reason, for the sweep log: the board id is what makes a failure fixable. */
export function describeFailedBoards(
  results: readonly (BoardOutcome & { readonly error?: string })[],
): BoardReason[] {
  return results
    .filter((r) => !r.ok)
    .map((r) => ({ board: `${r.board.ats}/${r.board.token}`, reason: failureReason(r) ?? r.error ?? "failed" }));
}

/**
 * The one founder-facing line: how many boards are retired and why. Empty when none are, so a
 * ping about a healthy lane stays as short as it was.
 */
export function retiredLine(retired: readonly BoardReason[] | undefined): string {
  if (!retired || retired.length === 0) return "";
  const counts = new Map<string, number>();
  for (const r of retired) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const why = [...counts].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${reason} ×${n}`);
  return `Retired ${retired.length} dead boards, no longer polled: ${why.join(", ")}.`;
}
