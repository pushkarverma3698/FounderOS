/**
 * FounderOS — turning a stored application into a brief row
 * ===========================================================
 * Split out of daily-brief.ts on 2026-09-01, when the standing-pool addition
 * (job-queries.ts's `listStandingApplications`) pushed that file past its
 * 400-line budget — same precedent as brief-cv.ts, brief-trends.ts and
 * brief-persist.ts before it.
 *
 * Pure: no DB, no network. Every input is already in hand by the time
 * `toBriefRow` is called; it only reshapes and derives ages.
 */

import type { OverlapResult } from "./overlap.js";
import { parseGates } from "./gates.js";
import { toPostingCountry } from "./country.js";
import type { Liveness } from "./liveness.js";
import type { BriefRow } from "./brief-row.js";
import type { JobApplication } from "../../db/schema.js";

export function ageInDays(from: Date | null | undefined, now: Date): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

/** The only values `Liveness` actually has. Anything else is not knowledge. */
const LIVENESS_VALUES: readonly string[] = ["live", "expired", "unverifiable"];

/**
 * Narrow a stored liveness string to the union, honestly.
 *
 * `row.liveness as Liveness` was an unchecked cast, and production carried
 * `"unknown"` — the column's own default — on every row. That value is outside
 * the union, so it reached the renderer and was displayed as "closed": the brief
 * announced that three live roles had shut, on the strength of a check that had
 * never run. Anything not positively one of the three collapses to
 * `unverifiable`, which is what "we don't know" is called here.
 */
export function toLiveness(value: unknown): Liveness {
  return typeof value === "string" && LIVENESS_VALUES.includes(value)
    ? (value as Liveness)
    : "unverifiable";
}

/**
 * One scored application, as the row shape the renderer consumes.
 *
 * Shared by the fresh pool and the standing pool so the two never drift in
 * what a "row" means — the only difference between them is which query and
 * which liveness map fed this function, not two independent mapping bodies.
 *
 * `liveness` is a lookup, not a value, because only the fresh pool is ever
 * re-checked in a given run (`verifyLiveness`, daily-brief.ts) — a standing
 * row has no entry in it by construction, so it falls through to its own
 * stored value, which `listStandingApplications` already guarantees is `'live'`.
 */
export function toBriefRow(
  row: JobApplication,
  overlap: OverlapResult,
  now: Date,
  liveness: ReadonlyMap<string, Liveness>,
): BriefRow {
  const { gates, legacy } = parseGates(row);
  // A row verified in THIS run was checked seconds ago; anything else is as
  // old as its stored timestamp says, and the brief must not round that to
  // "today". Null when no check has ever run against it.
  const livenessAgeDays = liveness.has(row.id)
    ? 0
    : row.liveness_checked_at
      ? ageInDays(row.liveness_checked_at, now)
      : null;
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    track: row.track,
    verdict: row.salary_status,
    route: row.route,
    // Read off the stored column, never re-derived. Rows screened before the
    // column existed carry NULL and come back `unknown`, which is the truth
    // about them — they were filed by a pipeline that recorded no country.
    country: toPostingCountry(row.country),
    location: row.location,
    url: row.url,
    overlap,
    liveness: liveness.get(row.id) ?? toLiveness(row.liveness),
    gates,
    legacyGates: legacy,
    ageDays: ageInDays(row.created_at, now),
    livenessAgeDays,
  };
}
