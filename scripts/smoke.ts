/**
 * FounderOS — Boot Smoke Check
 * =============================
 * A fast, deploy-time guard that runs the deterministic boot validation against
 * whatever environment is actually present, then points at the live MTProto
 * harness for the parts that need a real Telegram round-trip.
 *
 *   pnpm test:smoke
 *
 * Behaviour (honest by design — no false green, no crash):
 *   - No live env (fresh CI / VM, no .env) → SKIP, exit 0.
 *   - Env present but a FATAL misconfig (dead LLM provider, bad DB/Telegram) →
 *     FAIL, exit 1. This is the offline half of the real-path smoke and it runs.
 *   - Env present and valid → PASS the offline checks, exit 0, and print the
 *     exact command for the live Telegram round-trip (which needs an MTProto
 *     session and cannot run unattended here).
 *
 * It loads .env itself (only filling UNSET vars) so it never crashes when .env
 * is absent — the previous `node --env-file=.env` form hard-failed with
 * "ENOENT: .env not found" before any check could run.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Load .env into process.env (real shell env always wins; only fill unset). */
function loadDotenvIfPresent(): boolean {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return false;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && val && !process.env[key]) process.env[key] = val;
  }
  return true;
}

async function main(): Promise<void> {
  const hadDotenv = loadDotenvIfPresent();

  // No live Telegram transport configured → nothing real to smoke. Skip cleanly.
  if (!process.env["TELEGRAM_BOT_TOKEN"]) {
    console.log("[smoke] SKIP — TELEGRAM_BOT_TOKEN not set; no live environment to validate.");
    console.log(`[smoke] (.env ${hadDotenv ? "loaded" : "not found"}). This is a clean skip, not a failure.`);
    process.exit(0);
  }

  // Importing the validator transitively pulls config.ts, whose Zod parse throws
  // on a missing required var (DATABASE_URL / TELEGRAM_*). That IS a fatal boot
  // error — surface it as a clean smoke FAIL rather than a raw stack trace.
  let validateBootConfig: (env: Record<string, string | undefined>) => { errors: string[]; warnings: string[] };
  try {
    ({ validateBootConfig } = await import("../src/infra/boot-validate.js"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[smoke] ❌ ${msg}`);
    console.error("\n[smoke] FAIL — required environment is invalid (config validation).");
    process.exit(1);
  }

  const { errors, warnings } = validateBootConfig(process.env);

  for (const w of warnings) console.warn(`[smoke] ⚠️  ${w}`);

  if (errors.length > 0) {
    for (const e of errors) console.error(`[smoke] ❌ ${e}`);
    console.error(`\n[smoke] FAIL — ${errors.length} fatal config error(s). The bot would be half-dead in production.`);
    process.exit(1);
  }

  console.log(`[smoke] ✅ Offline boot validation PASSED (${warnings.length} warning(s)).`);
  console.log("[smoke] Live Telegram round-trip (send → reply → HITL approve/reject → action_log) is NOT");
  console.log("[smoke] run here — it needs an MTProto session. Run the real-path harness:");
  console.log("[smoke]   node --env-file=.env --import tsx/esm scripts/e2e-telegram-qa.ts run group1 --approve");
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
