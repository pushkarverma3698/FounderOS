#!/usr/bin/env node
/**
 * FounderOS — Daily QA Master Suite
 * Runs regression then stress in sequence. Use before beta→main promotion.
 *
 * Usage:
 *   pnpm qa:daily
 *   pnpm qa:daily -- --skip-live
 *   pnpm qa:daily -- --stress-quick
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const SKIP_LIVE = args.includes("--skip-live");
const STRESS_QUICK = args.includes("--stress-quick");
const SKIP_INTEGRATION = args.includes("--skip-integration");

function run(label: string, cmd: string): number {
  console.log(`\n${"=".repeat(72)}\n▶ ${label}\n${"=".repeat(72)}\n`);
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  return result.status ?? 1;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const regressionFlags = [
    SKIP_LIVE ? "--skip-live" : "",
    SKIP_INTEGRATION ? "--skip-integration" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const regressionExit = run(
    "DAILY REGRESSION",
    `node --env-file=.env --import tsx/esm scripts/daily-regression.ts ${regressionFlags}`.trim(),
  );

  let stressExit = 0;
  if (!SKIP_LIVE) {
    const stressFlags = STRESS_QUICK ? "--quick" : "";
    stressExit = run(
      "DAILY STRESS",
      `ALLOW_NETWORK=1 node --env-file=.env --import tsx/esm scripts/daily-stress.ts ${stressFlags}`.trim(),
    );
  } else {
    console.log("\n⏭ Skipping stress (--skip-live)");
  }

  const ok = regressionExit === 0 && (SKIP_LIVE || stressExit === 0);
  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - t0;

  const dir = process.env["DAILY_QA_REPORT_DIR"] ?? "/tmp/founderos-qa";
  mkdirSync(dir, { recursive: true });
  const summary = {
    suite: "daily",
    startedAt,
    finishedAt,
    durationMs,
    ok,
    regressionExit,
    stressExit: SKIP_LIVE ? null : stressExit,
    flags: { skipLive: SKIP_LIVE, stressQuick: STRESS_QUICK, skipIntegration: SKIP_INTEGRATION },
  };
  writeFileSync(`${dir}/latest-daily.json`, JSON.stringify(summary, null, 2));

  console.log("\n" + "=".repeat(72));
  console.log(`DAILY SUITE — ${ok ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`Regression exit: ${regressionExit} | Stress exit: ${SKIP_LIVE ? "skipped" : stressExit}`);
  console.log(`Total: ${(durationMs / 1000).toFixed(0)}s | Report: ${dir}/latest-daily.json`);
  console.log("=".repeat(72));

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
