/**
 * Single QA entrypoint. Delegates to the existing real-path harnesses by mode so
 * there is one command to remember instead of three overlapping scripts.
 *
 *   pnpm tsx scripts/qa.ts suite     → full founder-simulation (e2e-telegram-qa.ts)
 *   pnpm tsx scripts/qa.ts send <t>  → single send/approve (telegram-tester.ts)
 *   pnpm tsx scripts/qa.ts probe <t> → office-level probe (probe-real-task.ts)
 */
import { spawnSync } from "node:child_process";

const [, , mode, ...rest] = process.argv;

const map: Record<string, string> = {
  suite: "scripts/e2e-telegram-qa.ts",
  send: "scripts/telegram-tester.ts",
  probe: "scripts/probe-real-task.ts",
};

const target = map[mode ?? ""];
if (!target) {
  console.error(`Usage: tsx scripts/qa.ts <suite|send|probe> [args]\nGot: ${mode ?? "(none)"}`);
  process.exit(1);
}

const r = spawnSync("npx", ["tsx", target, ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
