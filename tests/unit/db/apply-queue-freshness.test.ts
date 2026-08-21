/**
 * Regression — the apply queue's freshness predicate must bind a DRIVER-SAFE
 * value, not a raw Date.
 *
 * MEASURED IN PRODUCTION, 2026-08-21. `freshEnough` interpolated a bare `Date`
 * into a drizzle `sql` template:
 *
 *     sql`coalesce(posted_at, created_at) >= ${cutoff}`
 *
 * A Date reaching a column comparison through `eq()`/`gte()` is fine — the
 * column tells drizzle how to serialise it. A raw `sql` template has no column
 * context, so the value went to postgres.js untyped and it threw
 *
 *     The "string" argument must be of type string or an instance of Buffer
 *     or ArrayBuffer. Received an instance of Date
 *
 * on EVERY call. Both `listActionableApplications` and
 * `countAgedOutApplications` use this predicate, so the entire brief died: for
 * 15 hours `buildDailyBrief` threw before it could rank anything, the founder's
 * queue froze on its last good ranking, and 16 Dutch recognised-sponsor roles
 * that cleared every gate were screened, stored, and never shown to him.
 *
 * The failure was near-silent by construction: `runFreeSweep` catches it and
 * logs "Ranking failed before free-lane export", then publishes anyway. A sweep
 * that screened 85 postings and ranked none looks, from Telegram, exactly like a
 * sweep that found nothing.
 *
 * These assertions run against the generated SQL, so they need no database.
 */

import { describe, it, expect } from "vitest";

const { applyQueueFreshnessSql } = await import("../../../src/db/job-queries.js");

/**
 * A drizzle `sql` fragment is a chunk list: `StringChunk`s carry the literal SQL,
 * column objects carry the identifiers, and anything else is a bound parameter.
 */
type Chunk = { value?: unknown; name?: string };

const chunksOf = (fragment: { queryChunks: readonly unknown[] }): readonly unknown[] =>
  fragment.queryChunks;

/** The literal SQL text, with parameters and identifiers removed. */
function sqlTextOf(fragment: { queryChunks: readonly unknown[] }): string {
  return chunksOf(fragment)
    .flatMap((chunk) => {
      const value = (chunk as Chunk)?.value;
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    })
    .join("");
}

/** The column identifiers the fragment references. */
function columnNamesOf(fragment: { queryChunks: readonly unknown[] }): string[] {
  return chunksOf(fragment)
    .map((chunk) => (chunk as Chunk)?.name)
    .filter((name): name is string => typeof name === "string");
}

describe("applyQueueFreshnessSql", () => {
  const cutoff = new Date("2026-08-20T12:00:00.000Z");

  it("binds NO raw Date — postgres.js cannot serialise one without column context", () => {
    // THE regression. A Date anywhere in the chunk list means the driver throws
    // and every caller of this predicate dies with it.
    expect(chunksOf(applyQueueFreshnessSql(cutoff)).some((c) => c instanceof Date)).toBe(false);
  });

  it("binds the cutoff as an ISO-8601 string", () => {
    expect(chunksOf(applyQueueFreshnessSql(cutoff))).toContain("2026-08-20T12:00:00.000Z");
  });

  it("casts the bound string to timestamptz, so the comparison is not text-vs-time", () => {
    // Without the cast Postgres would have to infer the type of an unknown
    // literal on the right of a timestamptz comparison. It usually gets that
    // right; "usually" is not a property this queue should depend on.
    expect(sqlTextOf(applyQueueFreshnessSql(cutoff))).toContain("::timestamptz");
  });

  it("still compares coalesce(posted_at, created_at), not posted_at alone", () => {
    // A bare `posted_at >= cutoff` is NULL — not true — for every row the
    // founder screened by hand, so those would vanish from his own queue the
    // moment he screened them. The coalesce is the fix for that and must
    // survive this one.
    const columns = columnNamesOf(applyQueueFreshnessSql(cutoff));
    expect(columns).toContain("posted_at");
    expect(columns).toContain("created_at");
    expect(sqlTextOf(applyQueueFreshnessSql(cutoff))).toContain("coalesce(");
  });
});
