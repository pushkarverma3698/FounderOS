/**
 * E2E smoke harness (Phase 6 — scaffold).
 *
 * Drives the LIVE Telegram bot over the real gateway and asserts on real bot
 * replies + real `action_log` rows. Requires live keys + Postgres; skips
 * cleanly (exit 0) when they are absent so CI can call it unconditionally.
 *
 * Planned checks (each a pass/fail line with evidence):
 *   1. read task            — research → real search result
 *   2. write task + HITL    — comms send → approval card → approve → audit row
 *   3. crash recovery       — interrupt → kill → restart → approve → completes
 *   4. image translation    — Dutch image → English text reply
 *   5. voice command        — Dutch voice → transcribe → translate → execute
 *
 * Until the checks are wired, this is an honest stub: it reports NOT-IMPLEMENTED
 * rather than a false green. See docs/TESTING_AUDIT.md / TESTING_PIPELINE_REPORT.md.
 */

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "DATABASE_URL"] as const;

function main(): void {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(`[smoke] SKIP — missing required env: ${missing.join(", ")}`);
    console.log("[smoke] Smoke tests need live keys + Postgres; skipping cleanly.");
    process.exit(0);
  }

  console.log("[smoke] NOT-IMPLEMENTED — checks are scaffolded but not yet wired.");
  console.log("[smoke] This is an honest stub (no false green). See Phase 6.");
  // Intentionally exit non-zero so `test:all` cannot claim smoke passed until
  // the checks are implemented. Flip to real assertions in Phase 6.
  process.exit(1);
}

main();
