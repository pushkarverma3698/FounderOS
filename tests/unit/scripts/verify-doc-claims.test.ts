/**
 * Documentation claim fitness function — scripts/verify-doc-claims.ts.
 * =====================================================================
 * 2026-08-28 portfolio audit: the same quantity was stated five different ways
 * across the recruiter-facing docs (test count as 3,611 and 3,499; test files as
 * 337/331/329/321; the board registry as 623/923/297/238/200/142). Each had been
 * true when written; none were re-checked, because nothing checked them.
 *
 * These tests pin two things: the repo is currently clean, and the checker
 * actually FAILS on drift — a fitness function that can only pass is decoration.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkClaim, runChecks } from "../../../scripts/verify-doc-claims.js";

const SCRIPT = fileURLToPath(new URL("../../../scripts/verify-doc-claims.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("verify-doc-claims", () => {
  it("finds no drift in the committed recruiter-path docs", () => {
    // Arrange / Act
    const violations = runChecks();

    // Assert — the message names the offenders, so a failure here is self-diagnosing.
    expect(
      violations.map((v) => `${v.file}:${v.line} ${v.claim} doc=${v.claimed} actual=${v.actual}`),
    ).toEqual([]);
  });

  it("reports a violation when a doc claims a number that does not match the measurement", () => {
    // Arrange — a claim whose truth can never equal the doc's real value.
    const impossible = {
      name: "deliberately unsatisfiable",
      measure: () => -1,
      patterns: [/\b(\d[\d,]*) tests\b/g],
      files: ["README.md"],
    };

    // Act
    const violations = checkClaim(impossible);

    // Assert
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.actual).toBe(-1);
    expect(violations[0]?.file).toBe("README.md");
  });

  it("ignores delta notation so a '+146 tests' changelog column is not read as a claim", () => {
    // Arrange — LIMITATIONS.md's Δ column is exactly this shape and must not trip the check.
    const claim = {
      name: "test count",
      patterns: [/(?<![+\-])\b(\d[\d,]*) (?:offline behavioural |unit\/kernel )?tests\b/g],
      measure: () => 3645,
      files: ["README.md"],
    };
    const line = "| Test suite | 331 files · **3,645 tests**, offline, $0 | +146 tests |";

    // Act — run the pattern the way checkClaim does, on the real line shape.
    const pattern = claim.patterns[0];
    if (pattern === undefined) throw new Error("claim must declare a pattern");
    pattern.lastIndex = 0;
    const found: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      const raw = match[1];
      if (raw !== undefined) found.push(raw);
    }

    // Assert — 3,645 is a claim; 146 is a delta and must be skipped.
    expect(found).toEqual(["3,645"]);
  });

  it("exits non-zero and names the file when a doc drifts", () => {
    // Arrange — inject drift into a scratch copy of README, then restore it.
    const backup = join(mkdtempSync(join(tmpdir(), "doc-claims-")), "README.md");
    const readme = join(ROOT, "README.md");
    copyFileSync(readme, backup);

    try {
      // Append rather than replace a literal: the checker's whole point is that
      // hardcoded counts go stale, and this test must not have that flaw itself.
      writeFileSync(readme, `${readFileSync(readme, "utf-8")}\n9,999 tests\n`);

      // Act
      let exitCode = 0;
      let output = "";
      try {
        execFileSync("node", ["--import", "tsx/esm", SCRIPT], { cwd: ROOT, encoding: "utf-8" });
      } catch (err) {
        const e = err as { status: number; stderr: string };
        exitCode = e.status;
        output = e.stderr;
      }

      // Assert
      expect(exitCode).toBe(1);
      expect(output).toContain("README.md");
      expect(output).toContain("9,999");
    } finally {
      copyFileSync(backup, readme);
    }
  });
});
