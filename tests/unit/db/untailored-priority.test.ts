/**
 * `listUntailoredApplications` picks the CV-tailoring worker's limited batch.
 * Before T1c (2026-08-25) it ordered by `created_at` alone — the worker had
 * zero callers, so nothing noticed that "most recently screened" is not
 * "what the founder's apply queue will show him today". Wiring it into the
 * scheduler (T1c) makes that mismatch live: a batch of 10 could spend the
 * whole budget on rows outside `do_today`/`stretch` while the actual queue
 * (mac-client/mac_client/sync.py QUEUE_SQL) stayed untailored.
 *
 * These assertions run against the generated SQL, so they need no database —
 * same pattern as tests/unit/db/apply-queue-freshness.test.ts.
 */

import { describe, it, expect } from "vitest";

const { untailoredPrioritySql } = await import("../../../src/db/job-queries.js");

type Chunk = { value?: unknown; name?: string };

const chunksOf = (fragment: { queryChunks: readonly unknown[] }): readonly unknown[] =>
  fragment.queryChunks;

function sqlTextOf(fragment: { queryChunks: readonly unknown[] }): string {
  return chunksOf(fragment)
    .flatMap((chunk) => {
      const value = (chunk as Chunk)?.value;
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    })
    .join("");
}

function columnNamesOf(fragment: { queryChunks: readonly unknown[] }): string[] {
  return chunksOf(fragment)
    .map((chunk) => (chunk as Chunk)?.name)
    .filter((name): name is string => typeof name === "string");
}

describe("untailoredPrioritySql", () => {
  it("ranks brief_section against the same two values the Mac apply queue reads", () => {
    const text = sqlTextOf(untailoredPrioritySql());
    expect(text).toContain("do_today");
    expect(text).toContain("stretch");
  });

  it("keys off the brief_section column", () => {
    expect(columnNamesOf(untailoredPrioritySql())).toContain("brief_section");
  });

  it("is a CASE expression, not a filter — unranked rows still get processed, just last", () => {
    // A WHERE-clause filter would drop rows outside do_today/stretch entirely,
    // and a freshly-screened row with no brief_section yet (buildDailyBrief
    // has not run since) would never get tailored at all. CASE only reorders.
    expect(sqlTextOf(untailoredPrioritySql())).toContain("CASE");
  });
});
