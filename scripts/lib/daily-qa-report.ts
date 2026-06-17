/**
 * Shared helpers for daily regression / stress scripts.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StepResult {
  name: string;
  cmd: string;
  ok: boolean;
  required: boolean;
  skipped?: boolean;
  skipReason?: string;
  durationMs: number;
  detail?: string;
}

export interface DailyReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  ok: boolean;
  steps: StepResult[];
}

export function hasLiveLlmKey(): boolean {
  const openrouter = (process.env["OPENROUTER_API_KEY"] ?? "").trim();
  const google = (process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "").trim();
  return (
    (openrouter.length > 20 && !openrouter.includes("test")) ||
    (google.length > 20 && !google.includes("test"))
  );
}

export function reportPath(suite: string): string {
  const dir = process.env["DAILY_QA_REPORT_DIR"] ?? "/tmp/founderos-qa";
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${dir}/${suite}-${stamp}.json`;
}

export function writeReport(path: string, report: DailyReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  appendFileSync(
    `${dirname(path)}/latest-${report.suite}.json`,
    "", // truncate via write below
  );
  writeFileSync(`${dirname(path)}/latest-${report.suite}.json`, JSON.stringify(report, null, 2));
}

export function printSummary(report: DailyReport, savedPath?: string): void {
  console.log("\n" + "=".repeat(72));
  console.log(`${report.suite.toUpperCase()} SUMMARY — ${report.ok ? "✅ PASS" : "❌ FAIL"}`);
  console.log("=".repeat(72));
  for (const s of report.steps) {
    const mark = s.skipped ? "SKIP" : s.ok ? "PASS" : "FAIL";
    const req = s.required ? "" : " (optional)";
    console.log(`${mark} ${s.name}${req} — ${s.durationMs}ms${s.detail ? ` — ${s.detail}` : ""}`);
    if (s.skipReason) console.log(`      ↳ ${s.skipReason}`);
  }
  console.log("-".repeat(72));
  console.log(
    `Total: ${report.durationMs}ms | pass=${report.passed} fail=${report.failed} skip=${report.skipped}`,
  );
  console.log(`Report: ${savedPath ?? reportPath(report.suite)}`);
}
