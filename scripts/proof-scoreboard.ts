/**
 * FounderOS v3 — proof scoreboard generator.
 * Runs the deterministic suite fresh (evidence, not stale claims), reads the
 * architecture-debt baseline, and writes docs/PROOF.md.
 * Usage: pnpm proof:scoreboard
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { renderScoreboard } from "../src/proof/render.js";

const KERNEL_GUARANTEES = [
  "A greeting costs exactly 1 LLM call (direct-reply path) — `kernel-e2e: hello-world`",
  "Routing is a validated typed Plan, produced once — `kernel-e2e: route override / garbage planner`",
  "Every tool execution emits a code-recorded receipt; unproven action claims are rejected — `kernel-e2e: fabricated action`",
  "Tool budgets TERMINATE loops with a typed failure; the thread is never wiped — `kernel-e2e: loop scenario (audit Run-D)`",
  "HITL reject = typed hitl_rejected, side effect provably not executed — `kernel-e2e: HITL reject`",
  "Identical inputs → byte-identical plans — `kernel-e2e: determinism`",
];

function main(): void {
  // Fresh run — rule #24: stale evidence is not evidence. JSON goes to a file
  // so test-log noise on stdout can't corrupt it.
  const reportPath = ".vitest-report.json";
  execFileSync(
    "./node_modules/.bin/vitest",
    ["run", "--reporter=json", `--outputFile=${reportPath}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "ignore", "inherit"] },
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    numTotalTests: number;
    numFailedTests: number;
    testResults: unknown[];
  };

  const baseline = JSON.parse(readFileSync("governance/architecture-baseline.json", "utf8")) as Record<string, number>;
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();

  const md = renderScoreboard({
    generatedAt: new Date().toISOString(),
    commit,
    suite: { files: report.testResults.length, tests: report.numTotalTests, failed: report.numFailedTests },
    kernelScenarios: KERNEL_GUARANTEES,
    archBaseline: baseline,
  });
  writeFileSync("docs/PROOF.md", md);
  console.log(md);
  console.log("\nWritten to docs/PROOF.md");
  if (report.numFailedTests > 0) process.exit(1);
}

main();
