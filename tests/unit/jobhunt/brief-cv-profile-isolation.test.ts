/**
 * Regression test — brief-cv.ts must never score one profile's postings
 * against another profile's CV.
 *
 * Found live, 2026-09-04: wife-nl-finance's four tracks set no per-track
 * `cvPath`, on the (wrong) belief that `loadTrackCvs` would fall back to
 * `profile.baseCvPath` the same way tailor-cv.ts does. It does not — the
 * per-track branch in brief-cv.ts only checks `trackConfig?.cvPath`, and
 * falls through to the GLOBAL `PERSONAL_CV_DIR`/`PERSONAL_CV_PATH` env vars,
 * which are Pushkar's. Every one of her tracked rows (i.e. her whole queue)
 * would have scored gap-overlap against his CV, not hers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PUSHKAR_CV = "Pushkar's CV. ".repeat(80) + "TypeScript, LangGraph, Postgres.";
const WIFE_CV = "Tashi's CV. ".repeat(80) + "IFRS, KYC, AML, FP&A.";

let dir: string;
let originalDir: string | undefined;
let originalPath: string | undefined;
let originalCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brief-cv-isolation-"));
  originalDir = process.env["PERSONAL_CV_DIR"];
  originalPath = process.env["PERSONAL_CV_PATH"];
  originalCwd = process.cwd();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env["PERSONAL_CV_DIR"];
  else process.env["PERSONAL_CV_DIR"] = originalDir;
  if (originalPath === undefined) delete process.env["PERSONAL_CV_PATH"];
  else process.env["PERSONAL_CV_PATH"] = originalPath;
  process.chdir(originalCwd);
});

it("every wife-nl-finance track resolves to her own CV, never Pushkar's global CV_PATH", async () => {
  // Global env vars point at PUSHKAR's CV — exactly the production configuration.
  const pushkarCvDir = join(dir, "pushkar-cv");
  mkdirSync(pushkarCvDir, { recursive: true });
  const pushkarMaster = join(dir, "pushkar-cv-master.md");
  writeFileSync(pushkarMaster, PUSHKAR_CV, "utf-8");
  process.env["PERSONAL_CV_DIR"] = pushkarCvDir;
  process.env["PERSONAL_CV_PATH"] = pushkarMaster;

  // Her own CV lives at a relative path from cwd, same as baseCvPath in the profile.
  const wifeCvRelative = "mac-client/cv/cv-wife-base.md";
  mkdirSync(join(dir, "mac-client/cv"), { recursive: true });
  writeFileSync(join(dir, wifeCvRelative), WIFE_CV, "utf-8");
  process.chdir(dir);

  vi.resetModules();
  const { loadTrackCvs } = await import("../../../src/tools/jobhunt/brief-cv.js");
  const { WIFE_FINANCE_PROFILE } = await import(
    "../../../src/tools/jobhunt/profiles/wife-nl-finance.js"
  );

  const { cvs, unreadable } = loadTrackCvs(WIFE_FINANCE_PROFILE);

  expect(unreadable).toEqual([]);
  for (const trackId of WIFE_FINANCE_PROFILE.trackPriority) {
    const text = cvs.get(trackId);
    expect(text, `track ${trackId} should have resolved a CV`).toBeDefined();
    expect(text).toContain("IFRS, KYC, AML, FP&A");
    expect(text).not.toContain("TypeScript, LangGraph, Postgres");
  }
});
