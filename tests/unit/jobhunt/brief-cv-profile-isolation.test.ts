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
 *
 * cvPath was later moved from a relative, git-tree path (`mac-client/cv/...`,
 * wiped on every deploy — /opt/founderos is replaced wholesale) to the
 * persistent `/opt/founderos-data/cv/...` Pushkar's own CVs already live
 * under. That path only exists on the VPS, so the mechanism is proven here
 * against a synthetic profile pointed at a temp file; the real profile's
 * literal path is checked separately, with no filesystem needed.
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brief-cv-isolation-"));
  originalDir = process.env["PERSONAL_CV_DIR"];
  originalPath = process.env["PERSONAL_CV_PATH"];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env["PERSONAL_CV_DIR"];
  else process.env["PERSONAL_CV_DIR"] = originalDir;
  if (originalPath === undefined) delete process.env["PERSONAL_CV_PATH"];
  else process.env["PERSONAL_CV_PATH"] = originalPath;
});

it("every wife-nl-finance track's cvPath is the persistent VPS path, not the deploy-wiped git tree", async () => {
  const { WIFE_FINANCE_PROFILE } = await import(
    "../../../src/tools/jobhunt/profiles/wife-nl-finance.js"
  );
  for (const trackId of WIFE_FINANCE_PROFILE.trackPriority) {
    const cvPath = WIFE_FINANCE_PROFILE.tracks[trackId]?.cvPath;
    expect(cvPath, `track ${trackId} should set cvPath`).toBe("/opt/founderos-data/cv/cv-wife-base.md");
  }
  expect(WIFE_FINANCE_PROFILE.baseCvPath).toBe("/opt/founderos-data/cv/cv-wife-base.md");
});

it("loadTrackCvs resolves every track to its own profile's cvPath, never Pushkar's global CV_PATH", async () => {
  // Global env vars point at PUSHKAR's CV — exactly the production configuration.
  const pushkarCvDir = join(dir, "pushkar-cv");
  mkdirSync(pushkarCvDir, { recursive: true });
  const pushkarMaster = join(dir, "pushkar-cv-master.md");
  writeFileSync(pushkarMaster, PUSHKAR_CV, "utf-8");
  process.env["PERSONAL_CV_DIR"] = pushkarCvDir;
  process.env["PERSONAL_CV_PATH"] = pushkarMaster;

  const wifeCvPath = join(dir, "cv-wife-base.md");
  writeFileSync(wifeCvPath, WIFE_CV, "utf-8");

  vi.resetModules();
  const { loadTrackCvs } = await import("../../../src/tools/jobhunt/brief-cv.js");
  const { WIFE_FINANCE_PROFILE } = await import(
    "../../../src/tools/jobhunt/profiles/wife-nl-finance.js"
  );

  // A synthetic copy pointed at the temp file — same shape the real profile
  // has in production (every track's cvPath === baseCvPath, her one real CV),
  // just resolvable without /opt/founderos-data existing on this machine.
  const testProfile = {
    ...WIFE_FINANCE_PROFILE,
    baseCvPath: wifeCvPath,
    tracks: Object.fromEntries(
      Object.entries(WIFE_FINANCE_PROFILE.tracks).map(([id, track]) => [
        id,
        { ...track, cvPath: wifeCvPath },
      ]),
    ),
  };

  const { cvs, unreadable } = loadTrackCvs(testProfile);

  expect(unreadable).toEqual([]);
  for (const trackId of testProfile.trackPriority) {
    const text = cvs.get(trackId);
    expect(text, `track ${trackId} should have resolved a CV`).toBeDefined();
    expect(text).toContain("IFRS, KYC, AML, FP&A");
    expect(text).not.toContain("TypeScript, LangGraph, Postgres");
  }
});
