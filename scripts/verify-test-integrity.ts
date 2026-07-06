/**
 * FounderOS — Test-Integrity Verification CLI (compile/CI-time gate)
 * ====================================================================
 * CLAUDE.md rule #25 / TESTING-RULES.md Rule 15: fails the build (non-zero
 * exit) when a changed test file contains a self-serving/gamed pattern —
 * a tautological assertion, a test whose only assertion is weak, an empty
 * test body, `.only` left in, an unexplained `.skip`, or a test mocking the
 * exact unit it claims to test. These are all patterns a red-green suite
 * that was never actually run red would let through silently.
 *
 *   pnpm verify:test-integrity
 *
 * Scope: only files changed vs the merge-base of origin/main (falls back to
 * HEAD~1 for local/offline runs where origin/main isn't fetchable) — this is
 * a diff gate, not a whole-repo lint, so it doesn't retroactively fail on
 * pre-existing test files.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function gitDiffTestFiles(): string[] {
  const range = resolveDiffRange();
  const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", range], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\.(test|spec)\.tsx?$/.test(l));
}

function resolveDiffRange(): string {
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], { stdio: "ignore" });
    return "origin/main...HEAD";
  } catch {
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD~1"], { stdio: "ignore" });
      return "HEAD~1...HEAD";
    } catch {
      return "HEAD"; // single-commit repo — diff against itself, i.e. nothing changed
    }
  }
}

async function main(): Promise<void> {
  const { analyzeTestSource } = await import("../src/infra/test-integrity-check.js");

  let files: string[];
  try {
    files = gitDiffTestFiles();
  } catch (err) {
    console.warn(`⚠️  Could not compute git diff (${(err as Error).message}) — skipping test-integrity check.`);
    process.exit(0);
    return;
  }

  if (files.length === 0) {
    console.log("✅ Test-integrity check: no test files changed in this diff.");
    return;
  }

  let errorCount = 0;
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // file deleted between diff and read — nothing to check
    }
    const findings = analyzeTestSource(file, source);
    for (const f of findings) {
      console.error(`❌ ${f.file}:${f.line} [${f.rule}] ${f.message}`);
      errorCount++;
    }
  }

  if (errorCount > 0) {
    console.error(
      `\nTest-integrity check FAILED: ${errorCount} violation(s) across ${files.length} changed test file(s).\n` +
        `See docs/rules/TESTING-RULES.md Rule 15 for the pattern list and the ` +
        `"// test-integrity-ignore: <reason>" escape hatch (not honored for .only).`,
    );
    process.exit(1);
  }

  console.log(`✅ Test-integrity check passed — ${files.length} changed test file(s), 0 violations.`);
}

main().catch((err) => {
  console.error("Test-integrity check crashed:", err);
  process.exit(1);
});
