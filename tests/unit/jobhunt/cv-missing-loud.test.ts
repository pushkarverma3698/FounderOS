/**
 * Unit tests — an unreadable CV must be visible in the brief.
 *
 * Found while configuring prod on 2026-08-01: the VPS had no CV file anywhere
 * and both PERSONAL_CV_* vars were unset. Nothing crashed. Every posting simply
 * scored `overlap 0/N`, the ranking collapsed to arbitrary order, and the brief
 * rendered as though it were a normal day.
 *
 * That is the silent direction: a confidently-ordered shortlist built from no
 * comparison at all. The founder must be told the ranking is not a ranking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDailyBrief } from "../../../src/tools/jobhunt/brief.js";

let dir: string;
let originalDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cv-missing-"));
  originalDir = process.env["PERSONAL_CV_DIR"];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env["PERSONAL_CV_DIR"];
  else process.env["PERSONAL_CV_DIR"] = originalDir;
  vi.resetModules();
});

async function loadTrackCvsWith(cvDir: string) {
  process.env["PERSONAL_CV_DIR"] = cvDir;
  process.env["PERSONAL_CV_PATH"] = join(cvDir, "nonexistent-master.md");
  vi.resetModules();
  const mod = await import("../../../src/tools/jobhunt/daily-brief.js");
  return mod.loadTrackCvs();
}

describe("loadTrackCvs", () => {
  // Derived from TRACK_PRIORITY rather than hard-coded, so adding a track does
  // not make this test fail for a reason that has nothing to do with what it
  // asserts — which is that an unreadable CV is NAMED, not swallowed.
  it("names every track whose CV it could not read", async () => {
    const { TRACK_PRIORITY } = await import("../../../src/tools/jobhunt/tracks.js");
    const { cvs, unreadable } = await loadTrackCvsWith(dir);
    expect(cvs.size).toBe(0);
    // "unclassified" joins the list: rows with no track are compared against
    // the shared master CV, so an unreadable master is equally load-bearing.
    expect(unreadable.sort()).toEqual([...TRACK_PRIORITY, "unclassified"].sort());
  });

  it("reports only the tracks that are actually missing", async () => {
    const { TRACK_PRIORITY } = await import("../../../src/tools/jobhunt/tracks.js");
    mkdirSync(join(dir, "ai"), { recursive: true });
    writeFileSync(join(dir, "ai", "cv.md"), "Senior AI engineer. ".repeat(80));
    const { cvs, unreadable } = await loadTrackCvsWith(dir);
    expect(cvs.has("ai")).toBe(true);
    expect(unreadable.sort()).toEqual(
      [...TRACK_PRIORITY.filter((t) => t !== "ai"), "unclassified"].sort(),
    );
  });
});

describe("unreadable CV in the brief", () => {
  it("is reported as an incomplete run, not hidden behind zero scores", () => {
    const out = formatDailyBrief({
      date: new Date("2026-08-01T00:00:00Z"),
      screened: 12,
      perTrack: { ai: 12 },
      rows: [],
      trends: [],
      failures: ["CV unreadable for ai, backend, frontend — every overlap score is 0."],
    });
    expect(out).toContain("INCOMPLETE RUN");
    expect(out).toContain("CV unreadable");
    expect(out).toContain("floor, not a measurement");
  });
});
