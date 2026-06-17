#!/usr/bin/env node
/**
 * FounderOS — Daily Full Regression
 * ===================================
 * Run every day on beta before promoting to prod. Orchestrates all gates:
 *   DB setup → lint → wiring → unit → integration → phase verifies → live paths → health
 *
 * Usage:
 *   pnpm regression:daily
 *   pnpm regression:daily -- --skip-live     # offline half (CI / no API keys)
 *   pnpm regression:daily -- --skip-integration
 *
 * Reports: /tmp/founderos-qa/regression-<timestamp>.json
 *          /tmp/founderos-qa/latest-regression.json
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasLiveLlmKey,
  reportPath,
  writeReport,
  printSummary,
  type DailyReport,
  type StepResult,
} from "./lib/daily-qa-report.js";

function loadDotenvIfPresent(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val && !process.env[key]) process.env[key] = val;
  }
}

loadDotenvIfPresent();

const args = new Set(process.argv.slice(2));
const SKIP_LIVE = args.has("--skip-live");
const SKIP_INTEGRATION = args.has("--skip-integration");

interface StepDef {
  name: string;
  cmd: string;
  required: boolean;
  /** Skip when false and --skip-live */
  live?: boolean;
  /** Skip when --skip-integration */
  integration?: boolean;
  /** Skip when no LLM key */
  needsLlm?: boolean;
}

const STEPS: StepDef[] = [
  { name: "postgres_ping", cmd: "node --env-file=.env --import tsx/esm scripts/lib/postgres-ping.ts", required: true },
  { name: "db_setup", cmd: "pnpm run setup", required: true },
  { name: "lint", cmd: "pnpm lint", required: true },
  { name: "verify_wiring", cmd: "pnpm verify:wiring", required: true },
  { name: "unit_tests", cmd: "pnpm test", required: true },
  { name: "integration_tests", cmd: "ALLOW_NETWORK=1 pnpm test:integration", required: true, integration: true },
  { name: "verify_beta", cmd: "pnpm verify:beta", required: true },
  { name: "verify_p2", cmd: "pnpm verify:p2", required: true },
  { name: "verify_p3", cmd: "pnpm verify:p3", required: true },
  { name: "verify_p456", cmd: "pnpm verify:p456", required: true },
  { name: "live_p456", cmd: "ALLOW_NETWORK=1 pnpm verify:p456:live", required: true, live: true, needsLlm: true },
  { name: "live_p3", cmd: "ALLOW_NETWORK=1 ENGINEERING_SUBGRAPH=1 pnpm verify:p3:live", required: true, live: true, needsLlm: true },
  { name: "live_p2_interrupt", cmd: "ALLOW_NETWORK=1 ENGINEERING_SUBGRAPH=1 P2_LIVE_APPROVE=0 pnpm verify:p2:live", required: true, live: true, needsLlm: true },
  { name: "health_boot", cmd: "node --import tsx/esm scripts/daily-health-probe.ts", required: true, live: true },
];

function runStep(def: StepDef): StepResult {
  if (SKIP_INTEGRATION && def.integration) {
    return {
      name: def.name,
      cmd: def.cmd,
      ok: true,
      required: def.required,
      skipped: true,
      skipReason: "--skip-integration",
      durationMs: 0,
    };
  }
  if (SKIP_LIVE && def.live) {
    return {
      name: def.name,
      cmd: def.cmd,
      ok: true,
      required: def.required,
      skipped: true,
      skipReason: "--skip-live",
      durationMs: 0,
    };
  }
  if (def.needsLlm && !hasLiveLlmKey()) {
    return {
      name: def.name,
      cmd: def.cmd,
      ok: !def.required,
      required: def.required,
      skipped: true,
      skipReason: "no live LLM API key",
      durationMs: 0,
    };
  }

  const t0 = Date.now();
  console.log(`\n▶ ${def.name}: ${def.cmd}`);
  const result = spawnSync(def.cmd, {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const durationMs = Date.now() - t0;
  const ok = result.status === 0;
  if (!ok) console.error(`✗ ${def.name} failed (exit ${result.status})`);
  return {
    name: def.name,
    cmd: def.cmd,
    ok,
    required: def.required,
    durationMs,
    detail: ok ? "exit 0" : `exit ${result.status}`,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  console.log("FounderOS Daily Regression");
  console.log(`Started: ${startedAt}`);
  if (SKIP_LIVE) console.log("Mode: --skip-live (offline gates only)");
  if (SKIP_INTEGRATION) console.log("Mode: --skip-integration");

  const steps: StepResult[] = [];
  for (const def of STEPS) {
    const result = runStep(def);
    steps.push(result);
    if (!result.ok && result.required && !result.skipped) {
      console.error(`\n⛔ Required step failed: ${def.name} — aborting regression.`);
      break;
    }
  }

  const passed = steps.filter((s) => s.ok && !s.skipped).length;
  const failed = steps.filter((s) => !s.ok && !s.skipped).length;
  const skipped = steps.filter((s) => s.skipped).length;
  const requiredFailed = steps.some((s) => !s.ok && s.required && !s.skipped);

  const report: DailyReport = {
    suite: "regression",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    passed,
    failed,
    skipped,
    ok: !requiredFailed,
    steps,
  };

  const path = reportPath("regression");
  writeReport(path, report);
  printSummary(report, path);
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
