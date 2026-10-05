/**
 * CI guard for the real-database integration suites (tests/integration).
 *
 * Every DB suite there skips itself when DATABASE_URL is unreachable, and vitest exits 0 on an
 * all-skipped run, so a broken service container would look green. This reads vitest's JSON report
 * and fails on: no tests, a failed test, a skipped/todo test, or a file that did not pass.
 *
 * Usage: node --import tsx/esm scripts/check-integration-report.ts <report.json>
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface VitestJsonReport {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: Array<{ name?: string; status?: string }>;
}

export interface ReportVerdict {
  ok: boolean;
  problems: string[];
}

export function checkIntegrationReport(report: VitestJsonReport): ReportVerdict {
  const problems: string[] = [];
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);

  if (passed === 0) problems.push("no integration test passed: the run was empty or all skipped");
  if (failed > 0) problems.push(`${failed} integration test(s) failed`);
  if (skipped > 0) {
    problems.push(`${skipped} integration test(s) skipped or todo: the database was probably unreachable`);
  }
  for (const file of report.testResults ?? []) {
    if (file.status !== "passed") problems.push(`${file.name ?? "unknown file"}: status ${file.status ?? "missing"}`);
  }
  return { ok: problems.length === 0, problems };
}

function main(path: string | undefined): number {
  if (!path) {
    console.error("usage: check-integration-report.ts <vitest-json-report>");
    return 2;
  }
  const report = JSON.parse(readFileSync(path, "utf8")) as VitestJsonReport;
  const verdict = checkIntegrationReport(report);
  if (!verdict.ok) {
    for (const p of verdict.problems) console.error(`❌ ${p}`);
    return 1;
  }
  console.log(`✅ integration: ${report.numPassedTests} passed, 0 skipped, 0 failed`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv[2]));
}
