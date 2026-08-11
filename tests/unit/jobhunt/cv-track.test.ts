/**
 * Unit tests — per-track CV workspaces.
 *
 * One CV cannot serve three tracks: measured against the AI market, a frontend
 * CV reads as a wall of gaps, and every one of them is a false finding.
 *
 * The rule that matters most is the one about what must NOT happen — there is no
 * fallback from one track to another. A frontend gap report computed against the
 * AI CV would invent gaps and hide real ones at the same time, and would look
 * completely normal in the output.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLAUSIBLE_CV = "Senior engineer. ".repeat(80);

let dir: string;
let originalDir: string | undefined;
let originalPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cv-track-"));
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

/** career.ts reads the env at module load, so each case needs a fresh module. */
async function loadCareer(cvDir: string, cvPath: string) {
  process.env["PERSONAL_CV_DIR"] = cvDir;
  process.env["PERSONAL_CV_PATH"] = cvPath;
  vi.resetModules();
  return import("../../../src/tools/career.js");
}

function writeTrackCv(root: string, track: string, body: string): string {
  mkdirSync(join(root, track), { recursive: true });
  const path = join(root, track, "cv.md");
  writeFileSync(path, body, "utf-8");
  return path;
}

describe("cvPathsForTrack", () => {
  it("prefers the track workspace and keeps the master as fallback", async () => {
    const master = join(dir, "cv-master.md");
    const { cvPathsForTrack } = await loadCareer(join(dir, "cv"), master);
    const paths = cvPathsForTrack("frontend");
    expect(paths[0]).toBe(join(dir, "cv", "frontend", "cv.md"));
    expect(paths[1]).toBe(master);
  });

  it("never offers another track's CV as a candidate", async () => {
    const { cvPathsForTrack } = await loadCareer(join(dir, "cv"), join(dir, "cv-master.md"));
    const paths = cvPathsForTrack("frontend");
    expect(paths.some((p) => p.includes("/ai/") || p.includes("/backend/"))).toBe(false);
  });

  it("uses only the master for an unclassified posting", async () => {
    const master = join(dir, "cv-master.md");
    const { cvPathsForTrack } = await loadCareer(join(dir, "cv"), master);
    expect(cvPathsForTrack("unclassified")).toEqual([master]);
    expect(cvPathsForTrack()).toEqual([master]);
  });
});

describe("readFullCvText(track)", () => {
  it("reads the track's own CV and reports which file it used", async () => {
    const root = join(dir, "cv");
    const path = writeTrackCv(root, "backend", `${PLAUSIBLE_CV} Go and PostgreSQL.`);
    const { readFullCvText } = await loadCareer(root, join(dir, "cv-master.md"));

    const result = readFullCvText("backend");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("Go and PostgreSQL");
      // The path is reported because "which CV was this?" is a real question
      // once three exist, and a silent fallback answers it wrongly.
      expect(result.path).toBe(path);
    }
  });

  it("falls back to the shared master when the track file does not exist yet", async () => {
    const master = join(dir, "cv-master.md");
    writeFileSync(master, PLAUSIBLE_CV, "utf-8");
    const { readFullCvText } = await loadCareer(join(dir, "cv"), master);

    const result = readFullCvText("frontend");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(master);
  });

  it("does NOT fall through to the master when the track file is too thin", async () => {
    // Falling through would answer a question about the frontend CV using the
    // master, then report the answer as though it were the frontend CV's.
    const root = join(dir, "cv");
    writeTrackCv(root, "frontend", "TODO");
    const master = join(dir, "cv-master.md");
    writeFileSync(master, PLAUSIBLE_CV, "utf-8");
    const { readFullCvText } = await loadCareer(root, master);

    const result = readFullCvText("frontend");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("frontend");
  });

  it("fails loudly listing every path tried, and never substitutes the wiki", async () => {
    const { readFullCvText } = await loadCareer(join(dir, "cv"), join(dir, "nope.md"));
    const result = readFullCvText("ai");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ai");
      expect(result.error).toContain("nope.md");
      expect(result.error).toContain("wiki is NOT an acceptable substitute");
    }
  });
});
