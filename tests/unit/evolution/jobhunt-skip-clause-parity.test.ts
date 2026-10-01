/**
 * Two branches meet here. The dead-board skip (board-health.ts) appends "| skipped N dead boards" to
 * `job_ingest_runs.error`; the daily jobhunt check (analyzers/jobhunt.ts) reads that same text back to
 * learn which platforms were failing at the fetch level. Each side was written and tested alone, so this
 * pins them together using the REAL writers: if the sweep's summary format changes, or the reader stops
 * ignoring the skip clause, the analyzer would start blaming (or clearing) the wrong platform silently.
 */

import { describe, it, expect } from "vitest";
import { failedPlatformsOf } from "../../../src/evolution/analyzers/jobhunt.js";
import { summariseFailures } from "../../../src/tools/jobhunt/free-ats-source.js";
import { appendSkippedDead } from "../../../src/tools/jobhunt/board-health.js";

const FAILURES = ["greenhouse/acme: HTTP 404", "greenhouse/beta: HTTP 404", "ashby/gamma: HTTP 500"];

describe("failedPlatformsOf reads what the sweep really writes, with and without the skip clause", () => {
  it("names the failing platforms from the summary alone", () => {
    expect([...failedPlatformsOf(summariseFailures(FAILURES))].sort()).toEqual(["ashby", "greenhouse"]);
  });

  it("names the same platforms once '| skipped N dead boards' is appended", () => {
    const written = appendSkippedDead(summariseFailures(FAILURES), 27);
    expect(written).toContain("| skipped 27 dead boards");
    expect([...failedPlatformsOf(written)].sort()).toEqual(["ashby", "greenhouse"]);
  });

  it("names nothing for a sweep that only skipped dead boards: 'skipped' is not a platform", () => {
    expect(failedPlatformsOf(appendSkippedDead("", 27)).size).toBe(0);
  });

  it("still names the platforms when the summary was truncated to '+N other pattern(s)'", () => {
    const many = Array.from({ length: 30 }, (_, i) => `lever/board${i}: HTTP 50${i}`);
    const written = appendSkippedDead(summariseFailures(many), 4);
    expect(written).toContain("other pattern(s)");
    expect([...failedPlatformsOf(written)]).toEqual(["lever"]);
  });

  it("names nothing for a sweep with no error text at all", () => {
    expect(failedPlatformsOf(null).size).toBe(0);
    expect(failedPlatformsOf("").size).toBe(0);
  });
});
