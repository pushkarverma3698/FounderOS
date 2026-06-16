/**
 * FounderOS — Wiring Verification CLI (compile/CI-time gate)
 * =========================================================
 * Fails the build (non-zero exit) when the tool registry is half-wired — a tool
 * in a department array without a valid name/invoke, a dead HITL gate, or a tool
 * missing from the supervisor capability manifest. Run in CI before tests so the
 * error surfaces as a RED BUILD, not a silent production failure.
 *
 *   pnpm verify:wiring
 *
 * Offline & keyless: importing the registry pulls config.ts (Zod env validation),
 * so we inject the SAME safe stubs the test harness uses (tests/setup.ts) for any
 * unset var. Real values in the environment always win.
 */

// ── Stub the minimal env so config.ts validates without secrets (CI-safe) ─────
process.env["NODE_ENV"] ||= "test";
process.env["DATABASE_URL"] ||= "postgresql://test:test@localhost:5432/founderos_test";
process.env["TELEGRAM_BOT_TOKEN"] ||= "1234567890:verify_wiring_stub_token";
process.env["TELEGRAM_CHAT_ID"] ||= "-1001234567890";
process.env["LOG_LEVEL"] ||= "error";

async function main(): Promise<void> {
  const { checkWiring } = await import("../src/infra/wiring-check.js");
  const { errors, warnings } = checkWiring();

  for (const w of warnings) console.warn(`⚠️  ${w}`);
  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} wiring warning(s) — non-fatal (prompt-mention gaps; close via eval-gated prompt edits).\n`);
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`❌ ${e}`);
    console.error(`\nWiring check FAILED: ${errors.length} structural error(s).`);
    process.exit(1);
  }

  console.log(`✅ Wiring check passed — registry is fully wired (${warnings.length} warning(s)).`);
}

main().catch((err) => {
  console.error("Wiring check crashed:", err);
  process.exit(1);
});
