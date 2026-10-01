/**
 * The brief's "runs hit an ATS board error" count and the sweep's own error text must agree.
 *
 * board-health.ts writes `job_ingest_runs.error` as "<N board(s) failed: …> | skipped N dead boards"
 * (appendSkippedDead). A sweep that only SAT OUT boards known to be dead has an error text that is
 * just "skipped N dead boards": nothing failed and no posting is missing, so the daily brief must not
 * count it as a run that "hit at least one ATS board error". summariseSpend filters on
 * SKIP_ONLY_ERROR_PATTERN in SQL; this test pins that pattern to the writer, in TypeScript, so a change
 * to either side fails here instead of quietly putting "280 of 280 runs hit an error" back in the brief.
 *
 * (The SQL itself is exercised against a real Postgres by the integrator; a unit test may not mock the database.)
 */

import { describe, it, expect } from "vitest";
import { SKIP_ONLY_ERROR_PATTERN } from "../../../src/db/job-run-queries.js";
import { appendSkippedDead, splitSweepError } from "../../../src/tools/jobhunt/board-health.js";

const skipOnly = new RegExp(SKIP_ONLY_ERROR_PATTERN);

/** What the sweep really writes for one run, across the shapes the writer can produce. */
const WRITTEN_BY_THE_SWEEP: ReadonlyArray<{ readonly error: string; readonly countsAsFailure: boolean; readonly why: string }> = [
  { error: appendSkippedDead("", 27), countsAsFailure: false, why: "only skipped boards: nothing failed" },
  { error: appendSkippedDead("", 1), countsAsFailure: false, why: "a single skipped board, still the plural wording" },
  { error: appendSkippedDead("3 board(s) failed: greenhouse HTTP 404 ×2; ashby HTTP 500 ×1", 27), countsAsFailure: true, why: "real failures alongside the skips" },
  { error: "3 board(s) failed: greenhouse HTTP 404 ×2; ashby HTTP 500 ×1", countsAsFailure: true, why: "real failures, no skips" },
  { error: appendSkippedDead("1 board(s) failed: lever HTTP 429 ×1", 4), countsAsFailure: true, why: "a rate limit is a real, partial run" },
];

describe("SKIP_ONLY_ERROR_PATTERN vs what the sweep writes", () => {
  for (const { error, countsAsFailure, why } of WRITTEN_BY_THE_SWEEP) {
    it(`${countsAsFailure ? "counts" : "does NOT count"} "${error.slice(0, 60)}" (${why})`, () => {
      expect(!skipOnly.test(error)).toBe(countsAsFailure);
    });
  }

  it("agrees with splitSweepError, the reader that inverts the writer: skip-only exactly when there are no failures", () => {
    for (const { error } of WRITTEN_BY_THE_SWEEP) {
      const { failures, skippedDead } = splitSweepError(error);
      expect(skipOnly.test(error), error).toBe(failures === "" && skippedDead > 0);
    }
  });

  it("does not match text that merely mentions skipped boards, or anything unrecognised", () => {
    for (const text of ["", "skipped dead boards", "skipped 3 dead boards; and more", "the sweep skipped 3 dead boards", "board(s) failed: x"]) {
      expect(skipOnly.test(text), text).toBe(false);
    }
  });
});
