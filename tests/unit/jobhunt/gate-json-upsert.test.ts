/**
 * Regression — `gate_json` survives the SECOND sighting of a posting.
 *
 * Found live on 2026-08-01, not by a test. A backfill re-screened all 53 stored
 * rows, reported every new verdict correctly, and left `gate_json` NULL on every
 * single one. `recordScreenedApplication` upserts, and the new column had been
 * added to the INSERT values but not to the `onConflictDoUpdate` SET clause — so
 * it was written only for a posting the pipeline had never seen before.
 *
 * That is the worst shape of bug this codebase keeps producing: it works on the
 * happy path, fails silently on the common one, and the failure surfaces as the
 * brief saying "we cannot say which check passed" about rows that had just been
 * screened seconds earlier.
 *
 * The daily sweep re-sees the same postings constantly (`timeRange: 24h` over a
 * market that turns over slowly), so the conflict branch is the NORMAL path, not
 * the exception.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync("src/db/job-queries.ts", "utf8");

/** The `set: { … }` body of the upsert in `recordScreenedApplication`. */
function upsertSetBlock(): string {
  const fn = SOURCE.slice(SOURCE.indexOf("export async function recordScreenedApplication"));
  const start = fn.indexOf("set: {");
  const end = fn.indexOf("})", start);
  expect(start).toBeGreaterThan(-1);
  return fn.slice(start, end);
}

describe("recordScreenedApplication upsert", () => {
  it("updates gate_json on conflict, not only on insert", () => {
    expect(upsertSetBlock()).toContain("gate_json:");
  });

  it("updates every screening-verdict column on conflict", () => {
    // A re-screen that refreshes the verdict but not its evidence would leave
    // the two disagreeing, which is worse than either being stale alone.
    const set = upsertSetBlock();
    for (const column of ["salary_status", "salary_evidence", "gate_json", "sponsor_verdict"]) {
      expect(set, `${column} missing from the upsert SET`).toContain(`${column}:`);
    }
  });

  it("does NOT reset stage on conflict — an application in flight is not re-screened", () => {
    // The guarantee that must survive every future column added here.
    expect(upsertSetBlock()).not.toContain("stage:");
  });
});
